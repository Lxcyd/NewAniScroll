import { redis } from "@/lib/redis";
import { RateLimiterRedis, RateLimiterMemory } from "rate-limiter-flexible";

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
const RESPONSE_CACHE_TTL_S = 60;

let limiter: RateLimiterRedis | RateLimiterMemory;
if (redis) {
  limiter = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: "anilistApi",
    points: POINTS_PER_MINUTE,
    duration: WINDOW_S,
  });
} else {
  // No Redis → still throttle within this process. Better than nothing.
  limiter = new RateLimiterMemory({
    points: POINTS_PER_MINUTE,
    duration: WINDOW_S,
  });
}

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

async function readResponseCache(key: string): Promise<Json | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
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

  // 1. Response cache (skipped for authenticated user-specific calls + audit)
  if (cacheKey && cacheSeconds > 0) {
    const cached = await readResponseCache(cacheKey);
    if (cached) return cached;
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

      if (!res.ok) return null;
      const json = await res.json();
      if (cacheKey && cacheSeconds > 0) await writeResponseCache(cacheKey, cacheSeconds, json);
      return json;
    } catch (e: any) {
      if (e?.name === "AbortError") {
        console.warn(`[anilist-fetch] timeout (${label})`);
      } else {
        console.warn(`[anilist-fetch] error (${label}):`, e?.message);
      }
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
