import { getFanartsClient } from "./turso-fanarts";

/**
 * tmdb_images_cache — the PICKED backdrop and logo URL per AniList id.
 *
 * Distinct from `tmdb_stills_cache` (lib/db/tmdbStillsCache.ts) on purpose:
 * that table is keyed per-anime but holds a per-EPISODE map and is read on the
 * episode API; this one is read on every homepage SSR, for eight titles at
 * once. Sharing a row would make the hero pay to deserialise a 1,100-entry
 * One Piece stills blob.
 *
 * We store the two chosen URLs, not TMDB's full `/images` payload. A popular
 * title returns 200+ backdrops; keeping them would put ~80 kB per anime in a
 * table whose only consumer wants two strings. The selection rules live in
 * lib/tmdb/pick.ts and are cheap to re-run — but only after a re-fetch, and a
 * re-fetch is exactly what this table exists to avoid. If those rules change,
 * bump CACHE_VERSION rather than trying to migrate rows.
 *
 * Same shape and failure policy as the other caches here (seasonCache,
 * tmdbStillsCache): version tag inside the key, TTL checked on read, table
 * created lazily, every error swallowed to null so the caller recomputes
 * rather than serving something wrong.
 *
 * REFUSALS ARE CACHED. Most anime are simply absent from TMDB, or absent from
 * Fribb's mapping; without caching the "no" we would re-ask TMDB for the same
 * eight homepage titles on every cold SSR. Refusals get a shorter TTL so a
 * Fribb re-ingest or a TMDB contribution can rescue a title within a day.
 * Transient failures (network, timeout) are NOT cached — the caller decides.
 */

export type TmdbImagesReason =
  | "ok"
  | "no-key"
  | "no-fribb"
  | "no-tmdb-id"
  | "no-images"
  | "tmdb-error";

export interface TmdbImagesCacheValue {
  /** Full display URL at the size we render, or null. */
  backdrop: string | null;
  /** Full display URL of the English title logo, or null. */
  logo: string | null;
  /** Why this is what it is — kept so a bad mapping is diagnosable later. */
  reason: TmdbImagesReason;
  tmdbId: number | null;
  kind: "tv" | "movie" | null;
}

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS tmdb_images_cache (
  cache_key   TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
)`;

/* 30 days on a hit: series artwork is static in practice — a title's best
   backdrop does not change week to week, and the homepage reads this eight
   times per cold render. */
export const TTL_HIT_S = 30 * 24 * 60 * 60;
export const TTL_REFUSAL_S = 24 * 60 * 60;

/** Bump when lib/tmdb/pick.ts changes what it would choose. */
const CACHE_VERSION = "v1";

let ensured = false;
async function ensureTable(): Promise<void> {
  if (ensured) return;
  const db = getFanartsClient();
  if (!db) return;
  try {
    await db.execute(CREATE_SQL);
    ensured = true;
  } catch {
    /* non-fatal — reads return null and the caller recomputes */
  }
}

function keyFor(anilistId: number): string {
  return `tmdbImages:${CACHE_VERSION}:${anilistId}`;
}

/** Cached value, or null on miss / expiry / DB disabled / error. A stale row
 *  is a miss, so we never serve past the freshness window. */
export async function getCachedTmdbImages(
  anilistId: number,
): Promise<TmdbImagesCacheValue | null> {
  const db = getFanartsClient();
  if (!db) return null;
  await ensureTable();
  try {
    const r = await db.execute({
      sql: "SELECT value, updated_at FROM tmdb_images_cache WHERE cache_key = ? LIMIT 1",
      args: [keyFor(anilistId)],
    });
    if (!r.rows.length) return null;
    const row = r.rows[0] as any;
    const parsed = JSON.parse(String(row.value)) as TmdbImagesCacheValue;
    const ttl = parsed.reason === "ok" ? TTL_HIT_S : TTL_REFUSAL_S;
    const age = Math.floor(Date.now() / 1000) - Number(row.updated_at);
    if (age > ttl) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Generic JSON row in the same table, for small derived facts that share this
 * cache's profile (per-title, cheap, read on an SSR path, safe to recompute).
 *
 * Currently the AniList banner dimension probe (lib/images/bannerSize.ts). It
 * gets its own key namespace rather than a column on the row above because it
 * is keyed by IMAGE URL, not by anime id — a title whose banner is replaced
 * upstream must re-probe, and it would otherwise inherit the old verdict.
 *
 * The caller owns the TTL: unlike the artwork rows there is no single sensible
 * default across future uses.
 */
export async function getCachedJson<T>(
  key: string,
  ttlSeconds: number,
): Promise<T | null> {
  const db = getFanartsClient();
  if (!db) return null;
  await ensureTable();
  try {
    const r = await db.execute({
      sql: "SELECT value, updated_at FROM tmdb_images_cache WHERE cache_key = ? LIMIT 1",
      args: [key],
    });
    if (!r.rows.length) return null;
    const row = r.rows[0] as any;
    const age = Math.floor(Date.now() / 1000) - Number(row.updated_at);
    if (age > ttlSeconds) return null;
    return JSON.parse(String(row.value)) as T;
  } catch {
    return null;
  }
}

/** Companion writer for getCachedJson. Non-fatal on error. */
export async function setCachedJson(key: string, value: unknown): Promise<void> {
  const db = getFanartsClient();
  if (!db) return;
  await ensureTable();
  try {
    await db.execute({
      sql: `INSERT INTO tmdb_images_cache (cache_key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(cache_key) DO UPDATE SET
              value = excluded.value,
              updated_at = excluded.updated_at`,
      args: [key, JSON.stringify(value), Math.floor(Date.now() / 1000)],
    });
  } catch {
    /* non-fatal */
  }
}

/** Upsert. Non-fatal on error (the cache is an optimization). */
export async function setCachedTmdbImages(
  anilistId: number,
  value: TmdbImagesCacheValue,
): Promise<void> {
  const db = getFanartsClient();
  if (!db) return;
  await ensureTable();
  try {
    await db.execute({
      sql: `INSERT INTO tmdb_images_cache (cache_key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(cache_key) DO UPDATE SET
              value = excluded.value,
              updated_at = excluded.updated_at`,
      args: [
        keyFor(anilistId),
        JSON.stringify(value),
        Math.floor(Date.now() / 1000),
      ],
    });
  } catch {
    /* non-fatal */
  }
}
