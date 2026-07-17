import { getFanartsClient } from "./turso-fanarts";
import type { TmdbMatchReason } from "@/lib/tmdb/resolveTmdbSeason";

/**
 * tmdb_stills_cache — per-anime TMDB episode still URLs, and the refusals.
 *
 * Shape and failure policy copied from lib/db/seasonCache.ts: the key carries
 * its own version tag, TTL is checked on read, the table is created lazily, and
 * every error is swallowed to null so the caller recomputes rather than serving
 * something wrong.
 *
 * Lives in the fanarts DB (lib/db/turso-fanarts.ts) because it's image data —
 * that module exists to keep image row-reads off the hot metadata path, and
 * episode stills have exactly that profile. It falls back to the main DB when
 * the fanarts env vars are unset.
 *
 * REFUSALS ARE CACHED, and that's the point. Most of the catalogue will never
 * resolve (resolveTmdbSeason refuses on purpose — see its header), so without
 * caching the "no" every Redis miss would re-hit TMDB for a title we already
 * know we won't use. Refusals get a shorter TTL than hits so a Fribb re-ingest
 * or a TMDB correction can rescue a title within a day. Transient failures
 * (network, rate-limit) must NOT be cached — the caller decides that.
 */

export interface StillsCacheValue {
  /** episode number → full still URL. Empty on a refusal. */
  stills: Record<number, string>;
  /** Why this is what it is — kept so a bad mapping is diagnosable later.
   *  Simkl reasons are free-form strings; TMDB's are the typed union. */
  reason: TmdbMatchReason | string;
  tvId: number | null;
  season: number | null;
}

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS tmdb_stills_cache (
  cache_key   TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
)`;

export const TTL_HIT_S = 7 * 24 * 60 * 60;
export const TTL_REFUSAL_S = 24 * 60 * 60;

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

/** Stills source. Part of the cache key so the two never overwrite each other. */
export type StillsSource = "tmdb" | "simkl";

function keyFor(anilistId: number, source: StillsSource): string {
  // "tmdbStills:v1:" kept verbatim for tmdb so existing rows stay valid.
  return source === "tmdb"
    ? `tmdbStills:v1:${anilistId}`
    : `simklStills:v1:${anilistId}`;
}

/** Cached value, or null on miss / expiry / DB disabled / error. A stale row is
 *  a miss so we never serve past the freshness window. */
export async function getCachedStills(
  anilistId: number,
  source: StillsSource = "tmdb",
): Promise<StillsCacheValue | null> {
  const db = getFanartsClient();
  if (!db) return null;
  await ensureTable();
  try {
    const r = await db.execute({
      sql: "SELECT value, updated_at FROM tmdb_stills_cache WHERE cache_key = ? LIMIT 1",
      args: [keyFor(anilistId, source)],
    });
    if (!r.rows.length) return null;
    const row = r.rows[0] as any;
    const parsed = JSON.parse(String(row.value)) as StillsCacheValue;
    // A refusal expires sooner than a hit: it may only be waiting on a Fribb
    // re-ingest or a TMDB fix.
    const ttl = parsed.reason === "ok" ? TTL_HIT_S : TTL_REFUSAL_S;
    const age = Math.floor(Date.now() / 1000) - Number(row.updated_at);
    if (age > ttl) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Upsert. Non-fatal on error (the cache is an optimization). */
export async function setCachedStills(
  anilistId: number,
  value: StillsCacheValue,
  source: StillsSource = "tmdb",
): Promise<void> {
  const db = getFanartsClient();
  if (!db) return;
  await ensureTable();
  try {
    await db.execute({
      sql: `INSERT INTO tmdb_stills_cache (cache_key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(cache_key) DO UPDATE SET
              value = excluded.value,
              updated_at = excluded.updated_at`,
      args: [
        keyFor(anilistId, source),
        JSON.stringify(value),
        Math.floor(Date.now() / 1000),
      ],
    });
  } catch {
    /* non-fatal */
  }
}
