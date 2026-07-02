import { getTursoClient } from "./turso";

/**
 * season_cache — persistent cache for the season-resolution outputs
 * (seasonChain / seasonList / film variants), migrated OFF Redis.
 *
 * Why Turso, not Redis:
 *   - These are quasi-static, DERIVABLE results (a franchise's season layout
 *     only changes when AniList publishes a new sequel — rare).
 *   - Redis (Upstash) is a network hop that, when slow/unreachable, blocked the
 *     whole resolver for ~90 s per request and its stale/poisoned values served
 *     the WRONG season (the "SnK S1 plays S2" class of bug). Turso is the same
 *     store we already trust for player_map / season_override, and a miss/error
 *     just falls back to recomputing from AniList — never to a wrong answer.
 *
 * The `cache_key` string carries its own version tag (e.g. "seasonList:v11:16498"),
 * exactly like the old Redis keys, so bumping a version still evicts stale rows
 * (they simply stop being read; a periodic sweep or TTL check removes them).
 */

export interface SeasonCacheRow<T> {
  value: T;
  updatedAt: number; // epoch seconds
}

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS season_cache (
  cache_key   TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
)`;

// Mirrors the old Redis TTL: a season chain tolerates a week of staleness.
const TTL_SECONDS = 7 * 24 * 60 * 60;

let ensured = false;
async function ensureTable(): Promise<void> {
  if (ensured) return;
  const db = getTursoClient();
  if (!db) return;
  try {
    await db.execute(CREATE_SQL);
    ensured = true;
  } catch {
    /* non-fatal — lookups will just return null and callers recompute */
  }
}

/** Read a cached value by key, or null on miss / expiry / DB disabled / error.
 *  A stale row (older than TTL) is treated as a miss so the caller recomputes;
 *  we never serve a value past its freshness window. */
export async function seasonCacheGet<T>(key: string): Promise<T | null> {
  const db = getTursoClient();
  if (!db) return null;
  await ensureTable();
  try {
    const r = await db.execute({
      sql: "SELECT value, updated_at FROM season_cache WHERE cache_key = ? LIMIT 1",
      args: [key],
    });
    if (!r.rows.length) return null;
    const row = r.rows[0] as any;
    const age = Math.floor(Date.now() / 1000) - Number(row.updated_at);
    if (age > TTL_SECONDS) return null;
    return JSON.parse(String(row.value)) as T;
  } catch {
    return null;
  }
}

/** Upsert a cached value. Non-fatal on error (cache is an optimization). */
export async function seasonCacheSet(key: string, value: unknown): Promise<void> {
  const db = getTursoClient();
  if (!db) return;
  await ensureTable();
  try {
    await db.execute({
      sql: `INSERT INTO season_cache (cache_key, value, updated_at)
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

/** Delete cached rows whose key STARTS WITH `prefix` — used to purge a poisoned
 *  entry or evict an old version deliberately (e.g. "seasonList:v10:"). */
export async function seasonCachePurge(prefix: string): Promise<number> {
  const db = getTursoClient();
  if (!db) return 0;
  await ensureTable();
  try {
    const r = await db.execute({
      sql: "DELETE FROM season_cache WHERE cache_key LIKE ?",
      args: [`${prefix}%`],
    });
    return r.rowsAffected ?? 0;
  } catch {
    return 0;
  }
}
