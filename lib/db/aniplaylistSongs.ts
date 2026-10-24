import { getTursoClient } from "./turso";

/**
 * LES MUSIQUES D'ANIPLAYLIST GARDÉES (24/10/2026) — lecture de
 * `aniplaylist_songs`, que remplit scripts/music/aniplaylist-sync.mjs (un
 * Chrome headless, chaque jour : les animes en diffusion, puis le reste du
 * catalogue par popularité). Une ligne par anime, une lecture Turso.
 *
 * Fusionnées par /api/v2/anisongs avec celles d'AnisongDB : AniPlaylist a les
 * nouveautés dès leur sortie (Cyberpunk: Edgerunners 2 : 26 morceaux le
 * 24/10, AnisongDB aucun).
 */
export type AplSong = {
  i: number;
  k: "op" | "ed" | "ins";
  t: string;
  a: string[];
  e: string | null;
  p: string;
  c: string | null;
  s: number | null;
};

/** Les listes de plusieurs animes, en une requête (comptes du menu Musique). */
export async function aplSongsOf(ids: number[]): Promise<Map<number, AplSong[]>> {
  const out = new Map<number, AplSong[]>();
  const db = getTursoClient();
  if (!db || !ids.length) return out;
  try {
    const r = await db.execute({
      sql: `SELECT ani_id, data FROM aniplaylist_songs WHERE n > 0 AND ani_id IN (${ids.map(() => "?").join(",")})`,
      args: ids,
    });
    for (const row of r.rows as any[]) {
      const list = JSON.parse(String(row.data));
      if (Array.isArray(list) && list.length) out.set(Number(row.ani_id), list);
    }
  } catch {
    /* rien : les comptes restent ceux d'AnimeThemes et d'AnisongDB */
  }
  return out;
}

export async function getAplSongs(id: number): Promise<AplSong[] | null> {
  const db = getTursoClient();
  if (!db) return null;
  try {
    const r = await db.execute({ sql: "SELECT data FROM aniplaylist_songs WHERE ani_id = ?", args: [id] });
    const row = r.rows[0] as any;
    if (!row) return null;
    const list = JSON.parse(String(row.data));
    return Array.isArray(list) ? list : null;
  } catch {
    return null; /* table absente ou Turso en panne : AnisongDB seul */
  }
}
