/**
 * Shared client-side cache for the full AniList Media payload (`info`).
 *
 * The anime info page already has the complete `info` object. When the user
 * navigates to the watch page via SPA `router.push`, the React tree stays
 * mounted and this cache survives — so the watch page can render its player
 * immediately from the cached `info` instead of waiting on a blocking SSR
 * re-fetch of the same data.
 *
 * For a cold/direct hit (someone opens a /watch link directly), the cache is
 * empty and the page falls back to `GET /api/v2/media/[id]` (served from the
 * warm server-side cache).
 *
 * Keyed by aniId. We DON'T cache `mediaListEntry` here (it's per-user and the
 * info page may not have it) — the watch page reconciles list state separately.
 */

type CacheEntry = { data: any; at: number };

const TTL_MS = 10 * 60 * 1000; // metadata changes slowly; 10 min is plenty.
const store = new Map<string, CacheEntry>();

export function setPrefetchedInfo(aniId: number | string, info: any) {
  if (!aniId || !info) return;
  store.set(String(aniId), { data: info, at: Date.now() });
}

/** Read a fresh prefetched Media payload, or null if absent/expired. */
export function getPrefetchedInfo(aniId: number | string): any | null {
  const e = store.get(String(aniId));
  if (!e) return null;
  if (Date.now() - e.at > TTL_MS) {
    store.delete(String(aniId));
    return null;
  }
  return e.data;
}
