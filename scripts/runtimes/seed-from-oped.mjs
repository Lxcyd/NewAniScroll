/**
 * Amorce `episode_runtimes` avec les durees que le detecteur OP/ED a DEJA
 * mesurees. ZERO appel worker, ZERO Upstash, ZERO scrape.
 *
 *   node --env-file=.env.local scripts/runtimes/seed-from-oped.mjs [--dry]
 *   node --env-file=.env.local scripts/runtimes/seed-from-oped.mjs \
 *        --in=tools/opening-detector/out/top50.jsonl [--dry]
 *
 * La duree relevee pendant la detection est la longueur de l'encodage de CE
 * host : exactement la valeur que la liste d'episodes veut afficher, deja par
 * (mal_id, episode, lang, host). Il n'y a donc rien a re-sonder pour tout ce que
 * le detecteur a couvert.
 *
 * DEUX SOURCES, parce qu'elles ne se remplissent pas en meme temps :
 *
 *   - par defaut, la table `oped_host_skips` ;
 *   - avec `--in`, le JSONL brut du lot (`per_host[host].duration`).
 *
 * Le JSONL existe des la fin du lot ; la table, elle, n'est remplie que par
 * `scripts/oped/import-oped-host-skips.mjs`, un import qui met les timings OP/ED
 * EN SERVICE pour les visiteurs. Ce sont deux decisions distinctes, et prendre
 * les durees ne doit pas obliger a prendre l'autre. Mesure du 26/08/2026 : la
 * table etait vide, le fichier `top50.jsonl` portait 979 durees.
 *
 * Une ligne `player` n'est JAMAIS ecrasee. Une mesure de lecteur decrit le
 * fichier tel qu'il est servi maintenant ; une duree de detection peut dater de
 * l'encodage precedent. La clause `WHERE … source <> 'player'` de l'upsert est
 * ce qui rend ce script rejouable sans defaire les corrections des visiteurs.
 */
import fs from "node:fs";
import readline from "node:readline";
import { createClient } from "@libsql/client";
import { DISPLAYED_HOSTS } from "../../lib/hostRegistry.js";

const DRY = process.argv.includes("--dry");
const IN =
  process.argv.find((a) => a.startsWith("--in="))?.slice(5) || null;

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

if (IN) {
  if (!fs.existsSync(IN)) {
    console.error(`[seed-runtimes] introuvable : ${IN}`);
    process.exit(2);
  }
  const rows = [];
  let lines = 0;
  let rejected = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(IN),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    lines++;
    const malId = Number(o.mal_id);
    const episode = Number(o.episode);
    const lang = String(o.lang || "");
    if (!malId || !Number.isInteger(episode) || !lang) continue;
    for (const [host, v] of Object.entries(o.per_host || {})) {
      const seconds = Number(v?.duration);
      if (!(Number.isFinite(seconds) && seconds >= MIN_S && seconds <= MAX_S)) continue;
      // Meme garantie que l'importeur OP/ED : la base ne doit contenir que des
      // lecteurs qu'un visiteur peut reellement choisir (lib/hostRegistry.js).
      if (!DISPLAYED_HOSTS.includes(host)) {
        rejected++;
        continue;
      }
      rows.push({ malId, episode, lang, host, seconds: Math.round(seconds) });
    }
  }
  console.log(
    `[seed-runtimes] ${IN} : ${lines} lignes → ${rows.length} durees` +
      (rejected ? ` (${rejected} rejetees, hote non affiche)` : ""),
  );
  const byHost = {};
  for (const r of rows) byHost[r.host] = (byHost[r.host] || 0) + 1;
  console.log(`[seed-runtimes] par hote :`, byHost);

  if (DRY) {
    console.log("[seed-runtimes] --dry : rien ecrit");
    process.exit(0);
  }

  const now = Math.floor(Date.now() / 1000);
  let written = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    await db.batch(
      chunk.map((r) => ({
        sql: `INSERT INTO episode_runtimes
                (mal_id, episode, lang, host, seconds, source, updated_at)
              VALUES (?, ?, ?, ?, ?, 'oped', ?)
              ON CONFLICT(mal_id, episode, lang, host) DO UPDATE SET
                seconds = excluded.seconds,
                source = excluded.source,
                updated_at = excluded.updated_at
              WHERE episode_runtimes.source <> 'player'`,
        args: [r.malId, r.episode, r.lang, r.host, r.seconds, now],
      })),
      "write",
    );
    written += chunk.length;
  }
  const total = await db.execute("SELECT COUNT(*) AS n FROM episode_runtimes");
  console.log(
    `[seed-runtimes] ${written} durees ecrites — episode_runtimes : ` +
      `${Number(total.rows[0].n)} lignes`,
  );
  process.exit(0);
}

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
