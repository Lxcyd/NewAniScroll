import { getTursoClient } from "./turso";

/**
 * episode_runtimes — duree EXACTE d'un episode SUR UN HOTE donne, une ligne par
 * (mal_id, episode, lang, host).
 *
 * Pourquoi par hote, comme `oped_host_skips` :
 *   le meme episode chez deux lecteurs est un encodage different, avec une duree
 *   differente (amorces coupees, cartons de pub, noir de fin). Mesure sur SnK
 *   ep1 : l'ED tombe a 23:55.2 sur ansembed et 24:05.7 sur vidmoly-va. Une duree
 *   unique est donc fausse pour au moins un lecteur.
 *
 * Ce que ca remplace : jusqu'ici la liste d'episodes demandait la duree a
 * AniSkip depuis le navigateur (lib/watch/episodeRuntime.ts). AniSkip renvoie le
 * `episodeLength` de l'encodage que le contributeur avait sous la main — pas
 * celui du lecteur actif — ce qui a produit des ecarts mesures (Steins;Gate 0
 * ep4 : 23:40 annonce, 23:56 reel). Et son cache etait en localStorage, donc
 * chaque visiteur repayait la mesure.
 *
 * D'ou viennent les lignes, par ordre de fiabilite (`source`) :
 *   - `player` : un vrai lecteur a lu le fichier et rapporte sa duree. C'est le
 *     fichier lui-meme : rien n'est plus sur, et c'est gratuit.
 *   - `probe`  : le script hors-ligne a resolu le flux chez l'hote et lu la
 *     duree du manifeste (scripts/runtimes/probe-runtimes.mjs).
 *   - `oped`   : recopie du `duration` deja mesure par le detecteur OP/ED.
 *
 * Peremption : AUCUN TTL, aucune empreinte de flux. Une mesure de lecteur qui
 * diverge de la ligne stockee la corrige sur-le-champ — c'est le signal exact,
 * gratuit, et il se declenche precisement quand l'hote a re-encode. Un TTL
 * aurait re-sonde a l'aveugle des milliers de cellules qui n'ont pas bouge.
 */

/** Une duree stockee. */
export interface EpisodeRuntimeRow {
  malId: number;
  episode: number;
  lang: string;
  host: string;
  seconds: number;
  source: "player" | "probe" | "oped";
  updatedAt: number; // epoch seconds
}

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS episode_runtimes (
  mal_id     INTEGER NOT NULL,
  episode    INTEGER NOT NULL,
  lang       TEXT    NOT NULL,
  host       TEXT    NOT NULL,
  seconds    REAL    NOT NULL,
  source     TEXT    NOT NULL DEFAULT 'player',
  updated_at INTEGER NOT NULL,
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
    /* non fatal — la lecture rend {} et l'appelant retombe sur AniSkip */
  }
}

/**
 * Bornes de vraisemblance. Le POST qui alimente cette table n'est pas
 * authentifie : n'importe qui peut poster un nombre. Ces bornes ne rendent pas
 * la table infalsifiable — elles ecartent le bruit et l'absurde (une duree
 * negative, un `NaN`, un fichier de 12 h). Une duree reste un CONFORT
 * d'affichage : au pire une ligne annonce une mauvaise minute, et la premiere
 * lecture reelle la corrige. Rien de ce qui compte n'en depend.
 */
export const MIN_RUNTIME_S = 60;
export const MAX_RUNTIME_S = 4 * 3600;

export function isPlausibleRuntime(seconds: unknown): seconds is number {
  const n = Number(seconds);
  return Number.isFinite(n) && n >= MIN_RUNTIME_S && n <= MAX_RUNTIME_S;
}

/**
 * Toutes les durees connues d'un anime sur UN hote : `{ episode: secondes }`.
 * Une seule requete pour la saison entiere — c'est ce qui remplace les N appels
 * AniSkip par visiteur. Rend {} sur miss / DB absente / erreur.
 */
export async function getSeasonRuntimes(
  malId: number,
  lang: string,
  host: string,
): Promise<Record<number, number>> {
  const db = getTursoClient();
  if (!db) return {};
  await ensureTable();
  try {
    const r = await db.execute({
      sql: `SELECT episode, seconds FROM episode_runtimes
            WHERE mal_id = ? AND lang = ? AND host = ?`,
      args: [malId, lang, host],
    });
    const out: Record<number, number> = {};
    for (const row of r.rows) out[Number(row.episode)] = Number(row.seconds);
    return out;
  } catch {
    return {};
  }
}

/**
 * Ecrit une duree. Dernier ecrivain gagnant : une mesure de lecteur plus recente
 * decrit forcement le fichier tel qu'il est SERVI MAINTENANT, donc elle prime
 * sur ce qui etait la — y compris sur une sonde hors-ligne plus ancienne.
 * Rend false sans rien dire en cas d'echec (l'affichage retombe sur AniSkip).
 */
export async function putRuntime(
  row: Omit<EpisodeRuntimeRow, "updatedAt"> & { updatedAt?: number },
): Promise<boolean> {
  const db = getTursoClient();
  if (!db) return false;
  await ensureTable();
  try {
    await db.execute({
      sql: `INSERT INTO episode_runtimes
              (mal_id, episode, lang, host, seconds, source, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(mal_id, episode, lang, host) DO UPDATE SET
              seconds = excluded.seconds,
              source = excluded.source,
              updated_at = excluded.updated_at`,
      args: [
        row.malId,
        row.episode,
        row.lang,
        row.host,
        row.seconds,
        row.source,
        row.updatedAt ?? Math.floor(Date.now() / 1000),
      ],
    });
    return true;
  } catch {
    return false;
  }
}
