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
  /** The info page's meta row, mirrored onto the card. */
  favourites: number | null;
  genres: string[];
  studios: string[];
  ratingRank: number | null;
  nextAiringEpisode: { episode: number | null; timeUntilAiring: number | null } | null;
  trailer: { id: string } | null;
};

const cache = new Map<number, PreviewData | null>();
const inFlight = new Map<number, Promise<PreviewData | null>>();
/** URLs already handed to the browser — a second Image() would be wasted work. */
const warmed = new Set<string>();

/**
 * Pull the banner into the HTTP cache the moment its URL is known, which is
 * still before the card has finished opening.
 *
 * Without this the card renders, THEN starts downloading its banner, and for a
 * few hundred milliseconds it has nothing wide to show — the visible symptom
 * being a card that pops up bare and fills in late. The payload request is
 * already started 30 ms ahead of the card by the provider; this extends the same
 * head start to the image, which is by far the heavier of the two.
 *
 * `decode()` matters as much as the download: an image that is fetched but not
 * yet decoded still paints on a later frame.
 */
export function warmImage(url: string | null | undefined): void {
  if (!url || typeof window === "undefined" || warmed.has(url)) return;
  warmed.add(url);
  const img = new Image();
  img.src = url;
  // Older Safari has no decode(); the plain fetch above is still the win.
  void img.decode?.().catch(() => {});
}

/**
 * The first trailer id this page has heard of, announced once.
 *
 * TrailerStage needs a video id to be born with, and it does not care WHICH —
 * it only needs the player booted before somebody hovers, since that boot is
 * ~450 ms it would otherwise pay on the first card. Any real trailer will do,
 * so the cheapest one is whichever payload lands first.
 */
let firstTrailer: string | null = null;
const trailerWaiters = new Set<(id: string) => void>();

export function onFirstTrailer(cb: (id: string) => void): () => void {
  if (firstTrailer) {
    cb(firstTrailer);
    return () => {};
  }
  trailerWaiters.add(cb);
  return () => {
    trailerWaiters.delete(cb);
  };
}

function announceTrailer(id: string | undefined) {
  if (!id || firstTrailer) return;
  firstTrailer = id;
  for (const w of trailerWaiters) w(id);
  trailerWaiters.clear();
}

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
      // `v` is the PAYLOAD's shape, not a cache-buster to keep bumping. The
      // response is edge-cached for a day, so a payload that gains fields
      // serves the old shape to every warm id until that day is up — the card
      // renders a build's worth of missing numbers and looks broken. Bump when
      // fields are added; v2 = favourites, genres, studios, ratingRank.
      const res = await fetch(`/api/v2/preview/${id}?v=2`);
      if (!res.ok) {
        // 404 is a real answer (cache it); a 5xx is not — leave the slot empty
        // so the next hover retries instead of showing an empty card forever.
        if (res.status === 404) cache.set(id, null);
        return null;
      }
      const json = (await res.json()) as PreviewData;
      cache.set(id, json);
      warmImage(json.bannerImage ?? json.coverImage?.large);
      announceTrailer(json.trailer?.id);
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
