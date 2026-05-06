/**
 * Three-layer Media metadata cache:
 *
 *   1. Memory (process-wide Map, 24h TTL) — instant, cleared on restart.
 *   2. Turso DB — persistent, status-aware TTL, survives restarts/outages.
 *   3. AniList live — source of truth, with 4s timeout.
 *
 * Read path:
 *   memory hit                                → return immediately
 *   DB hit & fresh                            → warm memory, return
 *   DB hit & stale                            → warm memory + return
 *                                                + kick off background refresh
 *   miss                                      → fetch AniList → write DB +
 *                                                memory → return
 *   miss + AniList down + DB has stale        → return stale (best effort)
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

const MEM_TTL_MS = 24 * 60 * 60 * 1000;
const ANILIST_TIMEOUT_MS = 4000;

const memCache = new Map();        // id → { t, value }
const inFlight = new Map();        // id → Promise — dedupe concurrent fetches

// Tracks ids we've already kicked a background refresh for in this process
// run, so a row that's stale doesn't trigger one refresh per page render.
const refreshInFlight = new Set();

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

async function fetchFromAniList(aniId, signal) {
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: FULL_MEDIA_QUERY,
      variables: { id: Number(aniId) },
    }),
    signal,
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.data?.Media ?? null;
}

async function refreshFromAniList(aniId) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ANILIST_TIMEOUT_MS);
  try {
    const media = await fetchFromAniList(aniId, ctrl.signal);
    if (media) {
      memSet(aniId, media);
      await upsertAnime(media).catch(() => {});
    }
    return media;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function scheduleBackgroundRefresh(aniId) {
  const k = String(aniId);
  if (refreshInFlight.has(k)) return;
  refreshInFlight.add(k);
  // Fire-and-forget. Errors are swallowed; the stale data already shipped.
  refreshFromAniList(aniId)
    .catch(() => {})
    .finally(() => refreshInFlight.delete(k));
}

export async function getMediaMeta(aniId) {
  if (!aniId) return null;
  const k = String(aniId);

  // 1. Memory
  const mem = memGet(aniId);
  if (mem) return mem;

  // Dedupe concurrent fetches for the same id (probe storms hit this hard)
  if (inFlight.has(k)) return inFlight.get(k);

  const promise = (async () => {
    // 2. DB
    let cached = null;
    try {
      cached = await getCachedAnime(Number(aniId));
    } catch (e) {
      console.warn("[getMediaMeta] DB read failed:", e?.message);
    }

    if (cached?.data) {
      memSet(aniId, cached.data);
      if (cached.isStale) scheduleBackgroundRefresh(aniId);
      return cached.data;
    }

    // 3. Live
    const fresh = await refreshFromAniList(aniId);
    if (fresh) return fresh;

    // 4. Last-resort: stale row exists but earlier read failed — try again
    //    without the access bump. We return whatever we have, no matter how old.
    if (cached?.data) return cached.data;
    return null;
  })();

  inFlight.set(k, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(k);
  }
}
