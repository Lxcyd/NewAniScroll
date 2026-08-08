import { getFanartsClient } from "./turso-fanarts";

/**
 * tmdb_stills_cache — per-anime episode still URLs, and the refusals.
 *
 * The TABLE NAME is a fossil and stays one on purpose: TMDB was dropped as a
 * provider (Simkl is the only source now), but this table holds live Simkl rows
 * in production. Renaming it would orphan every one of them and re-fetch the
 * whole catalogue for nothing. It is, and always was, a generic stills cache.
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
 * REFUSALS ARE CACHED, and that's the point: a title Simkl has no images for
 * would otherwise be re-fetched on every Redis miss. Refusals get a shorter TTL
 * than hits so a provider-side correction can rescue a title within a day.
 * Transient failures (network, rate-limit) must NOT be cached — the caller
 * decides that.
 */

export interface StillsCacheValue {
  /** episode number → full still URL. Empty on a refusal. */
  stills: Record<number, string>;
  /** episode number → title. Absent on rows written before titles shipped and
   *  on leftover TMDB-era rows, so readers must treat it as optional. */
  titles?: Record<number, string>;
  /** Why this is what it is — kept so a bad mapping is diagnosable later.
   *  Free-form; older rows may still carry a TMDB refusal tag. */
  reason: string;
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

/** Stills source. Part of the cache key so no two overwrite each other. */
export type StillsSource = "tmdb" | "simkl" | "anizip";

const KEY_PREFIX: Record<StillsSource, string> = {
  // "tmdbStills:v1:" kept verbatim so rows written before TMDB was dropped —
  // and by the gap-fill path that succeeded it — stay readable.
  tmdb: "tmdbStills:v1:",
  simkl: "simklStills:v1:",
  anizip: "anizipStills:v1:",
};

function keyFor(anilistId: number, source: StillsSource): string {
  return `${KEY_PREFIX[source]}${anilistId}`;
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
