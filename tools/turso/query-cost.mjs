#!/usr/bin/env node
// LE COÛT DES REQUÊTES CHAUDES, MESURÉ — et un plafond par requête.
//
//   node tools/turso/query-cost.mjs          (lit .env / .env.local)
//
// Pourquoi (22/10/2026) : la requête des comptes d'illustrations du studio
// lisait 105 008 lignes par appel au lieu de ~1 000 — SQLite avait choisi
// l'index des étiquettes NSFW plutôt que celui de l'anime. Le code était
// juste, le plan ne l'était pas : 283 M de lignes en une semaine, 80 % du
// quota Turso du mois. Un test qui lit le code ne voit pas ça ; un test qui
// MESURE, si.
//
// Chaque cas reprend la requête telle que le code l'envoie, sur les animés les
// plus populaires (le pire cas : le plus d'images), et mesure `rows_read` par
// l'API HTTP de Turso. Au-dessus du plafond : sortie 1.
//
// Le SQL est COPIÉ ici, faute de pouvoir importer le TypeScript du site depuis
// un script nu. Pour que la copie ne dérive pas en silence, chaque cas nomme
// un fragment qui doit se trouver dans son fichier source : le changer là-bas
// fait échouer le test ici, et rappelle de mettre ce cas à jour.
//
// Coût d'une exécution : ~71 000 lignes lues (0,014 % du quota mensuel).
// Sans identifiants Turso (fork, clone neuf) : rien n'est mesuré, sortie 0.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, queryCost, DATABASES } from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
loadEnv();

const missing = ["cache", "fanarts"].filter((k) => !process.env[DATABASES[k].url] || !process.env[DATABASES[k].token]);
if (missing.length) {
  console.log(`query-cost: identifiants Turso absents (${missing.join(", ")}) — rien à mesurer.`);
  process.exit(0);
}

/* Les animés de test : les plus populaires du cache, ceux qui ont le plus
   d'images — le pire cas d'une vraie liste. */
const top = await (async () => {
  const base = process.env.TURSO_DATABASE_URL.replace(/^libsql:/, "https:").replace(/\/$/, "");
  const r = await fetch(`${base}/v2/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TURSO_AUTH_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      requests: [
        { type: "execute", stmt: { sql: "SELECT id FROM anime WHERE popularity IS NOT NULL ORDER BY popularity DESC LIMIT 200" } },
        { type: "close" },
      ],
    }),
  }).then((x) => x.json());
  return r.results[0].response.result.rows.map((row) => Number(row[0].value));
})();
const ONE = top[0];
const ph = (n) => Array.from({ length: n }, () => "?").join(",");
const SAFE = ["safe", "safe-skipped", "manual-safe"];
/* Le score de lib/wallhaven/criteres.js (sqlScore) : sa forme compte pour le
   plan, pas ses coefficients exacts. */
const SCORE = `(w.favorites * CASE WHEN w.source IS NOT NULL AND w.source <> '' THEN 1.3 ELSE 1.0 END * CASE WHEN w.facet_type = 'illustration' THEN 1.2 ELSE 1.0 END)`;
const OK = "(w.serie_ok IS NULL OR w.serie_ok = 1)";

const CASES = [
  {
    name: "galerie fanart.tv d'un anime (loadFanarts)",
    db: "fanarts",
    source: ["lib/db/fanarts.ts", "AND +nsfw_label IN (${placeholders})"],
    sql: `SELECT type, url, language, likes, season, nsfw_label, nsfw_score FROM anime_fanarts
           WHERE anime_id = ? AND +nsfw_label IN (${ph(3)}) AND likes >= ? ORDER BY type, likes DESC`,
    args: [ONE, ...SAFE, 0],
    max: 3_000,
  },
  {
    name: "comptes fanart.tv de 200 animés (art-counts)",
    db: "fanarts",
    source: ["lib/db/fanarts.ts", "AND +nsfw_label IN ('safe', 'safe-skipped', 'manual-safe')"],
    sql: `SELECT anime_id, type, language FROM anime_fanarts
           WHERE anime_id IN (${ph(200)}) AND +nsfw_label IN ('safe', 'safe-skipped', 'manual-safe')`,
    args: top,
    max: 40_000,
  },
  {
    name: "comptes Wallhaven de 200 animés (art-counts)",
    db: "fanarts",
    source: ["lib/db/wallhavenImages.ts", "WHERE w.anime_id IN (${ids.map(() => \"?\").join(\",\")})"],
    sql: `WITH classe AS (
            SELECT w.anime_id, ${SCORE} AS points,
                   ROW_NUMBER() OVER (PARTITION BY w.anime_id ORDER BY ${SCORE} DESC, w.wh_id) AS rang
              FROM wallhaven_image w
             WHERE w.anime_id IN (${ph(200)}) AND w.width >= ? AND w.height >= ? AND ${OK})
          SELECT anime_id, COUNT(*) AS tout FROM classe WHERE points >= ? AND rang <= ? GROUP BY anime_id`,
    args: [...top, 1920, 1080, 1, 60],
    /* 57 001 mesurées le 22/10/2026 sur les 200 plus populaires : le bon
       index, mais ~285 images par titre à classer. Le plafond garde la marge
       d'un catalogue qui grossit, et attrape un balayage (126 000+). */
    max: 100_000,
  },
  {
    name: "galerie Wallhaven d'un anime",
    db: "fanarts",
    source: ["lib/db/wallhavenImages.ts", "WHERE w.anime_id = ?"],
    sql: `SELECT w.wh_id, w.path, w.thumb FROM wallhaven_image w
           WHERE w.anime_id = ? AND w.width >= ? AND w.height >= ? AND ${OK}
           ORDER BY ${SCORE} DESC, w.wh_id LIMIT 60`,
    args: [ONE, 1920, 1080],
    max: 3_000,
  },
  {
    name: "cache TMDB de 200 animés (art-counts)",
    db: "fanarts",
    source: ["lib/tmdb/artworksCache.ts", "WHERE cache_key IN ("],
    sql: `SELECT cache_key, value, updated_at FROM tmdb_images_cache WHERE cache_key IN (${ph(200)})`,
    args: top.map(String),
    max: 1_000,
  },
  {
    name: "fiche d'un anime (getAnime)",
    db: "cache",
    source: ["lib/db/anime.ts", "FROM anime WHERE id = ?"],
    sql: "SELECT data FROM anime WHERE id = ?",
    args: [ONE],
    max: 10,
  },
  {
    name: "rangée « populaires » (listAnime)",
    db: "cache",
    source: ["lib/db/anime.ts", 'orderBy: "popularity DESC NULLS LAST"'],
    sql: "SELECT data FROM anime WHERE is_adult = 0 AND data IS NOT NULL ORDER BY popularity DESC NULLS LAST LIMIT 15",
    max: 500,
  },
  {
    name: "rangée « tendances » (listAnime)",
    db: "cache",
    source: ["lib/db/anime.ts", "where: \"AND status = 'RELEASING'\""],
    sql: "SELECT data FROM anime WHERE is_adult = 0 AND data IS NOT NULL AND status = 'RELEASING' ORDER BY popularity DESC NULLS LAST LIMIT 15",
    max: 3_000,
  },
  {
    name: "rangée « mieux notés » (listAnime)",
    db: "cache",
    source: ["lib/db/anime.ts", 'orderBy: "average_score DESC NULLS LAST"'],
    sql: "SELECT data FROM anime WHERE is_adult = 0 AND data IS NOT NULL ORDER BY average_score DESC NULLS LAST LIMIT 15",
    max: 500,
  },
  {
    name: "recherche, préfixe court « na » (searchAnime)",
    db: "cache",
    source: ["lib/db/anime.ts", "WHERE anime_fts MATCH ?"],
    sql: `SELECT a.data FROM (SELECT rowid FROM anime_fts WHERE anime_fts MATCH ? ORDER BY rank LIMIT ?) f
            JOIN anime a ON a.id = f.rowid ORDER BY a.popularity DESC NULLS LAST LIMIT ?`,
    args: ['"na"*', 60, 20],
    max: 5_000,
  },
  {
    name: "bandes-annonces de 200 animés (anime.ts)",
    db: "cache",
    source: ["lib/db/anime.ts", "json_extract(data, '$.trailer.id')   AS tid"],
    sql: `SELECT id, json_extract(data, '$.trailer.id') AS tid, json_extract(data, '$.trailer.site') AS site
            FROM anime WHERE id IN (${ph(200)})`,
    args: top,
    max: 1_000,
  },
  {
    name: "personnages d'un anime (anime_characters)",
    db: "cache",
    source: ["lib/db/animeCharacters.ts", "SELECT total, complete, data FROM anime_characters WHERE ani_id = ?"],
    sql: "SELECT total, complete, data FROM anime_characters WHERE ani_id = ?",
    args: [ONE],
    max: 10,
  },
  {
    name: "comptes de personnages de 200 animés (character-counts)",
    db: "cache",
    source: ["lib/db/animeCharacters.ts", "SELECT ani_id, with_image, total, complete FROM anime_characters"],
    sql: `SELECT ani_id, with_image, total, complete FROM anime_characters WHERE ani_id IN (${ph(200)})`,
    args: top,
    /* 400 mesurées le 24/10/2026. */
    max: 1_000,
  },
  {
    name: "musiques AniPlaylist d'un anime (anisongs)",
    db: "cache",
    source: ["lib/db/aniplaylistSongs.ts", "SELECT data FROM aniplaylist_songs WHERE ani_id = ?"],
    sql: "SELECT data FROM aniplaylist_songs WHERE ani_id = ?",
    args: [ONE],
    max: 10,
  },
  {
    name: "musiques AniPlaylist de 100 animés (theme-counts)",
    db: "cache",
    source: ["lib/db/aniplaylistSongs.ts", "SELECT ani_id, data FROM aniplaylist_songs WHERE n > 0 AND ani_id IN ("],
    sql: `SELECT ani_id, data FROM aniplaylist_songs WHERE n > 0 AND ani_id IN (${ph(100)})`,
    args: top.slice(0, 100),
    max: 500,
  },
  {
    name: "lecteurs d'un anime (player_map)",
    db: "cache",
    source: ["lib/db/playerMap.ts", "FROM player_map"],
    sql: "SELECT * FROM player_map WHERE ani_id = ?",
    args: [ONE],
    max: 50,
  },
  {
    name: "correspondance TMDB d'un anime (fribb_map)",
    db: "cache",
    source: ["lib/fribb/fribbMap.ts", "FROM fribb_map WHERE anilist_id = ? LIMIT 1"],
    sql: "SELECT * FROM fribb_map WHERE anilist_id = ? LIMIT 1",
    args: [ONE],
    max: 10,
  },
];

let failed = 0;
const fmt = (n) => Number(n).toLocaleString("en-US");
for (const c of CASES) {
  const [file, fragment] = c.source;
  let src = "";
  try {
    src = readFileSync(join(ROOT, file), "utf8");
  } catch {}
  if (!src.includes(fragment)) {
    console.log(`✗ ${c.name} — la requête a changé dans ${file} (fragment introuvable : ${fragment}) : mettre ce cas à jour`);
    failed++;
    continue;
  }
  try {
    const { rowsRead } = await queryCost(c.db, c.sql, c.args ?? []);
    const ok = rowsRead <= c.max;
    if (!ok) failed++;
    console.log(`${ok ? "✓" : "✗"} ${c.name} — ${fmt(rowsRead)} lignes lues (plafond ${fmt(c.max)})`);
  } catch (e) {
    console.log(`✗ ${c.name} — erreur : ${e.message}`);
    failed++;
  }
}
if (failed) {
  console.log(`\n${failed} requête(s) hors plafond. EXPLAIN QUERY PLAN dessus : un « SCAN » ou le mauvais index (cf. le + de lib/db/fanarts.ts).`);
  process.exit(1);
}
console.log("\nToutes les requêtes chaudes sont sous leur plafond.");
