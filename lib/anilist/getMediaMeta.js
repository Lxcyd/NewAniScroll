/**
 * Three-layer Media metadata cache:
 *
 *   1. Memory (process-wide Map, 24h TTL) — instant, cleared on restart.
 *   2. AniList live — source of truth (when health check says it's UP).
 *   3. Turso DB — persistent fallback when AniList is down or fetch fails.
 *
 * Read path (when AniList is UP — the common case):
 *   memory hit                                → return immediately
 *   miss → AniList fetch (4s timeout)         → write memory + DB (async),
 *                                                return
 *   miss + AniList fails                      → fall through to DB read
 *
 * Read path (when AniList is DOWN per health check):
 *   memory hit                                → return immediately
 *   miss → DB read                            → warm memory, return
 *   miss + DB empty                           → try AniList anyway as
 *                                                last resort (health
 *                                                check could be stale)
 *
 * Why AniList-first: each DB read on Turso counts toward the free-plan
 * row-read budget, and the walker (resolveSeasonChain / List) can do
 * 10-30 reads per page render. AniList itself is free + rate-limited,
 * so when it's healthy we'd rather hit it than burn Turso reads.
 *
 * The shape returned is always an AniList Media object (or null). The DB's
 * `data` column stores exactly that shape, so callers don't need to know
 * whether the result came from cache or live.
 *
 * Backwards-compatible helpers (`primeMediaCache`, `getCachedMediaMeta`)
 * are preserved so existing callers keep working.
 */

import { FULL_MEDIA_QUERY } from "./fullMediaQuery";
import { getCachedAnime, upsertAnime } from "../db/anime";
import { isAnilistLikelyUp } from "./health";
import { anilistFetch } from "./anilistFetch";

const MEM_TTL_MS = 24 * 60 * 60 * 1000;
const ANILIST_TIMEOUT_MS = 4000;

const memCache = new Map();        // id → { t, value }
const inFlight = new Map();        // id → Promise — dedupe concurrent fetches

function memSet(id, media) {
  memCache.set(String(id), { t: Date.now(), value: media });
}

function memGet(id) {
  const hit = memCache.get(String(id));
  if (hit && Date.now() - hit.t < MEM_TTL_MS) return hit.value;
  return null;
}

/** Public — let SSR push the Media it already has into all cache layers. */
export function primeMediaCache(aniId, media) {
  if (!aniId || !media) return;
  memSet(aniId, media);
  // Persist to DB too (non-blocking) so the next process / page benefits.
  upsertAnime(media).catch((e) =>
    console.warn("[getMediaMeta] DB prime failed:", e?.message)
  );
}

/** Public — synchronous read of the memory layer only. */
export function getCachedMediaMeta(aniId) {
  return memGet(aniId);
}

async function refreshFromAniList(aniId) {
  // Routed through the global limiter + dedup + response cache.
  // Multiple SSRs hitting the same id within 60s collapse into one
  // upstream call.
  const data = await anilistFetch({
    query: FULL_MEDIA_QUERY,
    variables: { id: Number(aniId) },
    timeoutMs: ANILIST_TIMEOUT_MS,
    label: `getMediaMeta:${aniId}`,
  });
  const media = data?.data?.Media ?? null;
  if (media) {
    memSet(aniId, media);
    // Persist async — don't block the response on DB write
    upsertAnime(media).catch(() => {});
  }
  return media;
}

async function readFromDb(aniId) {
  try {
    const cached = await getCachedAnime(Number(aniId));
    if (cached?.data) {
      memSet(aniId, cached.data);
      return cached.data;
    }
  } catch (e) {
    console.warn("[getMediaMeta] DB read failed:", e?.message);
  }
  return null;
}

export async function getMediaMeta(aniId) {
  if (!aniId) return null;
  const k = String(aniId);

  // 1. Memory (process-local, no I/O)
  const mem = memGet(aniId);
  if (mem) return mem;

  // Dedupe concurrent fetches for the same id (probe storms hit this hard)
  if (inFlight.has(k)) return inFlight.get(k);

  const promise = (async () => {
    const anilistUp = await isAnilistLikelyUp();

    if (anilistUp) {
      // 2a. AniList first — saves a Turso read on the happy path
      const fresh = await refreshFromAniList(aniId);
      if (fresh) return fresh;
      // AniList failed despite the health signal — fall back to DB
      const fromDb = await readFromDb(aniId);
      if (fromDb) return fromDb;
      return null;
    }

    // 2b. AniList known-down — go straight to DB
    const fromDb = await readFromDb(aniId);
    if (fromDb) return fromDb;
    // DB empty & AniList down — try AniList one last time anyway (health
    // signal can be stale, and a real miss + truly-down is preferable to
    // returning null silently when we have *some* chance of recovery)
    return await refreshFromAniList(aniId);
  })();

  inFlight.set(k, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(k);
  }
}
