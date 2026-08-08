/**
 * Client-side cache for the hover preview payloads (/api/v2/preview/[id]).
 *
 * A mouse sweeping a carousel re-enters the same cards over and over, so the
 * only thing standing between "nice hover effect" and "a request per pixel" is
 * this map. It lives at module scope, so it survives SPA navigation and is
 * shared by every card on the page; misses are deduped through `inFlight` so
 * two anchors for the same id can't race.
 *
 * `null` is cached too — an id AniList doesn't know about must not be retried
 * on every hover.
 */

export type PreviewTitle = {
  romaji?: string | null;
  english?: string | null;
  native?: string | null;
  userPreferred?: string | null;
};

export type PreviewData = {
  id: number;
  title: PreviewTitle | null;
  coverImage: { large: string | null; color: string | null } | null;
  bannerImage: string | null;
  description: string | null;
  format: string | null;
  status: string | null;
  episodes: number | null;
  duration: number | null;
  season: string | null;
  seasonYear: number | null;
  averageScore: number | null;
  nextAiringEpisode: { episode: number | null; timeUntilAiring: number | null } | null;
  trailer: { id: string } | null;
};

const cache = new Map<number, PreviewData | null>();
const inFlight = new Map<number, Promise<PreviewData | null>>();

/** Synchronous read — what the card can paint on its very first render. */
export function peekPreview(id: number): PreviewData | null | undefined {
  return cache.get(id);
}

export function fetchPreview(id: number): Promise<PreviewData | null> {
  if (cache.has(id)) return Promise.resolve(cache.get(id) ?? null);
  const pending = inFlight.get(id);
  if (pending) return pending;

  const p = (async () => {
    try {
      const res = await fetch(`/api/v2/preview/${id}`);
      if (!res.ok) {
        // 404 is a real answer (cache it); a 5xx is not — leave the slot empty
        // so the next hover retries instead of showing an empty card forever.
        if (res.status === 404) cache.set(id, null);
        return null;
      }
      const json = (await res.json()) as PreviewData;
      cache.set(id, json);
      return json;
    } catch {
      return null;
    } finally {
      inFlight.delete(id);
    }
  })();

  inFlight.set(id, p);
  return p;
}
