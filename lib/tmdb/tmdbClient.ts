/**
 * TMDB client — episode stills only.
 *
 * AniList exposes real per-episode thumbnails (`streamingEpisodes`) only for
 * Crunchyroll/Funimation-licensed titles. TMDB carries a `still_path` per
 * episode for most TV series, which is the one source we have for an image OF
 * the episode rather than of the show.
 *
 * SCOPE, deliberately narrow: stills, nothing else. We do NOT take TMDB's
 * episode titles, descriptions or season numbering as truth — lib/fribb/
 * fribbMap.ts and lib/anilist/resolveSeason.ts both document TMDB mislabelling
 * and fusing anime seasons, and lib/jikan/episodeScores.ts documents choosing
 * Jikan over TMDB for exactly that reason. Deciding WHICH TMDB season an
 * AniList id maps to (and refusing when unsure) lives in resolveTmdbSeason.ts;
 * this module only speaks HTTP.
 *
 * Keyless-safe: with no TMDB_API_KEY every call returns null and callers fall
 * back to the deterministic pool in lib/images/episodeImagePool.ts. The key is
 * optional by design — the site must work without it.
 */

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/";

const USER_AGENT = "AniScroll/1.0 (+https://aniscroll.com)";

export interface TmdbSeasonSummary {
  seasonNumber: number;
  episodeCount: number;
  name: string | null;
  airDate: string | null;
}

export interface TmdbShow {
  id: number;
  name: string | null;
  seasons: TmdbSeasonSummary[];
  numberOfEpisodes: number | null;
}

export interface TmdbStill {
  /** TMDB's own `episode_number` — never a array index (see getTmdbSeasonEpisodes). */
  number: number;
  /** Raw `still_path` ("/abc.jpg"), not a full URL. Null when TMDB has no image. */
  still: string | null;
  name: string | null;
  airDate: string | null;
}

/** Result shape mirrors lib/jikan/episodeScores.ts: `transient` separates a
 *  network blip / rate-limit from a genuine 404, so callers don't cache a miss
 *  that was really an outage. */
interface TmdbResult<T> {
  ok: boolean;
  data: T | null;
  transient: boolean;
}

export function tmdbEnabled(): boolean {
  return !!process.env.TMDB_API_KEY;
}

let warnedNoKey = false;
function warnNoKeyOnce(): void {
  if (warnedNoKey) return;
  warnedNoKey = true;
  // Not an error: episode rows fall back to the fanart pool. Mirrors the
  // one-shot notice in lib/db/turso.ts when Turso is unconfigured.
  console.warn("[tmdb] TMDB_API_KEY unset — episode stills disabled.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * One TMDB GET with a single retry on 429. Never throws, never logs the key.
 * 8s timeout per attempt, matching jikanFetch.
 */
async function tmdbFetch<T>(path: string): Promise<TmdbResult<T>> {
  const key = process.env.TMDB_API_KEY;
  if (!key) {
    warnNoKeyOnce();
    return { ok: false, data: null, transient: false };
  }

  const sep = path.includes("?") ? "&" : "?";
  const url = `${TMDB_BASE}${path}${sep}api_key=${encodeURIComponent(key)}&language=en-US`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
      clearTimeout(timer);

      if (res.status === 429) {
        if (attempt === 0) {
          await sleep(1200);
          continue;
        }
        return { ok: false, data: null, transient: true };
      }
      // 404 is a real answer ("no such show/season"), so it's cacheable.
      if (res.status === 404) return { ok: false, data: null, transient: false };
      if (!res.ok) return { ok: false, data: null, transient: res.status >= 500 };

      return { ok: true, data: (await res.json()) as T, transient: false };
    } catch {
      clearTimeout(timer);
      // Abort/network — transient, so the caller won't cache it as "no stills".
      return { ok: false, data: null, transient: true };
    }
  }
  return { ok: false, data: null, transient: true };
}

/**
 * Show metadata. We need this ONLY for the per-season `episode_count`, which is
 * what resolveTmdbSeason validates the AniList episode count against before it
 * will trust any still.
 */
export async function getTmdbShow(tvId: number): Promise<TmdbShow | null> {
  const r = await tmdbFetch<any>(`/tv/${tvId}`);
  if (!r.ok || !r.data) return null;
  const seasons: TmdbSeasonSummary[] = Array.isArray(r.data.seasons)
    ? r.data.seasons.map((s: any) => ({
        seasonNumber: Number(s?.season_number),
        episodeCount: Number(s?.episode_count ?? 0),
        name: s?.name ?? null,
        airDate: s?.air_date ?? null,
      }))
    : [];
  return {
    id: Number(r.data.id),
    name: r.data.name ?? null,
    seasons,
    numberOfEpisodes:
      typeof r.data.number_of_episodes === "number" ? r.data.number_of_episodes : null,
  };
}

/**
 * Episodes of one season, each with its still path.
 *
 * Keyed by TMDB's `episode_number`, NOT array position: TMDB can return a
 * season with gaps or specials interleaved, and trusting the index is the
 * classic off-by-one that shifts every image by one episode.
 */
export async function getTmdbSeasonEpisodes(
  tvId: number,
  season: number,
): Promise<TmdbStill[] | null> {
  const r = await tmdbFetch<any>(`/tv/${tvId}/season/${season}`);
  if (!r.ok || !r.data || !Array.isArray(r.data.episodes)) return null;
  return r.data.episodes
    .map((e: any) => ({
      number: Number(e?.episode_number),
      still: typeof e?.still_path === "string" ? e.still_path : null,
      name: e?.name ?? null,
      airDate: e?.air_date ?? null,
    }))
    .filter((e: TmdbStill) => Number.isFinite(e.number));
}

/**
 * Full URL for a `still_path`.
 *
 * w300 by default: episode thumbs render ~160-300 CSS px wide and
 * next.config.js sets `images.unoptimized: true`, so the browser downloads
 * exactly what we hand it — `original` would ship a multi-MB frame into a
 * 160px box.
 */
export function tmdbStillUrl(
  path: string | null,
  size: "w300" | "w500" | "original" = "w300",
): string | null {
  if (!path) return null;
  return `${TMDB_IMAGE_BASE}${size}${path}`;
}
