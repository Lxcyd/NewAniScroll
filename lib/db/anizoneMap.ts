/**
 * anizone_map — fiche AniList -> identifiant anizone.to (8 caracteres).
 *
 * Anizone ne publie AUCUN identifiant AniList/MAL : la correspondance se trouve
 * par sa recherche (titres + annee, cf. lib/anizone/resolve.js) et se retient
 * ici, une ligne par fiche, pour ne jamais rechercher deux fois le meme titre.
 *
 * Table a part plutot que player_map : les scripts de player_map
 * (verify-player-map, purge-heuristic…) relisent toutes ses lignes avec la
 * logique d'anime-sama / voir-anime, qui n'a aucun sens pour anizone.
 *
 * Lue par CLE PRIMAIRE uniquement (1 ligne lue par appel), et seulement quand
 * le cache Redis de /api/v2/source n'a pas la reponse.
 */

import { getTursoClient } from "./turso";

export type AnizoneMapRow = {
  aniId: number;
  /** null = anizone n'a pas ce titre (au moment de `checkedAt`). */
  slug: string | null;
  title: string | null;
  expiresAt: number;
  /** Au-dela de `expiresAt` : a re-chercher, mais encore utilisable. */
  expired: boolean;
};

const DAY = 86400;
/** Trouve : stable, mais un mauvais appariement doit pouvoir se corriger seul. */
export const ANIZONE_TTL_FOUND = 60 * DAY;
/** Absent : le catalogue d'anizone grandit (les saisons en cours arrivent). */
export const ANIZONE_TTL_ABSENT = 7 * DAY;

const TABLE = `
CREATE TABLE IF NOT EXISTS anizone_map (
  ani_id      INTEGER PRIMARY KEY,
  slug        TEXT,
  title       TEXT,
  checked_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);`;

let tableEnsured = false;
async function ensureTable(): Promise<void> {
  if (tableEnsured) return;
  const db = getTursoClient();
  if (!db) return;
  try {
    await db.execute(TABLE);
  } catch {
    /* course entre deux lambdas : la table existe, c'est tout ce qu'on voulait */
  }
  tableEnsured = true;
}

/** La ligne de cette fiche, ou null (jamais cherchee, ou base muette). */
export async function getAnizoneMap(aniId: number): Promise<AnizoneMapRow | null> {
  const db = getTursoClient();
  if (!db) return null;
  try {
    await ensureTable();
    const r = await db.execute({
      sql: "SELECT ani_id, slug, title, expires_at FROM anizone_map WHERE ani_id = ?",
      args: [aniId],
    });
    const row: any = r.rows[0];
    if (!row) return null;
    const expiresAt = Number(row.expires_at);
    /* Perimee, la ligne est quand meme rendue : sur Vercel la recherche est
       refusee (403), et l'ancien slug vaut mieux que rien (cf. resolve.js). */
    const expired = expiresAt < Math.floor(Date.now() / 1000);
    return { aniId, slug: row.slug ?? null, title: row.title ?? null, expiresAt, expired };
  } catch (e: any) {
    console.warn("[anizone-map] read failed:", e?.message);
    return null;
  }
}

export async function setAnizoneMap(
  aniId: number,
  slug: string | null,
  title: string | null,
): Promise<void> {
  const db = getTursoClient();
  if (!db) return;
  const now = Math.floor(Date.now() / 1000);
  const ttl = slug ? ANIZONE_TTL_FOUND : ANIZONE_TTL_ABSENT;
  try {
    await ensureTable();
    await db.execute({
      sql: `INSERT INTO anizone_map (ani_id, slug, title, checked_at, expires_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(ani_id) DO UPDATE SET
              slug = excluded.slug, title = excluded.title,
              checked_at = excluded.checked_at, expires_at = excluded.expires_at`,
      args: [aniId, slug, title, now, now + ttl],
    });
  } catch (e: any) {
    console.warn("[anizone-map] upsert failed:", e?.message);
  }
}
