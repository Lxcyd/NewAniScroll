import { getTursoClient } from "@/lib/db/turso";

/**
 * Fribb/anime-lists integration.
 *
 * Fribb publishes a JSON that cross-maps AniList ↔ MAL ↔ TMDB ↔ TVDB ↔ … plus a
 * pre-computed TMDB/TVDB season number per entry. We ingest it into the
 * `fribb_map` Turso table (see lib/db/schema.sql) and expose lookups used by the
 * multi-signal season resolver.
 *
 * IMPORTANT: Fribb is ONE validated signal, never sole authority. TMDB
 * mislabels/fuses seasons (Bungo Stray Dogs: season = 1,1,2,3,3), leaves
 * `season` null on long sagas (One Piece/Naruto), and misses recent entries.
 * `isFribbGroupConsistent()` below is what lets the resolver reject a bad group.
 *
 * We fetch the MINIFIED list (anime-list-mini.json, ~5.8 MB) — same fields as
 * the full file, less bandwidth. There is no anime-list-reduced.json (404).
 */

const FRIBB_URL =
  "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json";

export interface FribbEntry {
  anilistId: number;
  malId: number | null;
  tmdbTvId: number | null;
  tmdbMovieId: number | null;
  tvdbId: number | null;
  /** Simkl id, tel que Fribb le publie. PLUS RIEN NE LE LIT depuis le retrait
   *  de Simkl (22/08/2026) : la colonne reste alimentee parce qu'elle arrive
   *  telle quelle de la table publique, et qu'un ALTER TABLE sur une base de
   *  production ne se justifie pas pour un entier par ligne. */
  simklId: number | null;
  tmdbSeason: number | null;
  tvdbSeason: number | null;
  type: string | null;
}

/** Raw record shape in anime-list-mini.json (only the fields we read). */
interface RawFribbRecord {
  anilist_id?: number;
  mal_id?: number;
  themoviedb_id?: { tv?: number; movie?: number[] | number } | number;
  tvdb_id?: number;
  simkl_id?: number;
  season?: { tmdb?: number | null; tvdb?: number | null } | null;
  type?: string;
}

function firstMovieId(
  tmdb: RawFribbRecord["themoviedb_id"]
): number | null {
  if (!tmdb || typeof tmdb === "number") return null;
  const m = tmdb.movie;
  if (Array.isArray(m)) return m.length ? Number(m[0]) : null;
  return typeof m === "number" ? m : null;
}

function tvId(tmdb: RawFribbRecord["themoviedb_id"]): number | null {
  if (!tmdb || typeof tmdb === "number") return null;
  return typeof tmdb.tv === "number" ? tmdb.tv : null;
}

/** Normalize a raw record to our slim shape. Returns null if no anilist id. */
function normalize(r: RawFribbRecord): FribbEntry | null {
  if (typeof r.anilist_id !== "number") return null;
  return {
    anilistId: r.anilist_id,
    malId: typeof r.mal_id === "number" ? r.mal_id : null,
    tmdbTvId: tvId(r.themoviedb_id),
    tmdbMovieId: firstMovieId(r.themoviedb_id),
    tvdbId: typeof r.tvdb_id === "number" ? r.tvdb_id : null,
    simklId: typeof r.simkl_id === "number" ? r.simkl_id : null,
    tmdbSeason:
      r.season && typeof r.season.tmdb === "number" ? r.season.tmdb : null,
    tvdbSeason:
      r.season && typeof r.season.tvdb === "number" ? r.season.tvdb : null,
    type: r.type ?? null,
  };
}

// ── DDL (idempotent) ────────────────────────────────────────────────────────
// Kept here so the ingest script is self-sufficient (mirrors lib/db/schema.sql).
const CREATE_FRIBB_SQL = `
CREATE TABLE IF NOT EXISTS fribb_map (
  anilist_id     INTEGER PRIMARY KEY,
  mal_id         INTEGER,
  tmdb_tv_id     INTEGER,
  tmdb_movie_id  INTEGER,
  tvdb_id        INTEGER,
  simkl_id       INTEGER,
  tmdb_season    INTEGER,
  tvdb_season    INTEGER,
  type           TEXT,
  updated_at     INTEGER NOT NULL
)`;

async function ensureTable(): Promise<void> {
  const db = getTursoClient();
  if (!db) return;
  await db.execute(CREATE_FRIBB_SQL);
  /* simkl_id was added after the table shipped, so CREATE TABLE IF NOT EXISTS
     won't add it to an existing DB. SQLite has no ALTER TABLE ... IF NOT
     EXISTS, and re-adding throws "duplicate column name" — which is the
     success case on a second run, so swallow exactly that. */
  try {
    await db.execute("ALTER TABLE fribb_map ADD COLUMN simkl_id INTEGER");
  } catch (e: any) {
    if (!/duplicate column/i.test(String(e?.message))) throw e;
  }
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_fribb_tmdb_tv ON fribb_map(tmdb_tv_id)"
  );
}

/**
 * Download the Fribb list and upsert every AniList-linked entry into
 * `fribb_map`. Returns the number of rows written. Called by the refresh cron.
 *
 * Uses batched inserts to keep the number of round-trips bounded (~20k rows).
 */
export async function ingestFribb(): Promise<{ rows: number; skipped: number }> {
  const db = getTursoClient();
  if (!db) return { rows: 0, skipped: 0 };
  await ensureTable();

  const res = await fetch(FRIBB_URL);
  if (!res.ok) {
    throw new Error(`Fribb fetch failed: ${res.status} ${res.statusText}`);
  }
  const raw = (await res.json()) as RawFribbRecord[];
  const now = Math.floor(Date.now() / 1000);

  const entries = raw
    .map(normalize)
    .filter((e): e is FribbEntry => e !== null);

  let written = 0;
  const BATCH = 500;
  for (let i = 0; i < entries.length; i += BATCH) {
    const slice = entries.slice(i, i + BATCH);
    const stmts = slice.map((e) => ({
      sql: `INSERT INTO fribb_map
        (anilist_id, mal_id, tmdb_tv_id, tmdb_movie_id, tvdb_id, simkl_id,
         tmdb_season, tvdb_season, type, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(anilist_id) DO UPDATE SET
          mal_id=excluded.mal_id, tmdb_tv_id=excluded.tmdb_tv_id,
          tmdb_movie_id=excluded.tmdb_movie_id, tvdb_id=excluded.tvdb_id,
          simkl_id=excluded.simkl_id,
          tmdb_season=excluded.tmdb_season, tvdb_season=excluded.tvdb_season,
          type=excluded.type, updated_at=excluded.updated_at`,
      args: [
        e.anilistId,
        e.malId,
        e.tmdbTvId,
        e.tmdbMovieId,
        e.tvdbId,
        e.simklId,
        e.tmdbSeason,
        e.tvdbSeason,
        e.type,
        now,
      ],
    }));
    await db.batch(stmts, "write");
    written += slice.length;
  }

  return { rows: written, skipped: raw.length - entries.length };
}

// ── Lookups ─────────────────────────────────────────────────────────────────

function rowToEntry(row: any): FribbEntry {
  return {
    anilistId: Number(row.anilist_id),
    malId: row.mal_id != null ? Number(row.mal_id) : null,
    tmdbTvId: row.tmdb_tv_id != null ? Number(row.tmdb_tv_id) : null,
    tmdbMovieId: row.tmdb_movie_id != null ? Number(row.tmdb_movie_id) : null,
    tvdbId: row.tvdb_id != null ? Number(row.tvdb_id) : null,
    simklId: row.simkl_id != null ? Number(row.simkl_id) : null,
    tmdbSeason: row.tmdb_season != null ? Number(row.tmdb_season) : null,
    tvdbSeason: row.tvdb_season != null ? Number(row.tvdb_season) : null,
    type: row.type ?? null,
  };
}

/** Fribb entry for one AniList id, or null if absent / DB disabled. */
export async function getFribbEntry(
  anilistId: number
): Promise<FribbEntry | null> {
  const db = getTursoClient();
  if (!db) return null;
  try {
    const r = await db.execute({
      sql: "SELECT * FROM fribb_map WHERE anilist_id = ? LIMIT 1",
      args: [anilistId],
    });
    return r.rows.length ? rowToEntry(r.rows[0]) : null;
  } catch {
    return null;
  }
}

/** Every Fribb entry sharing a TMDB *tv* id — i.e. the same franchise as far
 *  as TMDB is concerned. Empty when the anime has no tmdb.tv mapping. */
export async function getFribbFranchise(
  tmdbTvId: number
): Promise<FribbEntry[]> {
  const db = getTursoClient();
  if (!db || !tmdbTvId) return [];
  try {
    const r = await db.execute({
      sql: "SELECT * FROM fribb_map WHERE tmdb_tv_id = ?",
      args: [tmdbTvId],
    });
    return r.rows.map(rowToEntry);
  } catch {
    return [];
  }
}

// ── Consistency test (the guard that makes Fribb usable) ─────────────────────

/**
 * Decide whether a franchise's Fribb season numbers are trustworthy.
 *
 * Rejects the group when TMDB clearly fused or mislabeled seasons — the signals
 * that broke Bungo Stray Dogs:
 *   • collision   — two entries with the same non-null tmdb_season,
 *   • undercut    — fewer distinct TMDB seasons than TV entries in the group,
 *   • all-null    — no entry carries a season number (long sagas).
 *
 * When it returns false the resolver ignores Fribb's numbering and falls back to
 * dates + titles. It does NOT try to prove the numbers are *right* — only that
 * they aren't obviously broken.
 */
export function isFribbGroupConsistent(group: FribbEntry[]): boolean {
  const withSeason = group.filter((e) => e.tmdbSeason != null);
  if (withSeason.length === 0) return false; // all-null → unusable

  const seen = new Set<number>();
  for (const e of withSeason) {
    const s = e.tmdbSeason as number;
    if (seen.has(s)) return false; // collision (BSD: two "1", two "3")
    seen.add(s);
  }

  // Undercut: TMDB exposes fewer distinct seasons than the group has TV-like
  // entries → it merged some (partial or total grouping).
  const tvLike = group.filter((e) =>
    ["TV", "TV_SHORT", "ONA"].includes(e.type || "")
  );
  if (tvLike.length > 0 && seen.size < tvLike.length) return false;

  return true;
}
