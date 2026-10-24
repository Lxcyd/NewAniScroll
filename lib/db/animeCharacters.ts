import { getTursoClient } from "./turso";

/**
 * LES PERSONNAGES GARDÉS (24/10/2026) — lecture de `anime_characters`, que
 * remplit et rafraîchit scripts/cache/refresh-characters.mjs (TOUS les
 * personnages de chaque anime, pas les 25 de la fiche). Sert l'onglet
 * Personnages de la page anime et le menu Avatar du studio, AniList en panne
 * ou pas.
 *
 * Une ligne `complete = 0` et vide veut dire « on ne sait pas » (anime inconnu
 * d'AniList au dernier passage), jamais « zéro personnage » : l'appelant
 * retombe alors sur l'ancien chemin.
 */

type Stored = { i: number; n: string; r: "M" | "S" | "B"; f?: string; l?: string; m?: string };

const CDN = "https://s4.anilist.co/file/anilistcdn/character/";
const ROLE = { M: "MAIN", S: "SUPPORTING", B: "BACKGROUND" } as const;

/** Au format des `edges` d'AniList, celui que l'onglet Personnages lit déjà. */
function toEdge(c: Stored) {
  const large = c.f ? `${CDN}large/${c.f}` : c.l || c.m || "";
  const medium = c.f ? `${CDN}medium/${c.f}` : c.m || c.l || "";
  return {
    role: ROLE[c.r] ?? "SUPPORTING",
    node: { id: c.i, name: { full: c.n, userPreferred: c.n }, image: { large, medium } },
  };
}

export type StoredCharacters = { edges: ReturnType<typeof toEdge>[]; total: number; complete: boolean };

export async function getAnimeCharacters(id: number): Promise<StoredCharacters | null> {
  const db = getTursoClient();
  if (!db) return null;
  try {
    const r = await db.execute({
      sql: "SELECT total, complete, data FROM anime_characters WHERE ani_id = ?",
      args: [id],
    });
    const row = r.rows[0] as any;
    if (!row) return null;
    const total = Number(row.total);
    if (!total && !Number(row.complete)) return null;
    const list: Stored[] = JSON.parse(String(row.data));
    return { edges: list.map(toEdge), total, complete: !!Number(row.complete) };
  } catch {
    return null; /* table absente ou Turso en panne : l'ancien chemin */
  }
}

/**
 * Le nombre de personnages AVEC IMAGE (ceux qui font un avatar) de plusieurs
 * animes, en une requête. Les animes pas encore relevés sont absents.
 */
export async function countAnimeCharacters(ids: number[]): Promise<Record<number, number>> {
  const out: Record<number, number> = {};
  const db = getTursoClient();
  if (!db || !ids.length) return out;
  try {
    const r = await db.execute({
      sql: `SELECT ani_id, with_image, total, complete FROM anime_characters
             WHERE ani_id IN (${ids.map(() => "?").join(",")})`,
      args: ids,
    });
    for (const row of r.rows as any[]) {
      if (!Number(row.total) && !Number(row.complete)) continue;
      out[Number(row.ani_id)] = Number(row.with_image);
    }
  } catch {
    /* rien : le studio comptera en chargeant */
  }
  return out;
}

/** Le total, pour le badge de l'onglet (une ligne lue). */
export async function totalAnimeCharacters(id: number): Promise<number | null> {
  const db = getTursoClient();
  if (!db) return null;
  try {
    const r = await db.execute({
      sql: "SELECT total, complete FROM anime_characters WHERE ani_id = ?",
      args: [id],
    });
    const row = r.rows[0] as any;
    if (!row || (!Number(row.total) && !Number(row.complete))) return null;
    return Number(row.total);
  } catch {
    return null;
  }
}
