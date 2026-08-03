import { getTursoClient } from "./turso";

/**
 * oped_host_skips — PER-HOST OP/ED timings from the offline detector
 * (tools/opening-detector/), one row per (mal_id, episode, lang, host).
 *
 * Why per-host, not the single reconciled row of `oped_skips`:
 *   The OP/ED position is ENCODE-specific. Measured on SnK ep1: the OP starts at
 *   2:02 on sibnet but 2:19 on megaplay (different cold-open lengths, 17s apart).
 *   A single absolute OP time is therefore wrong for at least one player. Storing
 *   per host lets `/api/v2/skip?server=…` return the timing for the exact encode
 *   the viewer is on. (ED is duration-independent via `from_end_*`, but the OP's
 *   absolute start genuinely differs per host.)
 *
 * A row EXISTS as soon as a host has been processed for an episode — even with no
 * hit (op_… and ed_… left null). That's what distinguishes "processed, found nothing"
 * from "not processed yet", which the batch's version-based resume relies on.
 *
 * `host` is always one of lib/hostRegistry.js DISPLAYED_HOSTS — the importer
 * rejects anything else and `purgeUndisplayedHosts` deletes rows for hosts no
 * longer shown, so this table only ever holds players a viewer can actually pick.
 *
 * `algo_version` is the detector version that produced the row (see
 * host_versions.json). The batch re-runs a host only when its version has moved
 * past what's stored — e.g. megaplay 1→2 after the PNG-decoy de-obfuscation.
 */

/** One stored per-host OP/ED result (both intervals live on one row). */
export interface OpedHostSkipRow {
  malId: number;
  episode: number;
  lang: string;
  host: string;
  opStart: number | null;
  opEnd: number | null;
  opVotes: number | null;
  edStart: number | null;
  edEnd: number | null;
  edFromEndStart: number | null;
  edFromEndEnd: number | null;
  edVotes: number | null;
  duration: number | null; // THIS host's encode length (ED re-projection)
  source: string; // "audio" | "video" | "mixed"
  confirmedByVideo: boolean;
  algoVersion: number;
  serve: boolean;
  updatedAt: number; // epoch seconds
}

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS oped_host_skips (
  mal_id             INTEGER NOT NULL,
  episode            INTEGER NOT NULL,
  lang               TEXT    NOT NULL,
  host               TEXT    NOT NULL,
  op_start           REAL,
  op_end             REAL,
  op_votes           INTEGER,
  ed_start           REAL,
  ed_end             REAL,
  ed_from_end_start  REAL,
  ed_from_end_end    REAL,
  ed_votes           INTEGER,
  duration           REAL,
  source             TEXT    NOT NULL DEFAULT 'audio',
  confirmed_by_video INTEGER NOT NULL DEFAULT 0,
  algo_version       INTEGER NOT NULL DEFAULT 1,
  serve              INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (mal_id, episode, lang, host)
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
    /* non-fatal — lookups return [] and the caller falls back */
  }
}

function rowFrom(r: any): OpedHostSkipRow {
  const num = (v: any) => (v == null ? null : Number(v));
  return {
    malId: Number(r.mal_id),
    episode: Number(r.episode),
    lang: String(r.lang),
    host: String(r.host),
    opStart: num(r.op_start),
    opEnd: num(r.op_end),
    opVotes: num(r.op_votes),
    edStart: num(r.ed_start),
    edEnd: num(r.ed_end),
    edFromEndStart: num(r.ed_from_end_start),
    edFromEndEnd: num(r.ed_from_end_end),
    edVotes: num(r.ed_votes),
    duration: num(r.duration),
    source: String(r.source ?? "audio"),
    confirmedByVideo: Number(r.confirmed_by_video ?? 0) === 1,
    algoVersion: Number(r.algo_version ?? 1),
    serve: Number(r.serve ?? 0) === 1,
    updatedAt: Number(r.updated_at ?? 0),
  };
}

/**
 * All per-host rows for one (malId, episode, lang). Returns [] on miss / DB
 * disabled / error. Includes non-servable rows — callers filter on `serve`.
 */
export async function getHostSkips(
  malId: number,
  episode: number,
  lang: string,
): Promise<OpedHostSkipRow[]> {
  const db = getTursoClient();
  if (!db) return [];
  await ensureTable();
  try {
    const r = await db.execute({
      sql: `SELECT * FROM oped_host_skips
            WHERE mal_id = ? AND episode = ? AND lang = ?`,
      args: [malId, episode, lang],
    });
    return r.rows.map(rowFrom);
  } catch {
    return [];
  }
}

/** The single row for a specific host (the serve path's fast lookup), or null. */
export async function getHostSkip(
  malId: number,
  episode: number,
  lang: string,
  host: string,
): Promise<OpedHostSkipRow | null> {
  const db = getTursoClient();
  if (!db) return null;
  await ensureTable();
  try {
    const r = await db.execute({
      sql: `SELECT * FROM oped_host_skips
            WHERE mal_id = ? AND episode = ? AND lang = ? AND host = ? LIMIT 1`,
      args: [malId, episode, lang, host],
    });
    return r.rows.length ? rowFrom(r.rows[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Upsert per-host rows in ONE transaction. Last-write-wins on
 * (mal_id, episode, lang, host). Non-fatal on error (returns 0).
 */
export async function upsertHostSkips(rows: OpedHostSkipRow[]): Promise<number> {
  const db = getTursoClient();
  if (!db || rows.length === 0) return 0;
  await ensureTable();
  const now = Math.floor(Date.now() / 1000);
  const stmts = rows.map((row) => ({
    sql: `INSERT INTO oped_host_skips
            (mal_id, episode, lang, host, op_start, op_end, op_votes,
             ed_start, ed_end, ed_from_end_start, ed_from_end_end, ed_votes,
             duration, source, confirmed_by_video, algo_version, serve, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(mal_id, episode, lang, host) DO UPDATE SET
            op_start = excluded.op_start,
            op_end = excluded.op_end,
            op_votes = excluded.op_votes,
            ed_start = excluded.ed_start,
            ed_end = excluded.ed_end,
            ed_from_end_start = excluded.ed_from_end_start,
            ed_from_end_end = excluded.ed_from_end_end,
            ed_votes = excluded.ed_votes,
            duration = excluded.duration,
            source = excluded.source,
            confirmed_by_video = excluded.confirmed_by_video,
            algo_version = excluded.algo_version,
            serve = excluded.serve,
            updated_at = excluded.updated_at`,
    args: [
      row.malId,
      row.episode,
      row.lang,
      row.host,
      row.opStart,
      row.opEnd,
      row.opVotes,
      row.edStart,
      row.edEnd,
      row.edFromEndStart,
      row.edFromEndEnd,
      row.edVotes,
      row.duration,
      row.source,
      row.confirmedByVideo ? 1 : 0,
      row.algoVersion,
      row.serve ? 1 : 0,
      row.updatedAt || now,
    ] as any[],
  }));
  try {
    await db.batch(stmts, "write");
    return rows.length;
  } catch {
    return 0;
  }
}

/**
 * Delete every row whose host is NOT in `displayedHosts` (lib/hostRegistry.js
 * DISPLAYED_HOSTS). Called by the importer so the table only ever holds hosts a
 * viewer can pick — removing a server from lib/servers.js purges its rows on the
 * next import. Returns the number of rows deleted (0 on error / DB disabled).
 */
export async function purgeUndisplayedHosts(
  displayedHosts: string[],
): Promise<number> {
  const db = getTursoClient();
  if (!db) return 0;
  await ensureTable();
  const placeholders = displayedHosts.map(() => "?").join(", ");
  try {
    const r = await db.execute({
      sql: `DELETE FROM oped_host_skips WHERE host NOT IN (${placeholders})`,
      args: displayedHosts,
    });
    return Number(r.rowsAffected ?? 0);
  } catch {
    return 0;
  }
}
