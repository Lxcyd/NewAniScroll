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

/** A resolved TMDB target for an AniList entry.
 *   - `{ tvId, seasonNumbers: [n] }`  — one TMDB season (a sequel AniList entry
 *     that maps onto a single TMDB season, e.g. AoT S2 → TMDB season 2).
 *   - `{ tvId, seasonNumbers: [1,2,…] }` — every TMDB season, concatenated, for
 *     a single AniList entry that spans the whole TMDB show (One Piece: one
 *     AniList id, but TMDB splits it into many sagas). */
type TmdbTarget = { tvId: number; seasonNumbers: number[] };

/** Strip "Season N / Part N / Cour N / Nth Season" so a sequel AniList title
 *  still matches the parent TMDB show (TMDB has no separate "… Season 2" entry,
 *  it's one show with multiple seasons). */
function stripSeasonSuffix(t: string): string {
  return t
    .replace(/\b(season|part|cour|saison)\s*\d+\b/gi, "")
    .replace(/\b\d+(st|nd|rd|th)\s+season\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Resolve which TMDB show + season(s) an AniList entry maps to. Cached per
 * AniList id. Returns null when no confident TMDB match exists.
 */
async function resolveTmdbTarget(input: ResolveInput): Promise<TmdbTarget | null> {
  const cacheKey = `tmdb:map:v3:${input.aniId}`;
  const cached = await getJson<TmdbTarget | null>(cacheKey);
  if (cached !== null) return cached;

  const raw = [input.title?.english, input.title?.romaji]
    .map((s) => (s || "").trim())
    .filter(Boolean);
  // Try the stripped form too so "Attack on Titan Season 2" → "Attack on Titan".
  const queries = Array.from(
    new Set([...raw, ...raw.map(stripSeasonSuffix)].filter(Boolean)),
  );
  if (queries.length === 0) {
    await setJson(cacheKey, null, TTL_MISS_S);
    return null;
  }

  // 1. Find the TV show. IMPORTANT: do NOT filter the search by year — a sequel
  //    season's year (e.g. AoT S2 = 2017) would exclude the parent TMDB show,
  //    whose first_air_date is season 1's year (2013). Year is used only to pick
  //    the right season below.
  let tvId: number | null = null;
  let showSeasons: any[] = [];
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  for (const q of queries) {
    const search = await tmdbFetch("/search/tv", { query: q, include_adult: "false" });
    const results: any[] = search?.results || [];
    if (results.length === 0) continue;
    const nq = norm(q);
    // Disambiguate same-named shows (e.g. "One Piece" 1999 anime vs the 2023
    // Netflix live-action). Prefer: a name match whose first_air_date year is at
    // or before the AniList year (sequels share season 1's year, so the anime's
    // first-air year is ≤ the entry's year) AND animation-genre when known →
    // then any exact name match → then the most popular result.
    const exacts = results.filter(
      (r) => norm(r.name || "") === nq || norm(r.original_name || "") === nq,
    );
    const yearPref = input.year
      ? (exacts.length ? exacts : results).find((r) => {
          const y = r.first_air_date
            ? Number(String(r.first_air_date).slice(0, 4))
            : null;
          // The franchise's TMDB show starts at season 1's year; an AniList
          // sequel entry's year is ≥ that. Pick the candidate whose start year
          // is the closest at-or-before the entry's year.
          return y != null && y <= (input.year as number);
        })
      : null;
    const chosen = yearPref || exacts[0] || results[0];
    if (!chosen?.id) continue;
    const details = await tmdbFetch(`/tv/${chosen.id}`);
    if (!details) continue;
    tvId = chosen.id;
    showSeasons = (details.seasons || []).filter(
      (s: any) => s.season_number >= 1, // skip "Specials" (season 0)
    );
    if (showSeasons.length > 0) break;
  }

  if (!tvId || showSeasons.length === 0) {
    await setJson(cacheKey, null, TTL_MISS_S);
    return null;
  }

  const totalTmdbEps = showSeasons.reduce(
    (sum, s) => sum + (s.episode_count || 0),
    0,
  );

  // SPAN-ALL case: one AniList entry that covers the whole TMDB show. We detect
  // it when AniList gives no episode count, or a count that clearly exceeds the
  // biggest single TMDB season and reaches across the show (One Piece: one id,
  // ~1000+ eps, TMDB split into 60-100-ep sagas). Concatenate every season.
  const biggestSeason = Math.max(
    ...showSeasons.map((s) => s.episode_count || 0),
    0,
  );
  const spanAll =
    showSeasons.length > 1 &&
    (input.episodeCount == null ||
      input.episodeCount > biggestSeason * 1.5) &&
    (input.episodeCount == null || input.episodeCount <= totalTmdbEps * 1.2);

  if (spanAll) {
    const out: TmdbTarget = {
      tvId,
      seasonNumbers: showSeasons.map((s) => s.season_number).sort((a, b) => a - b),
    };
    await setJson(cacheKey, out, TTL_OK_S);
    return out;
  }

  // SINGLE-SEASON case: pick the TMDB season that best matches this AniList
  // entry. Priority: air-year match → episode-count match → fewest-difference.
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

  const seasonNumber =
    showSeasons.length === 1 ? showSeasons[0].season_number : best?.season_number;
  if (seasonNumber == null) {
    await setJson(cacheKey, null, TTL_MISS_S);
    return null;
  }

  const out: TmdbTarget = { tvId, seasonNumbers: [seasonNumber] };
  await setJson(cacheKey, out, TTL_OK_S);
  return out;
}

const toScore = (v: unknown): number | null =>
  // TMDB returns 0 for "no votes" — treat that as unrated (null).
  typeof v === "number" && v > 0 ? Math.round(v * 10) / 10 : null;

/**
 * Per-episode scores for one AniList entry. Never throws; returns
 * { source: "none", episodes: [] } when TMDB is unavailable / unmatched.
 *
 * For a span-all target (One Piece), every TMDB season is fetched and the
 * episodes are renumbered into a single continuous 1..N sequence so they line
 * up with AniList's flat episode numbering.
 */
export async function getSeasonEpisodeScores(
  input: ResolveInput,
): Promise<SeasonScores> {
  const empty: SeasonScores = { aniId: input.aniId, episodes: [], source: "none" };
  if (!TMDB_KEY) return empty;

  const cacheKey = `tmdb:eps:v3:${input.aniId}`;
  const cached = await getJson<SeasonScores>(cacheKey);
  if (cached) return cached;

  const target = await resolveTmdbTarget(input);
  if (!target) {
    await setJson(cacheKey, empty, TTL_MISS_S);
    return empty;
  }

  const episodes: EpisodeScore[] = [];
  if (target.seasonNumbers.length === 1) {
    // Single season — keep TMDB's own episode numbers.
    const season = await tmdbFetch(
      `/tv/${target.tvId}/season/${target.seasonNumbers[0]}`,
    );
    for (const e of season?.episodes || []) {
      episodes.push({ number: Number(e.episode_number), score: toScore(e.vote_average) });
    }
  } else {
    // Span-all — concatenate every season into one continuous 1..N run so the
    // numbers match AniList's flat per-show episode count.
    //
    // BULK FETCH: a long show has 20+ TMDB seasons. Fetching each individually
    // hit TMDB's rate limit / the serverless time budget and 500'd, returning
    // only a partial run. Instead use TMDB's `append_to_response`, which packs
    // up to 20 seasons into ONE /tv request (returned as `season/N` keys). We
    // batch the season numbers in groups of 20 → at most 1-2 requests total.
    const APPEND_MAX = 20;
    const batches: number[][] = [];
    for (let i = 0; i < target.seasonNumbers.length; i += APPEND_MAX) {
      batches.push(target.seasonNumbers.slice(i, i + APPEND_MAX));
    }
    const bySeason = new Map<number, any[]>();
    const batchResults = await Promise.all(
      batches.map((batch) =>
        tmdbFetch(`/tv/${target.tvId}`, {
          append_to_response: batch.map((n) => `season/${n}`).join(","),
        }),
      ),
    );
    for (const data of batchResults) {
      if (!data) continue;
      for (const sn of target.seasonNumbers) {
        const season = data[`season/${sn}`];
        if (season?.episodes) bySeason.set(sn, season.episodes);
      }
    }
    let running = 0;
    for (const sn of target.seasonNumbers) {
      const eps = (bySeason.get(sn) || [])
        .slice()
        .sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0));
      for (const e of eps) {
        running += 1;
        episodes.push({ number: running, score: toScore(e.vote_average) });
      }
    }
  }

  if (episodes.length === 0) {
    await setJson(cacheKey, empty, TTL_MISS_S);
    return empty;
  }

  const result: SeasonScores = { aniId: input.aniId, episodes, source: "tmdb" };
  await setJson(cacheKey, result, TTL_OK_S);
  return result;
}
