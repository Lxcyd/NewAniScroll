import { getTursoClient } from "./turso";

/**
 * season_override — manual last-word patches for franchises the automatic
 * resolver gets wrong (TMDB fusion, mislabeled relations…). Read BEFORE Fribb
 * in the resolver cascade. See lib/db/schema.sql for the table.
 *
 * Rarely populated — a safety valve, not a primary data source.
 */

export interface SeasonOverride {
  aniId: number;
  season: number | null;
  total: number | null;
  format: string | null;
  note: string | null;
}

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS season_override (
  ani_id       INTEGER PRIMARY KEY,
  season       INTEGER,
  total        INTEGER,
  format       TEXT,
  note         TEXT,
  updated_at   INTEGER NOT NULL
)`;

let ensured = false;
async function ensureTable(): Promise<void> {
  if (ensured) return;
  const db = getTursoClient();
  if (!db) return;
  try {
    await db.execute(CREATE_SQL);
    ensured = true;
  } catch {
    /* non-fatal — lookups will just return null */
  }
}

/** Override for one AniList id, or null if none / DB disabled. */
export async function getSeasonOverride(
  aniId: number
): Promise<SeasonOverride | null> {
  const db = getTursoClient();
  if (!db) return null;
  await ensureTable();
  try {
    const r = await db.execute({
      sql: "SELECT * FROM season_override WHERE ani_id = ? LIMIT 1",
      args: [aniId],
    });
    if (!r.rows.length) return null;
    const row = r.rows[0] as any;
    return {
      aniId: Number(row.ani_id),
      season: row.season != null ? Number(row.season) : null,
      total: row.total != null ? Number(row.total) : null,
      format: row.format ?? null,
      note: row.note ?? null,
    };
  } catch {
    return null;
  }
}
