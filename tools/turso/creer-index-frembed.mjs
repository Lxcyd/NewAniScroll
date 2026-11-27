/**
 * Les deux index qui manquent a la requete de lib/db/frembedCatalog.ts
 * (`getFrembedAnilistIds`), mesures avant et apres.
 *
 * Pourquoi (27/11/2026) : le controle `query-cost.yml` echoue depuis le 24/11 :
 * 29 919 lignes lues par appel (plafond 5 000), faute d'index sur
 * `fribb_map.tmdb_movie_id` — la jointure cote films parcourt toute la table.
 * Les definitions existent dans scripts/cache/refresh-fribb.mjs et
 * scripts/frembed/sync-catalog.mjs, mais ces taches tournent sur `main`, ou
 * elles ne sont pas encore : les index n'ont jamais ete crees.
 *
 *   node tools/turso/creer-index-frembed.mjs
 *
 * Sans danger a relancer (IF NOT EXISTS). Cout : la creation lit une fois
 * fribb_map (~21 000 lignes) et frembed_probe.
 */
import { loadEnv, queryCost } from "./lib.mjs";

loadEnv();
const Q = `SELECT f.anilist_id FROM frembed_probe p
  JOIN fribb_map f ON f.tmdb_tv_id = p.tmdb_id WHERE p.hosted = 1 AND p.kind = 'tv'
  UNION
  SELECT f.anilist_id FROM frembed_probe p
  JOIN fribb_map f ON f.tmdb_movie_id = p.tmdb_id WHERE p.hosted = 1 AND p.kind = 'movie'`;

const avant = await queryCost("cache", Q);
console.log(`avant : ${avant.rowsRead} lignes lues (${avant.rows} titres)`);
for (const sql of [
  "CREATE INDEX IF NOT EXISTS idx_fribb_tmdb_movie ON fribb_map(tmdb_movie_id)",
  "CREATE INDEX IF NOT EXISTS idx_frembed_probe_hosted ON frembed_probe(kind, tmdb_id) WHERE hosted = 1",
]) {
  const r = await queryCost("cache", sql);
  console.log(`${sql.split(" ")[5]} : cree (${r.rowsRead} lignes lues)`);
}
const apres = await queryCost("cache", Q);
console.log(`apres : ${apres.rowsRead} lignes lues (${apres.rows} titres) — plafond du controle : 5 000`);
