import { redis } from "@/lib/redis";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { isAnilistLikelyUp } from "./health";

/**
 * Central choke point for every server-side AniList GraphQL request.
 *
 * AniList enforces ~30 requests/minute per IP. We have many SSR pages
 * (anime info, watch, schedule, home), cron jobs (refresh-cache,
 * refresh-fanarts), and helpers (getMediaMeta, health probe, season
 * walker) that all hit the same endpoint. Without a global limiter,
 * a few concurrent SSRs can blow the budget and trigger 429s — which
 * cascade into stale data, broken pages, and outage banners.
 *
 * Strategy:
 *  1. **Shared Redis limiter** — 28 req/min across the whole fleet,
 *     leaving 2 req/min of headroom for callers that bypass this
 *     module (client-side mutations from useAnilist) and for AniList's
 *     own jitter on the limit. When out of points we queue up to a
 *     short wait — most calls are SSR, the user is waiting on it.
 *  2. **In-flight dedup** — concurrent requests with the same body
 *     share a single promise. SSR storms (many visitors hitting the
 *     same info page at once) collapse into one upstream call.
 *  3. **Response cache (Redis, short TTL)** — identical query+vars
 *     return the cached body for 60s. Catches repeated reads from the
 *     season walker, dashboard widgets, etc., that don't have their
 *     own cache layer.
 *  4. **AbortController + timeout** — never hang SSR on AniList.
 *  5. **Failure is a result too** — a refusal (403/5xx) is written to the same
 *     response cache as a success, with a 60s TTL, and the health signal
 *     short-circuits before the network. Without these, an outage made every
 *     layer above pure overhead: a Redis GET that could never hit, a token
 *     spent on a call that never landed, and a fresh upstream attempt per
 *     visitor. See `writeFailureCache` and `refund`.
 *
 * Client-side fetches (useAnilist hook) intentionally don't go through
 * here — they carry user-specific Authorization headers and the rate
 * limit is enforced per IP by AniList anyway. The dedup/cache above
 * are server-only optimisations.
 */

const ANILIST_URL = "https://graphql.anilist.co";

const POINTS_PER_MINUTE = 28;
const WINDOW_S = 60;
const QUEUE_WAIT_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 5_000;
// Default response-cache lifetime. AniList metadata (titles, relations, scores,
// trending/popular) shifts slowly, so 30 min is plenty — and the old 60 s meant
// a popular query was re-written to Redis every minute, a major write-quota
// sink. Callers that need fresher data pass their own cacheSeconds (search=30s,
// admin refresh / health=0).
const RESPONSE_CACHE_TTL_S = 30 * 60;

// IN-PROCESS ONLY. This used to be a RateLimiterRedis(storeClient: redis), but
// `redis` is now the Upstash REST shim (native port 6379 is blocked). Two
// problems with that: (1) rate-limiter-flexible issues Lua/EVALSHA the REST
// client can't run, and (2) every consume() became a ~300-800ms HTTPS round-trip
// to Upstash-London. The acquire() retry loop (5s budget) ran out of attempts
// and returned false → anilistFetch returned null → getMediaMeta(id) came back
// empty → detectSeasonNumber/pickAnimeSamaSeason resolved the WRONG season
// (the "SnK S1 plays S2, non-deterministically after reload" bug). A memory
// limiter is instantaneous and never starves the token, so metadata always
// arrives and season resolution is deterministic. AniList enforces its real
// limit per-IP regardless, so we don't need a fleet-shared bucket for
// correctness — only for politeness, which the per-lambda budget preserves.
const limiter: RateLimiterMemory = new RateLimiterMemory({
  points: POINTS_PER_MINUTE,
  duration: WINDOW_S,
});

// A purely in-process limiter, always available. Used by `skipCache` callers
// (the player audit) so they throttle WITHOUT spending a Redis EVALSHA per call
// — the audit fan-out was burning the Upstash free request quota. Same budget
// so it can't out-pace AniList's real limit.
const memLimiter = new RateLimiterMemory({
  points: POINTS_PER_MINUTE,
  duration: WINDOW_S,
});

type FetchOpts = {
  query: string;
  variables?: Record<string, unknown>;
  /** Per-user token. When set we skip cache+dedup (user-specific). */
  authToken?: string | null;
  /** Override the per-request timeout. */
  timeoutMs?: number;
  /** Cache this response for N seconds (default 60). 0 = no cache. */
  cacheSeconds?: number;
  /** Short label used in logs to identify the caller. */
  label?: string;
  /** Skip ALL Redis touches for this call: no response-cache read/write and an
   *  in-process limiter instead of the Redis one. Used by the player audit so
   *  its big fan-out doesn't spend Redis requests (Upstash free quota). The call
   *  still hits AniList live and still throttles. */
  skipCache?: boolean;
};

type Json = any;

const inflight = new Map<string, Promise<Json | null>>();

function hashKey(body: string): string {
  // FNV-1a — small, dependency-free, good enough for cache keys.
  let h = 2166136261;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(36);
}

/* Marker stored IN PLACE of a response when AniList refused the call. See
   `writeFailureCache` for why it exists. Shaped as an object with a reserved
   key so it can never collide with a real GraphQL body (which always has
   `data` and/or `errors` at the top level, never this). */
const FAILURE_MARK = "__anilistUnavailable";
type FailureMark = { [FAILURE_MARK]: true; status: number; at: number };

function isFailureMark(v: any): v is FailureMark {
  return !!v && typeof v === "object" && v[FAILURE_MARK] === true;
}

/** Reads the response cache. Returns the body on a hit, the string "failed"
 *  when the hit is a stored failure, and null on a genuine miss — the three
 *  cases the caller has to tell apart. */
async function readResponseCache(key: string): Promise<Json | "failed" | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isFailureMark(parsed) ? "failed" : parsed;
  } catch {
    return null;
  }
}

async function writeResponseCache(key: string, ttl: number, value: Json): Promise<void> {
  if (!redis || ttl <= 0) return;
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttl);
  } catch {
    /* non-fatal */
  }
}

/* How long a recorded failure suppresses the next attempt. Deliberately SHORT:
   long enough that a multi-day outage costs one upstream call per minute per
   distinct query instead of one per visitor, short enough that a recovery is
   visible within a minute.

   Why this exists at all. Until now `!res.ok` returned null WITHOUT writing
   anything, so the `redis.get` above was spent on a miss that would miss again
   on the very next request — for every AniList query, on every page, for as
   long as the outage lasted. During the 02/09/2026 outage (a hard 403, answered
   in ~110 ms, so nothing throttled the retry rate) that turned the response
   cache into a pure tax: ~150k Upstash commands a day with a 0% hit rate, and
   the quota died mid-month. Recording the failure turns that same GET into a
   HIT, which is the difference between a cache and a toll booth. */
const FAILURE_CACHE_TTL_S = 60;

async function writeFailureCache(key: string, status: number): Promise<void> {
  const mark: FailureMark = { [FAILURE_MARK]: true, status, at: Date.now() };
  await writeResponseCache(key, FAILURE_CACHE_TTL_S, mark);
}

/* Wait for the limiter to grant a point, with a hard wait cap so we don't
   block SSR for 30s when the budget is exhausted. Returns true if we got
   a point, false if we should fail-fast. */
async function acquire(label: string, useMemory = false): Promise<boolean> {
  const lim = useMemory ? memLimiter : limiter;
  const start = Date.now();
  while (Date.now() - start < QUEUE_WAIT_MS) {
    try {
      await lim.consume("global", 1);
      return true;
    } catch (rej: any) {
      // RateLimiterRes when blocked — wait the suggested ms, capped.
      const wait = Math.min(rej?.msBeforeNext ?? 500, 1000);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  console.warn(`[anilist-fetch] gave up waiting for token (${label})`);
  return false;
}

/* Give the point back when the call never reached a healthy AniList.
   The budget exists to stay under AniList's ~30 req/min, and a request they
   refused in 110 ms consumed none of that. Without this refund an outage
   emptied the bucket in 28 calls, after which EVERY subsequent call sat out the
   full QUEUE_WAIT_MS (5 s) in `acquire` before returning null — 5 s of billed
   Vercel active time, per call, buying nothing. A 429 is the one failure that
   must NOT be refunded: there, the request really did land. */
function refund(useMemory: boolean): void {
  const lim = useMemory ? memLimiter : limiter;
  lim.reward("global", 1).catch(() => {
    /* non-fatal — the bucket refills on its own within the minute */
  });
}

export async function anilistFetch(opts: FetchOpts): Promise<Json | null> {
  const {
    query,
    variables,
    authToken = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cacheSeconds = RESPONSE_CACHE_TTL_S,
    label = "anilist",
    skipCache = false,
  } = opts;

  const body = JSON.stringify({ query, variables });
  const dedupKey = `${authToken ? `u:${authToken.slice(0, 12)}|` : ""}${hashKey(body)}`;
  // skipCache (audit) → no Redis response cache at all.
  const cacheKey = authToken || skipCache ? null : `anilist:resp:v1:${hashKey(body)}`;

  // 1. Response cache (skipped for authenticated user-specific calls + audit).
  //    A stored failure answers null here, WITHOUT touching the network.
  if (cacheKey && cacheSeconds > 0) {
    const cached = await readResponseCache(cacheKey);
    if (cached === "failed") return null;
    if (cached) return cached;
  }

  // 1b. Known-down short-circuit. The health probe already writes {up:false}
  //     to `anilist:health` every minute, and that signal is memoised 30 s per
  //     process — so this is free almost always, and it covers the queries that
  //     have no failure mark of their own yet (a first visit to any page during
  //     an outage). The probe itself must be exempt or it can never observe a
  //     recovery: it would be short-circuited by its own verdict.
  if (label !== "health" && !skipCache && !authToken) {
    if (!(await isAnilistLikelyUp())) return null;
  }

  // 2. In-flight dedup
  const existing = inflight.get(dedupKey);
  if (existing) return existing;

  const promise = (async (): Promise<Json | null> => {
    // Audit calls throttle in-process (memory limiter) so they don't each spend
    // a Redis EVALSHA on the shared limiter.
    const ok = await acquire(label, skipCache);
    if (!ok) return null;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(ANILIST_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body,
        signal: ctrl.signal,
      });

      // Honour AniList's own rate-limit feedback when available so a 429
      // doesn't keep us hammering for a full minute. Bleeding the bucket
      // ensures the next acquire() waits the right amount.
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 60;
        try {
          await (skipCache ? memLimiter : limiter).block("global", retryAfter);
        } catch {
          /* non-fatal */
        }
        console.warn(`[anilist-fetch] 429 from upstream (${label}), pausing ${retryAfter}s`);
        return null;
      }

      if (!res.ok) {
        // Refused, not throttled. Record it so the next caller pays a cache
        // HIT instead of another round-trip, and give the token back.
        refund(skipCache);
        if (cacheKey) await writeFailureCache(cacheKey, res.status);
        console.warn(`[anilist-fetch] HTTP ${res.status} (${label})`);
        return null;
      }
      const json = await res.json();
      if (cacheKey && cacheSeconds > 0) await writeResponseCache(cacheKey, cacheSeconds, json);
      return json;
    } catch (e: any) {
      refund(skipCache);
      if (e?.name === "AbortError") {
        console.warn(`[anilist-fetch] timeout (${label})`);
      } else {
        console.warn(`[anilist-fetch] error (${label}):`, e?.message);
      }
      // A timeout / socket error is NOT recorded: unlike a 403 it says nothing
      // about AniList's availability (it can be our own egress, or one slow
      // query), and pinning it for a minute would suppress calls that would
      // have worked.
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();

  inflight.set(dedupKey, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(dedupKey);
  }
}
