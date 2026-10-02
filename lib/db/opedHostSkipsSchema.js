/**
 * Definition UNIQUE de `oped_host_skips`, pour le site (lib/db/opedHostSkips.ts)
 * et pour l'importeur (scripts/oped/import-oped-host-skips.mjs). Jusqu'au
 * 02/10/2026 chacun avait sa copie, et celle du site ignorait `batch_id` et
 * `clock_offset`.
 *
 * L'index : la cle primaire commence par (mal_id, episode), donc lire la saison
 * d'UN lecteur parcourrait les lignes de tous les lecteurs et des deux langues
 * (x8). Turso facture les lignes lues.
 */
export const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS oped_host_skips (
  mal_id             INTEGER NOT NULL,
  episode            INTEGER NOT NULL,
  lang               TEXT    NOT NULL,
  host               TEXT    NOT NULL,
  op_start           REAL,
  op_end             REAL,
  op_votes           INTEGER,
  ed_start           REAL,
  ed_end             REAL,
  ed_from_end_start  REAL,
  ed_from_end_end    REAL,
  ed_votes           INTEGER,
  duration           REAL,
  source             TEXT    NOT NULL DEFAULT 'audio',
  confirmed_by_video INTEGER NOT NULL DEFAULT 0,
  algo_version       INTEGER NOT NULL DEFAULT 1,
  serve              INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL,
  batch_id           TEXT,
  clock_offset       REAL,
  PRIMARY KEY (mal_id, episode, lang, host)
)`;

export const INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_oped_host_skips_season
  ON oped_host_skips (mal_id, lang, host)`;

/** Colonnes ajoutees apres coup : la table existe deja en base sans elles. Un
 *  ALTER sur une colonne presente echoue, d'ou l'essai un par un. */
const ADDED_COLUMNS = ["batch_id TEXT", "clock_offset REAL"];

/** Amene la table a la definition ci-dessus. Idempotent. `db` : client libsql. */
export async function migrate(db) {
  await db.execute(CREATE_SQL);
  for (const col of ADDED_COLUMNS) {
    try {
      await db.execute(`ALTER TABLE oped_host_skips ADD COLUMN ${col}`);
    } catch {
      /* deja presente */
    }
  }
  await db.execute(INDEX_SQL);
}
