/**
 * Le catalogue de frembed, su a l'avance.
 *
 * Frembed publie sa liste : `GET /api/public/v1/anime` (paginee, 20 par page)
 * rend chaque titre avec son id TMDB — c'est-a-dire exactement la cle sur
 * laquelle notre resolveur l'interroge. Mesure du 20/09/2026 : **146 entrees**
 * (104 series, 42 films), soit **340 fiches AniList** une fois passees par
 * `fribb_map`.
 *
 * Ce que ca change. On essayait frembed sur TOUT, donc on payait pour presque
 * chaque anime du site une resolution qui ne pouvait pas aboutir : lecture
 * Fribb, appel a l'API frembed, sonde du CDN — 1,66 s mesurees — pour finir sur
 * « absent », et un chip qui s'allume puis s'eteint. Avec la liste, la reponse
 * est connue avant de demander quoi que ce soit.
 *
 * La liste est rafraichie par `scripts/frembed/sync-catalog.mjs` (une fois par
 * nuit, cf. .github/workflows). Tant qu'elle n'a jamais ete synchronisee, la
 * table est vide et TOUT LE MONDE repasse par l'ancien chemin : une table vide
 * ne doit jamais se lire « frembed n'a rien », sans quoi une panne de
 * synchronisation eteindrait le lecteur le plus rapide du site.
 */

import { getTursoClient } from "./turso";

export type FrembedCatalogRow = {
  anilistId: number;
  tmdbId: number;
  kind: "tv" | "movie";
};

const TABLE = `
CREATE TABLE IF NOT EXISTS frembed_catalog (
  anilist_id  INTEGER PRIMARY KEY,
  tmdb_id     INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL
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

/* Memo par lambda : la liste tient en memoire (quelques centaines d'entiers) et
   ne bouge qu'une fois par nuit. Sans lui, chaque sonde de chip paierait une
   lecture Turso pour une reponse identique. */
let memo: { ids: Set<number>; at: number } | null = null;
let enVol: Promise<Set<number>> | null = null;
const MEMO_TTL_MS = 10 * 60 * 1000;

/** Les fiches AniList que frembed peut servir. Vide = liste inconnue. */
export async function getFrembedAnilistIds(): Promise<Set<number>> {
  if (memo && Date.now() - memo.at < MEMO_TTL_MS) return memo.ids;
  if (enVol) return enVol;
  const db = getTursoClient();
  if (!db) return new Set();
  enVol = (async () => {
    try {
      await ensureTable();
      const r = await db.execute("SELECT anilist_id FROM frembed_catalog");
      const ids = new Set(r.rows.map((row: any) => Number(row.anilist_id)));
      memo = { ids, at: Date.now() };
      return ids;
    } catch (e: any) {
      console.warn("[frembed-catalog] read failed:", e?.message);
      return new Set<number>();
    } finally {
      enVol = null;
    }
  })();
  return enVol;
}

/**
 * `false` seulement quand la liste est CONNUE et ne contient pas cet anime.
 * `true` quand il y figure — et aussi quand la liste est vide, c'est-a-dire
 * quand on ne sait pas : on ne prive personne d'un lecteur sur une ignorance.
 */
export async function frembedPeutAvoir(aniId: number | string): Promise<boolean> {
  const ids = await getFrembedAnilistIds();
  if (ids.size === 0) return true;
  return ids.has(Number(aniId));
}

