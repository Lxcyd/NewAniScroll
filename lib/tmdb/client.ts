/**
 * TMDB client — artwork only (backdrops, logos, episode stills).
 *
 * TMDB was removed from this repo on 2026-08-03 as a stills provider, and the
 * reason still stands: mapping an AniList entry onto a TMDB *season* is
 * guesswork, and the old code refused constantly rather than guess (One Piece
 * has no `tmdb_season` at all). Nothing here re-litigates that. Simkl remains
 * the primary stills source; TMDB comes back for what it is genuinely better
 * at and Simkl never provided — **series-level artwork**:
 *
 *   - backdrops: real 1280×720+ key art, versus AniList's `bannerImage`, a
 *     1900×400 letterbox crop that a full-bleed hero has to stretch.
 *   - logos: transparent PNG title art for titles fanart.tv doesn't cover.
 *
 * Neither needs a season, so neither inherits the failure mode that got TMDB
 * dropped. Episode stills DO need one, so they stay a strict *complement* to
 * Simkl (see lib/tmdb/episodeStills.ts): TMDB may only fill episodes Simkl
 * left empty, never replace or contradict them.
 *
 * LIMITS (checked 2026-08-08). There is no monthly quota and no per-key cap:
 *   - api.themoviedb.org: soft ~50 req/s, enforced per IP, not per key.
 *   - image.tmdb.org: no request limit, but max 20 simultaneous connections
 *     per IP. Images are hotlinked by the browser, so that's the visitor's IP,
 *     not ours.
 * The real cost of this integration is therefore NOT TMDB's — it's ours:
 * a serverless fetch on a hot SSR path. Everything below is cached in Turso
 * (lib/db/tmdbImagesCache.ts) precisely so the homepage never pays it twice.
 *
 * TERMS: attribution is contractual. "This product uses the TMDB API but is
 * not endorsed or certified by TMDB." — rendered on /en/sources.
 *
 * Fail-soft like every other provider here: nothing throws, everything
 * degrades to null and the caller falls back to what it used before.
 */

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

const TIMEOUT_MS = 5000;

export function tmdbEnabled(): boolean {
  return !!process.env.TMDB_API_KEY;
}

/** One TMDB image record. Field names are TMDB's own. */
export interface TmdbImage {
  file_path: string;
  width: number;
  height: number;
  aspect_ratio: number;
  /** null means TEXTLESS — that is the field the backdrop picker keys on. */
  iso_639_1: string | null;
  vote_average: number;
  vote_count: number;
}

export interface TmdbImages {
  backdrops: TmdbImage[];
  logos: TmdbImage[];
  posters: TmdbImage[];
}

export interface TmdbSeasonEpisode {
  episode_number: number;
  still_path: string | null;
  name: string | null;
}

/* Display sizes. `original` is deliberately never used: a hero backdrop at
   original is routinely 3840 px / 1.5 MB, and next.config.js sets
   `images.unoptimized: true` — whatever URL we hand <Image> is exactly what the
   browser downloads. Same reasoning as lib/images/cover.ts. */
export type BackdropSize = "w780" | "w1280";
export type LogoSize = "w300" | "w500";
export type StillSize = "w300" | "w500";

/** Build a displayable URL from TMDB's bare `file_path` ("/abc.jpg"). */
export function tmdbImageUrl(
  path: string | null | undefined,
  size: BackdropSize | LogoSize | StillSize,
): string | null {
  if (!path) return null;
  return `${TMDB_IMAGE_BASE}/${size}${path}`;
}

let warnedNoKey = false;
function warnNoKeyOnce(): void {
  if (warnedNoKey) return;
  warnedNoKey = true;
  // warn, not info: Vercel's `vercel logs --json` drops console.info.
  console.warn("[tmdb] TMDB_API_KEY unset — TMDB artwork disabled");
}

async function tmdbGet<T>(path: string, params: Record<string, string> = {}): Promise<T | null> {
  const key = process.env.TMDB_API_KEY;
  if (!key) {
    warnNoKeyOnce();
    return null;
  }

  const qs = new URLSearchParams({ api_key: key, ...params });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${TMDB_BASE}${path}?${qs}`, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      // 404 is a legitimate answer ("we don't have this id"), not an incident.
      if (res.status !== 404) {
        console.warn(`[tmdb] ${path} → HTTP ${res.status}`);
      }
      return null;
    }
    return (await res.json()) as T;
  } catch (e: any) {
    console.warn(`[tmdb] ${path} failed: ${e?.message ?? e}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* `include_image_language=en,null` is what makes both pickers work off a
   single request: `null` yields the textless art the backdrop picker requires
   (`iso_639_1 === null`), `en` yields the English title art the logo picker
   requires. Omitting it returns only the series' original language — for anime
   that is Japanese, and both pickers would come back empty. */
const IMAGE_LANGS = { include_image_language: "en,null", language: "en" };

export async function getTvImages(tvId: number): Promise<TmdbImages | null> {
  return await tmdbGet<TmdbImages>(`/tv/${tvId}/images`, IMAGE_LANGS);
}

export async function getMovieImages(movieId: number): Promise<TmdbImages | null> {
  return await tmdbGet<TmdbImages>(`/movie/${movieId}/images`, IMAGE_LANGS);
}

/** Episodes of one season, for their `still_path`. Null on any failure. */
export async function getSeasonEpisodes(
  tvId: number,
  season: number,
): Promise<TmdbSeasonEpisode[] | null> {
  const data = await tmdbGet<{ episodes?: TmdbSeasonEpisode[] }>(
    `/tv/${tvId}/season/${season}`,
    { language: "en" },
  );
  if (!data || !Array.isArray(data.episodes)) return null;
  return data.episodes;
}
