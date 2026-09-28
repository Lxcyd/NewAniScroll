// Ajoute a une liste d'anime (format batch_detect) les coordonnees frembed de
// chaque saison : `frembed: "<tmdbTvId>:<saisonTmdb>"`, lues dans `fribb_map`.
// Lecture seule sur Turso. La saison Fribb est le point faible connu (TMDB
// fusionne ou decoupe) : elle n'est qu'un point de depart, le pont la verifie
// en demandant l'episode a frembed, et `_duration_cohort` rejette un fichier
// dont la duree ne colle pas aux autres hotes.
//
//   node --env-file=../../.env.local scratch/_frembed_coords.mjs datasets/anime.gt10.json
import fs from "node:fs";
import { createClient } from "@libsql/client";

const file = process.argv[2];
if (!file) {
  console.error("usage: _frembed_coords.mjs <liste.json>");
  process.exit(2);
}
const list = JSON.parse(fs.readFileSync(file, "utf8"));
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const ids = list.map((a) => a.anilist_id);
const r = await db.execute({
  sql: `SELECT anilist_id, tmdb_tv_id, tmdb_season FROM fribb_map
         WHERE anilist_id IN (${ids.map(() => "?").join(",")})`,
  args: ids,
});
const byId = new Map(r.rows.map((x) => [Number(x.anilist_id), x]));
for (const a of list) {
  const f = byId.get(a.anilist_id);
  const tv = f?.tmdb_tv_id != null ? Number(f.tmdb_tv_id) : null;
  const sa = f?.tmdb_season != null ? Number(f.tmdb_season) : null;
  for (const s of a.seasons) {
    if (tv && sa) s.frembed = `${tv}:${sa}`;
    else delete s.frembed;
  }
  console.log(`${String(a.mal_id).padStart(6)} ${a.slug.padEnd(32)} ${tv && sa ? `tmdb ${tv} S${sa}` : "— pas de correspondance TMDB"}`);
}
fs.writeFileSync(file, JSON.stringify(list, null, 1) + "\n");
