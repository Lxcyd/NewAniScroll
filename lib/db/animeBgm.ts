import { getTursoClient } from "./turso";

/**
 * LES BGM D'UN ANIME (26/11/2026) — lecture de `anime_bgm`, que remplit
 * tools/ost-resolver/bgm.py (compositeurs AniList → albums Deezer → la piste
 * chez la chaîne du compositeur sur YouTube, à ±2 s de la durée Deezer),
 * importé par scripts/music/import-anime-bgm.mjs. Seules les pistes sûres y
 * sont : une ligne par anime, une lecture Turso.
 */
export type BgmTrack = {
  /** Titre (Deezer). */
  t: string;
  /** Compositeur. */
  a: string;
  /** Durée en secondes. */
  d: number;
  /** Rang Deezer : l'ordre de la liste. */
  r: number;
  /** Album. */
  al: string;
  /** Pochette Deezer (120 px). */
  c: string | null;
  /** Id YouTube, version complète. */
  y: string;
};

const YT = /^[A-Za-z0-9_-]{11}$/;

function parse(raw: unknown): BgmTrack[] {
  try {
    const list = JSON.parse(String(raw));
    /* L'id part dans l'URL d'une iframe : revalidé à la lecture. */
    return Array.isArray(list) ? list.filter((x) => x && YT.test(x.y ?? "") && x.t) : [];
  } catch {
    return [];
  }
}

export async function getBgm(id: number): Promise<BgmTrack[]> {
  const db = getTursoClient();
  if (!db) return [];
  try {
    const r = await db.execute({ sql: "SELECT data FROM anime_bgm WHERE ani_id = ? AND n > 0", args: [id] });
    return r.rows[0] ? parse((r.rows[0] as any).data) : [];
  } catch {
    return []; /* table absente ou Turso en panne : pas de BGM, le reste suit */
  }
}

/** Le nombre de BGM de plusieurs animes, en une requête (comptes du menu Musique). */
export async function bgmCountsOf(ids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const db = getTursoClient();
  if (!db || !ids.length) return out;
  try {
    const r = await db.execute({
      sql: `SELECT ani_id, n FROM anime_bgm WHERE n > 0 AND ani_id IN (${ids.map(() => "?").join(",")})`,
      args: ids,
    });
    for (const row of r.rows as any[]) out.set(Number(row.ani_id), Number(row.n));
  } catch {
    /* rien : les comptes restent sans les BGM */
  }
  return out;
}
