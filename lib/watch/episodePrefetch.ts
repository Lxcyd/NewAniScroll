/**
 * Shared client-side cache for the per-anime episode list.
 *
 * The watch page can't render its player until `episodeNavigation` is built,
 * and that depends on `GET /api/v2/episode/{id}` returning. That request is the
 * real gate on "time to player" — the stream source can be warm but the player
 * still spins until the episode list arrives.
 *
 * The anime info page warms this in the background (alongside the source) so
 * that by the time the user clicks "Watch" the list is already in memory. The
 * watch page reads `getPrefetchedEpisodes(id, dub)` synchronously before
 * issuing its own fetch.
 *
 * Keyed by `${aniId}:${sub|dub}` to mirror the API's sub/dub filtering.
 */

type CacheEntry = { data: any[]; at: number };

const TTL_MS = 30 * 60 * 1000; // matches the API's 30-min edge cache.
const store = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<any[] | null>>();

function key(aniId: number | string, dub: boolean): string {
  return `${aniId}:${dub ? "dub" : "sub"}`;
}

/** Read a fresh prefetched episode list, or null if absent/expired. */
export function getPrefetchedEpisodes(
  aniId: number | string,
  dub: boolean,
): any[] | null {
  const e = store.get(key(aniId, dub));
  if (!e) return null;
  if (Date.now() - e.at > TTL_MS) {
    store.delete(key(aniId, dub));
    return null;
  }
  return e.data;
}

export function setPrefetchedEpisodes(
  aniId: number | string,
  dub: boolean,
  data: any[],
) {
  store.set(key(aniId, dub), { data, at: Date.now() });
}

/**
 * Fetch + cache the episode list. Deduplicates concurrent calls for the same
 * key (the info-page prefetch and the watch page can race). Returns the parsed
 * list, or null on failure (caller falls back to its own fetch). Hitting this
 * endpoint also primes the browser's HTTP cache, so even a cache-miss here
 * leaves the watch page's identical request served from disk.
 */
export async function prefetchEpisodeList(
  aniId: number | string,
  opts: { releasing?: boolean; dub?: boolean; priority?: "high" | "low" | "auto" } = {},
): Promise<any[] | null> {
  const dub = !!opts.dub;
  const k = key(aniId, dub);
  const cached = getPrefetchedEpisodes(aniId, dub);
  if (cached) return cached;
  const existing = inflight.get(k);
  if (existing) return existing;

  const qs = `releasing=${opts.releasing ? "true" : "false"}${dub ? "&dub=true" : ""}`;
  const p = fetch(`/api/v2/episode/${aniId}?${qs}`, {
    // @ts-ignore — `priority` is a valid fetch init in modern browsers.
    priority: opts.priority || "auto",
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      const arr = Array.isArray(data) ? data : null;
      if (arr) setPrefetchedEpisodes(aniId, dub, arr);
      return arr;
    })
    .catch(() => null)
    .finally(() => {
      inflight.delete(k);
    });

  inflight.set(k, p);
  return p;
}
