import { redis } from "@/lib/redis";

/**
 * Per-episode anime ratings via Jikan (the unofficial MyAnimeList API).
 *
 * Why Jikan over TMDB: every AniList season entry carries its own MyAnimeList
 * id (`idMal`), and Jikan's `/anime/{idMal}/episodes` returns EXACTLY that
 * entry's episodes with a per-episode community `score`. So the mapping is 1:1
 * — no season-number guessing, which is what made TMDB mis-handle split-cours
 * shows (JJK seasons sharing scores, AoT seasons mislabelled / missing the
 * tail). MAL scores are on a /5 scale, so we ×2 to land on the same /10 scale
 * the grid's tiers expect.
 *
 * Keyless, but rate-limited (~3 req/s, 60/min). We cache aggressively in Redis
 * (7d for a hit, 1d for a miss) and the API route caches at the edge, so a
 * given anime is fetched from Jikan at most once per week.
 *
 * Everything degrades gracefully: no idMal, a Jikan outage, or a 404 returns
 * { source: "none", episodes: [] } and the grid shows grey cells.
 */

const JIKAN_BASE = "https://api.jikan.moe/v4";

const TTL_OK_S = 7 * 24 * 3600;
const TTL_MISS_S = 24 * 3600;

// Jikan paginates episodes 100 per page. Cap the pages we'll walk so a
// thousand-episode show (One Piece ≈ 12 pages) stays bounded.
const MAX_PAGES = 14;

export type EpisodeScore = {
  /** 1-based episode number within the season. */
  number: number;
  /** Score on a /10 scale, or null when unrated. */
  score: number | null;
};

export type SeasonScores = {
  /** The AniList season id these scores belong to. */
  aniId: number;
  episodes: EpisodeScore[];
  /** Source marker so the UI can tell real data from a fallback. */
  source: "jikan" | "none";
};

export type ResolveInput = {
  aniId: number;
  /** MyAnimeList id for this AniList season — the precise lookup key. */
  idMal?: number | null;
};

/** Episode scores are MAL-id based, so the feature is "enabled" whenever we can
 *  reach Jikan — there's no API key to gate on. Kept for API-route parity. */
export function episodeScoresEnabled(): boolean {
  return true;
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

/** Cache key for a season's scores (by MAL id). */
function cacheKeyFor(idMal: number): string {
  return `jikan:eps:v2:${idMal}`;
}

/**
 * Batch cache read for many seasons in ONE Redis round-trip (MGET). This is the
 * hot path: once an anime has been seen, every season is in Redis, so the whole
 * grid resolves from a single MGET instead of N serial GETs. Returns the cached
 * SeasonScores per input (null when not cached / no idMal).
 */
export async function getCachedSeasonScoresBatch(
  inputs: ResolveInput[],
): Promise<(SeasonScores | null)[]> {
  if (!redis || inputs.length === 0) return inputs.map(() => null);
  // Only MGET the inputs that have a key; map results back by index.
  const keyed = inputs.map((inp) => (inp.idMal ? cacheKeyFor(inp.idMal) : null));
  const realKeys = keyed.filter((k): k is string => k != null);
  if (realKeys.length === 0) return inputs.map(() => null);
  let raws: (string | null)[] = [];
  try {
    raws = await redis.mget(...realKeys);
  } catch {
    return inputs.map(() => null);
  }
  // Re-thread the MGET results (in realKeys order) back to input positions.
  const byKey = new Map<string, string | null>();
  realKeys.forEach((k, i) => byKey.set(k, raws[i]));
  return inputs.map((inp, i) => {
    const k = keyed[i];
    if (!k) return null;
    const raw = byKey.get(k);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as SeasonScores;
      return { ...parsed, aniId: inp.aniId };
    } catch {
      return null;
    }
  });
}

async function setJson(key: string, value: unknown, ttl: number): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttl);
  } catch {
    /* non-fatal */
  }
}

type JikanResult = { ok: boolean; data: any | null; rateLimited: boolean };

/** One Jikan GET with a single retry on 429 (rate limit). Distinguishes a
 *  rate-limited failure from a genuine empty/404 so the caller can avoid
 *  caching a transient miss. */
async function jikanFetch(path: string): Promise<JikanResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`${JIKAN_BASE}${path}`, { signal: ctrl.signal });
      if (res.status === 429) {
        clearTimeout(timer);
        if (attempt === 0) {
          await sleep(1200); // back off once, then retry
          continue;
        }
        return { ok: false, data: null, rateLimited: true };
      }
      if (!res.ok) {
        clearTimeout(timer);
        return { ok: false, data: null, rateLimited: false };
      }
      const data = await res.json();
      clearTimeout(timer);
      return { ok: true, data, rateLimited: false };
    } catch {
      clearTimeout(timer);
      // Network/abort — treat like a transient failure (don't cache a miss).
      return { ok: false, data: null, rateLimited: true };
    }
  }
  return { ok: false, data: null, rateLimited: true };
}

/** MAL /5 score → /10 with one decimal, or null when unrated / 0. */
function toScore(v: unknown): number | null {
  if (typeof v !== "number" || v <= 0) return null;
  return Math.round(v * 2 * 10) / 10;
}

/**
 * Per-episode scores for one AniList season, looked up by its MAL id. Never
 * throws; returns { source: "none", episodes: [] } when unavailable.
 */
export async function getSeasonEpisodeScores(
  input: ResolveInput,
): Promise<SeasonScores> {
  const empty: SeasonScores = { aniId: input.aniId, episodes: [], source: "none" };
  if (!input.idMal) return empty;

  const cacheKey = cacheKeyFor(input.idMal);
  const cached = await getJson<SeasonScores>(cacheKey);
  if (cached) return { ...cached, aniId: input.aniId };

  const episodes: EpisodeScore[] = [];
  let page = 1;
  let hasNext = true;
  let transientFail = false;
  while (hasNext && page <= MAX_PAGES) {
    const r = await jikanFetch(`/anime/${input.idMal}/episodes?page=${page}`);
    if (!r.ok) {
      // Rate-limited / network blip → bail without caching so the next request
      // retries. A genuine 404 (no episode data) just yields an empty list and
      // is cached as a miss below.
      if (r.rateLimited) transientFail = true;
      break;
    }
    const list: any[] = r.data?.data || [];
    for (const e of list) {
      const num = Number(e.mal_id);
      if (!Number.isFinite(num)) continue;
      episodes.push({ number: num, score: toScore(e.score) });
    }
    hasNext = !!r.data?.pagination?.has_next_page;
    page += 1;
    // Gentle pacing between pages to stay within Jikan's rate limit.
    if (hasNext && page <= MAX_PAGES) await sleep(400);
  }

  if (episodes.length === 0) {
    // Only cache a real miss; a transient rate-limit must be retried next time.
    if (!transientFail) await setJson(cacheKey, empty, TTL_MISS_S);
    return empty;
  }

  // Jikan numbers episodes from 1 per MAL entry, which already matches AniList's
  // per-season numbering — no renumbering needed.
  episodes.sort((a, b) => a.number - b.number);
  const result: SeasonScores = { aniId: input.aniId, episodes, source: "jikan" };
  await setJson(cacheKey, result, TTL_OK_S);
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
