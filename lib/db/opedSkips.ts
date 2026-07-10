import { getTursoClient } from "./turso";

/**
 * oped_skips — persistent store for the OFFLINE OP/ED detector's output
 * (tools/opening-detector/), served by /api/v2/skip.
 *
 * Why Turso, not Redis / not on-the-fly:
 *   - The timings are pre-computed offline (audio fingerprint vs the AnimeThemes
 *     clean clip, cross-host reconciled). Detecting at request time would mean
 *     seconds of ffmpeg per episode — far too slow for page load. So the batch
 *     writes here and the API just reads.
 *   - Same store we already trust for season_cache / player_map; a miss/error
 *     simply falls back (the API can still try crowdsourced sources or serve a
 *     hole) — never a wrong answer.
 *   - Read path is a single indexed lookup + the existing 24h Cache-Control on
 *     /api/v2/skip, so the vast majority of hits are served by the CDN/browser,
 *     NOT by a Vercel invocation or an Upstash round-trip.
 *
 * Precision-first serve policy: a row carries `serve` (0/1) decided offline by
 * the detector's cross-host consensus (≥2 hosts agree, OR 1 host + video
 * confirms). The API returns ONLY `serve = 1` rows — we never ship a doubtful
 * timing. Everything is still stored (serve = 0 too) for inspection/re-runs.
 *
 * ED rows carry a duration-independent `from_end_*` anchor so the API can
 * re-project the ED onto the ACTIVE player's real duration (encodes differ in
 * length across hosts) instead of a fixed absolute time.
 */

/** One stored OP or ED interval for (mal_id, episode, lang, kind). */
export interface OpedSkipRow {
  malId: number;
  episode: number;
  lang: string;
  kind: "op" | "ed";
  start: number;
  end: number;
  fromEndStart: number | null;
  fromEndEnd: number | null;
  canonicalDuration: number | null;
  nHostsAgree: number;
  nVideoConfirm: number;
  source: string; // "audio" | "video" | "mixed"
  serve: boolean;
  updatedAt: number; // epoch seconds
}

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS oped_skips (
  mal_id             INTEGER NOT NULL,
  episode            INTEGER NOT NULL,
  lang               TEXT    NOT NULL,
  kind               TEXT    NOT NULL,
  start              REAL    NOT NULL,
  end                REAL    NOT NULL,
  from_end_start     REAL,
  from_end_end       REAL,
  canonical_duration REAL,
  n_hosts_agree      INTEGER NOT NULL DEFAULT 0,
  n_video_confirm    INTEGER NOT NULL DEFAULT 0,
  source             TEXT    NOT NULL DEFAULT 'audio',
  serve              INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (mal_id, episode, lang, kind)
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

function rowFrom(r: any): OpedSkipRow {
  return {
    malId: Number(r.mal_id),
    episode: Number(r.episode),
    lang: String(r.lang),
    kind: String(r.kind) as "op" | "ed",
    start: Number(r.start),
    end: Number(r.end),
    fromEndStart: r.from_end_start == null ? null : Number(r.from_end_start),
    fromEndEnd: r.from_end_end == null ? null : Number(r.from_end_end),
    canonicalDuration:
      r.canonical_duration == null ? null : Number(r.canonical_duration),
    nHostsAgree: Number(r.n_hosts_agree ?? 0),
    nVideoConfirm: Number(r.n_video_confirm ?? 0),
    source: String(r.source ?? "audio"),
    serve: Number(r.serve ?? 0) === 1,
    updatedAt: Number(r.updated_at ?? 0),
  };
}

/**
 * All stored OP/ED rows for one (malId, episode, lang). Returns [] on miss / DB
 * disabled / error. Includes non-servable rows — callers filter on `serve`.
 */
export async function getOpedSkips(
  malId: number,
  episode: number,
  lang: string,
): Promise<OpedSkipRow[]> {
  const db = getTursoClient();
  if (!db) return [];
  await ensureTable();
  try {
    const r = await db.execute({
      sql: `SELECT * FROM oped_skips
            WHERE mal_id = ? AND episode = ? AND lang = ?`,
      args: [malId, episode, lang],
    });
    return r.rows.map(rowFrom);
  } catch {
    return [];
  }
}

/**
 * Upsert a batch of rows in ONE transaction (the importer feeds hundreds of
 * episodes at once — a per-row round-trip would be needlessly chatty on Turso).
 * Last-write-wins on the (mal_id, episode, lang, kind) key. Non-fatal on error.
 */
export async function upsertOpedSkips(rows: OpedSkipRow[]): Promise<number> {
  const db = getTursoClient();
  if (!db || rows.length === 0) return 0;
  await ensureTable();
  const now = Math.floor(Date.now() / 1000);
  const stmts = rows.map((row) => ({
    sql: `INSERT INTO oped_skips
            (mal_id, episode, lang, kind, start, end, from_end_start,
             from_end_end, canonical_duration, n_hosts_agree, n_video_confirm,
             source, serve, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(mal_id, episode, lang, kind) DO UPDATE SET
            start = excluded.start,
            end = excluded.end,
            from_end_start = excluded.from_end_start,
            from_end_end = excluded.from_end_end,
            canonical_duration = excluded.canonical_duration,
            n_hosts_agree = excluded.n_hosts_agree,
            n_video_confirm = excluded.n_video_confirm,
            source = excluded.source,
            serve = excluded.serve,
            updated_at = excluded.updated_at`,
    args: [
      row.malId,
      row.episode,
      row.lang,
      row.kind,
      row.start,
      row.end,
      row.fromEndStart,
      row.fromEndEnd,
      row.canonicalDuration,
      row.nHostsAgree,
      row.nVideoConfirm,
      row.source,
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
