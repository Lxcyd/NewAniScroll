/**
 * Amorce `episode_runtimes` avec les durees que le detecteur OP/ED a DEJA
 * mesurees. ZERO appel worker, ZERO Upstash, ZERO scrape — une requete Turso.
 *
 *   node --env-file=.env.local scripts/runtimes/seed-from-oped.mjs [--dry]
 *
 * `oped_host_skips.duration` est la longueur de l'encodage de CE host, relevee
 * pendant la detection : exactement la valeur que la liste d'episodes veut
 * afficher, deja par (mal_id, episode, lang, host). Il n'y a donc rien a
 * re-sonder pour tout ce que le detecteur a couvert — c'est gratuit et immediat.
 *
 * Une ligne `player` n'est JAMAIS ecrasee. Une mesure de lecteur decrit le
 * fichier tel qu'il est servi maintenant ; une duree de detection peut dater de
 * l'encodage precedent. La clause `WHERE … source <> 'player'` de l'upsert est
 * ce qui rend ce script rejouable sans defaire les corrections des visiteurs.
 */
import { createClient } from "@libsql/client";

const DRY = process.argv.includes("--dry");

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Memes bornes que lib/db/episodeRuntimes.ts : une duree hors de ces clous
// decrit autre chose qu'un episode.
const MIN_S = 60;
const MAX_S = 4 * 3600;

await db.execute(`
CREATE TABLE IF NOT EXISTS episode_runtimes (
  mal_id     INTEGER NOT NULL,
  episode    INTEGER NOT NULL,
  lang       TEXT    NOT NULL,
  host       TEXT    NOT NULL,
  seconds    REAL    NOT NULL,
  source     TEXT    NOT NULL DEFAULT 'player',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (mal_id, episode, lang, host)
)`);

const candidates = await db.execute({
  sql: `SELECT COUNT(*) AS n FROM oped_host_skips
         WHERE duration IS NOT NULL AND duration >= ? AND duration <= ?`,
  args: [MIN_S, MAX_S],
});
const n = Number(candidates.rows[0]?.n ?? 0);
console.log(`[seed-runtimes] ${n} durees exploitables dans oped_host_skips`);

if (DRY) {
  console.log("[seed-runtimes] --dry : rien ecrit");
  process.exit(0);
}

const before = await db.execute("SELECT COUNT(*) AS n FROM episode_runtimes");

await db.execute({
  sql: `INSERT INTO episode_runtimes
          (mal_id, episode, lang, host, seconds, source, updated_at)
        SELECT mal_id, episode, lang, host, ROUND(duration), 'oped', updated_at
          FROM oped_host_skips
         WHERE duration IS NOT NULL AND duration >= ? AND duration <= ?
        ON CONFLICT(mal_id, episode, lang, host) DO UPDATE SET
          seconds = excluded.seconds,
          source = excluded.source,
          updated_at = excluded.updated_at
        WHERE episode_runtimes.source <> 'player'`,
  args: [MIN_S, MAX_S],
});

const after = await db.execute("SELECT COUNT(*) AS n FROM episode_runtimes");
console.log(
  `[seed-runtimes] episode_runtimes : ${Number(before.rows[0].n)} → ` +
    `${Number(after.rows[0].n)} lignes`,
);
