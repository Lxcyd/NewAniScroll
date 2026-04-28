/**
 * Process-wide cache for AniList Media metadata.
 *
 * All scrapers (anime-sama, voir-anime, season-detect) need the same fields
 * (title, synonyms, relations) for the same anime ID. Caching them in one place
 * means we hit AniList ONCE per anime per process, instead of N times per probe.
 *
 * The watch page SSR also primes this cache via primeMediaCache() so by the time
 * the source API runs, no AniList call is needed at all.
 */

const TTL = 24 * 60 * 60 * 1000; // 24h — title/synonyms/relations don't change
const cache = new Map();
const inFlight = new Map(); // dedupe concurrent fetches for same id

const QUERY = `query($id:Int){Media(id:$id){
  id
  title{romaji english native}
  synonyms
  seasonYear
  startDate{year}
  relations{edges{relationType node{id format title{romaji english}}}}
}}`;

export function getCachedMediaMeta(aniId) {
  const k = String(aniId);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.t < TTL) return hit.value;
  return null;
}

export function primeMediaCache(aniId, media) {
  if (!aniId || !media) return;
  cache.set(String(aniId), { t: Date.now(), value: media });
}

export async function getMediaMeta(aniId) {
  const k = String(aniId);
  const cached = getCachedMediaMeta(aniId);
  if (cached) return cached;
  if (inFlight.has(k)) return inFlight.get(k);

  const fetchPromise = (async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: QUERY, variables: { id: Number(aniId) } }),
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      const media = data?.data?.Media;
      if (media) cache.set(k, { t: Date.now(), value: media });
      return media;
    } catch {
      return null;
    } finally {
      clearTimeout(t);
      inFlight.delete(k);
    }
  })();

  inFlight.set(k, fetchPromise);
  return fetchPromise;
}
