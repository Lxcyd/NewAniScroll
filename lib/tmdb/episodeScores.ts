import { redis } from "@/lib/redis";

/**
 * Per-episode anime ratings via TMDB.
 *
 * AniList exposes a single averageScore per season — never per episode. TMDB
 * (free, non-commercial API) carries a `vote_average` on every episode, which
 * is the closest free source to the Screen-Score grid the UI mimics.
 *
 * Flow for one AniList season id:
 *   1. Resolve a TMDB TV id by searching TMDB with the romaji/english title
 *      (+ year hint). Cached per AniList id.
 *   2. Resolve which TMDB season corresponds to this AniList entry (anime get
 *      split across TMDB seasons inconsistently — we match by air year, then
 *      by episode count, then fall back to season number).
 *   3. Fetch that season's episodes and return their vote_average (0-10).
 *
 * Everything degrades gracefully: no API key, no match, or a TMDB outage all
 * return `null` and the caller falls back to the AniList season score. No throw
 * ever escapes — a broken ratings grid must never break the info page.
 */

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_KEY = process.env.TMDB_API_KEY || "";

// TTL: episode scores drift slowly. 7 days for resolved data; 1 day for a
// negative result (so a title that gains a TMDB entry later gets picked up).
const TTL_OK_S = 7 * 24 * 3600;
const TTL_MISS_S = 24 * 3600;

export type EpisodeScore = {
  /** 1-based episode number within the season. */
  number: number;
  /** TMDB vote_average on a /10 scale, or null when unrated. */
  score: number | null;
};

export type SeasonScores = {
  /** The AniList season id these scores belong to. */
  aniId: number;
  /** Per-episode scores (sparse — only episodes TMDB actually rated). */
  episodes: EpisodeScore[];
  /** Source marker so the client/UI can tell real data from a fallback. */
  source: "tmdb" | "none";
};

type ResolveInput = {
  aniId: number;
  title?: { romaji?: string | null; english?: string | null } | null;
  year?: number | null;
  episodeCount?: number | null;
};

export function tmdbEnabled(): boolean {
  return !!TMDB_KEY;
}

async function getJson<T>(key: string): Promise<T | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

async function setJson(key: string, value: unknown, ttl: number): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttl);
  } catch {
    /* non-fatal */
  }
}

async function tmdbFetch(path: string, params: Record<string, string> = {}) {
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", TMDB_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url.toString(), { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve { tvId, seasonNumber } for an AniList season. Cached per AniList id.
 * Returns null when no confident TMDB match exists.
 */
async function resolveTmdbSeason(
  input: ResolveInput,
): Promise<{ tvId: number; seasonNumber: number } | null> {
  const cacheKey = `tmdb:map:v1:${input.aniId}`;
  const cached = await getJson<{ tvId: number; seasonNumber: number } | null>(cacheKey);
  if (cached !== null) return cached;

  const queries = [input.title?.english, input.title?.romaji]
    .map((s) => (s || "").trim())
    .filter(Boolean);
  if (queries.length === 0) {
    await setJson(cacheKey, null, TTL_MISS_S);
    return null;
  }

  // 1. Find the TV show.
  let tvId: number | null = null;
  let showSeasons: any[] = [];
  for (const q of queries) {
    const search = await tmdbFetch("/search/tv", {
      query: q,
      include_adult: "false",
      ...(input.year ? { first_air_date_year: String(input.year) } : {}),
    });
    const results: any[] = search?.results || [];
    if (results.length === 0) continue;
    // Prefer an exact-ish name match; otherwise the most popular result.
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const nq = norm(q);
    const exact = results.find(
      (r) => norm(r.name || "") === nq || norm(r.original_name || "") === nq,
    );
    const chosen = exact || results[0];
    if (!chosen?.id) continue;
    const details = await tmdbFetch(`/tv/${chosen.id}`);
    if (!details) continue;
    tvId = chosen.id;
    showSeasons = (details.seasons || []).filter(
      (s: any) => s.season_number >= 1, // skip "Specials" (season 0)
    );
    break;
  }

  if (!tvId || showSeasons.length === 0) {
    await setJson(cacheKey, null, TTL_MISS_S);
    return null;
  }

  // 2. Pick the TMDB season that best matches this AniList entry.
  //    Priority: air-year match → episode-count match → fewest-difference.
  let best: { season_number: number; score: number } | null = null;
  for (const sn of showSeasons) {
    let score = 0;
    const snYear = sn.air_date ? Number(String(sn.air_date).slice(0, 4)) : null;
    if (input.year && snYear === input.year) score += 50;
    if (input.episodeCount && sn.episode_count === input.episodeCount) score += 30;
    else if (input.episodeCount && sn.episode_count) {
      score -= Math.abs(sn.episode_count - input.episodeCount); // closer is better
    }
    if (!best || score > best.score) {
      best = { season_number: sn.season_number, score };
    }
  }

  // If the show has exactly one season, always use it.
  const seasonNumber =
    showSeasons.length === 1 ? showSeasons[0].season_number : best?.season_number;

  if (seasonNumber == null) {
    await setJson(cacheKey, null, TTL_MISS_S);
    return null;
  }

  const out = { tvId, seasonNumber };
  await setJson(cacheKey, out, TTL_OK_S);
  return out;
}

/**
 * Per-episode scores for one AniList season. Never throws; returns
 * { source: "none", episodes: [] } when TMDB is unavailable / unmatched.
 */
export async function getSeasonEpisodeScores(
  input: ResolveInput,
): Promise<SeasonScores> {
  const empty: SeasonScores = { aniId: input.aniId, episodes: [], source: "none" };
  if (!TMDB_KEY) return empty;

  const cacheKey = `tmdb:eps:v1:${input.aniId}`;
  const cached = await getJson<SeasonScores>(cacheKey);
  if (cached) return cached;

  const map = await resolveTmdbSeason(input);
  if (!map) {
    await setJson(cacheKey, empty, TTL_MISS_S);
    return empty;
  }

  const season = await tmdbFetch(`/tv/${map.tvId}/season/${map.seasonNumber}`);
  const episodes: any[] = season?.episodes || [];
  if (episodes.length === 0) {
    await setJson(cacheKey, empty, TTL_MISS_S);
    return empty;
  }

  const result: SeasonScores = {
    aniId: input.aniId,
    episodes: episodes.map((e) => ({
      number: Number(e.episode_number),
      // TMDB returns 0 for "no votes" — treat that as unrated (null) so the
      // grid falls back to the season score instead of painting a fake 0.
      score:
        typeof e.vote_average === "number" && e.vote_average > 0
          ? Math.round(e.vote_average * 10) / 10
          : null,
    })),
    source: "tmdb",
  };

  await setJson(cacheKey, result, TTL_OK_S);
  return result;
}
