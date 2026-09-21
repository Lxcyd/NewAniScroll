import { getTursoClient } from "@/lib/db/turso";

/**
 * Fribb/anime-lists integration.
 *
 * Fribb publishes a JSON that cross-maps AniList ↔ MAL ↔ TMDB ↔ TVDB ↔ … plus a
 * pre-computed TMDB/TVDB season number per entry. scripts/cache/refresh-fribb.mjs
 * ingests it into the `fribb_map` Turso table (see lib/db/schema.sql); this
 * module exposes the lookups used by the multi-signal season resolver.
 *
 * IMPORTANT: Fribb is ONE validated signal, never sole authority. TMDB
 * mislabels/fuses seasons (Bungo Stray Dogs: season = 1,1,2,3,3), leaves
 * `season` null on long sagas (One Piece/Naruto), and misses recent entries.
 * `isFribbGroupConsistent()` below is what lets the resolver reject a bad group.
 */

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
