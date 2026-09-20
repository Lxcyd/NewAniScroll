/**
 * Quels animes sont DOUBLES, su a l'avance.
 *
 * MyDubList (https://mydublist.com, CC BY 4.0) agrege MyAnimeList, AniList,
 * Anime News Network, AnimeSchedule, aniSearch, Kitsu et des listes curees, et
 * publie par langue la liste des titres doubles, indexee par **id MAL** — celui
 * que le site porte deja (`idMal`). `scripts/mydublist/sync-dubs.mjs` la recopie
 * ici une fois par nuit.
 *
 * Ce que ca change. Avec l'ordre de langues « VF d'abord », ouvrir une serie
 * jamais doublee faisait essayer les lecteurs VF l'un apres l'autre — une
 * dizaine de secondes pour apprendre ce que MyDubList sait.
 *
 * Tant que la table n'a jamais ete synchronisee, elle est vide et TOUT LE MONDE
 * repasse par l'ancien chemin : une table vide ne doit jamais se lire « rien
 * n'est double », sans quoi une panne de synchronisation ferait disparaitre la
 * VF du site entier. Meme regle que `frembedCatalog`.
 *
 * Donnees : MyDubList — https://mydublist.com — CC BY 4.0.
 */

import { getTursoClient } from "./turso";

export type DubLang = "french" | "english" | "spanish" | "german" | "italian";

const TABLE = `
CREATE TABLE IF NOT EXISTS dub_catalog (
  lang        TEXT    NOT NULL,
  mal_id      INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (lang, mal_id)
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

/* Memo par lambda : quelques milliers d'entiers qui ne bougent qu'une fois par
   nuit. Sans lui, chaque sonde paierait une lecture Turso pour la meme reponse. */
const memo = new Map<string, { ids: Set<number>; at: number }>();
const enVol = new Map<string, Promise<Set<number>>>();
const MEMO_TTL_MS = 10 * 60 * 1000;

/** Les ids MAL doubles dans cette langue. Vide = liste inconnue. */
export async function getDubbedMalIds(lang: DubLang = "french"): Promise<Set<number>> {
  const hit = memo.get(lang);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.ids;
  const deja = enVol.get(lang);
  if (deja) return deja;
  const db = getTursoClient();
  if (!db) return new Set();
  const p = (async () => {
    try {
      await ensureTable();
      const r = await db.execute({
        sql: "SELECT mal_id FROM dub_catalog WHERE lang = ?",
        args: [lang],
      });
      const ids = new Set(r.rows.map((row: any) => Number(row.mal_id)));
      memo.set(lang, { ids, at: Date.now() });
      return ids;
    } catch (e: any) {
      console.warn("[dub-catalog] read failed:", e?.message);
      return new Set<number>();
    } finally {
      enVol.delete(lang);
    }
  })();
  enVol.set(lang, p);
  return p;
}
