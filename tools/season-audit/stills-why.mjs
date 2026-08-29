/**
 * Pourquoi tel titre n'a-t-il pas les vignettes de TMDB ?
 *   node stills.mjs <anilistId> <nbEpisodesAffiches>
 * Fait tourner le VRAI resolveur et imprime son verdict, puis compare a ani.zip.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

for (const ligne of readFileSync(".env.local", "utf8").split("\n")) {
  const m = ligne.match(/^([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const jiti = createRequire(import.meta.url)("jiti")(process.cwd(), {
  interopDefault: true,
  alias: { "@": process.cwd() },
});

const id = Number(process.argv[2]);
const affiches = Number(process.argv[3]);

const { getFribbEntry, getFribbFranchise, isFribbGroupConsistent } =
  jiti("./lib/fribb/fribbMap.ts");
const { getSeasonEpisodes, tmdbEnabled } = jiti("./lib/tmdb/client.ts");
const { fillStillGaps } = jiti("./lib/tmdb/episodeStills.ts");
const { getAniZipEpisodes } = jiti("./lib/anizip/episodes.ts");

console.log("cle TMDB presente :", tmdbEnabled());
const entree = await getFribbEntry(id);
console.log("fribb :", entree ? { tv: entree.tmdbTvId, saison: entree.tmdbSeason } : "aucune");
if (entree?.tmdbTvId) {
  const groupe = await getFribbFranchise(entree.tmdbTvId);
  console.log("franchise fribb :", groupe.length, "entrees, coherente :",
    groupe.length > 1 ? isFribbGroupConsistent(groupe) : "n/a (une seule)");
  if (entree.tmdbSeason != null) {
    const eps = await getSeasonEpisodes(entree.tmdbTvId, entree.tmdbSeason);
    console.log("saison TMDB :", eps ? eps.length + " episodes" : "ERREUR/404",
      "| affiches :", affiches, "| plancher franchi :", eps ? eps.length >= affiches : "n/a");
  }
}

const anizip = await getAniZipEpisodes(id, affiches).catch((e) => ({ stills: {}, titles: {}, err: String(e) }));
console.log("ani.zip :", Object.keys(anizip.stills || {}).length, "vignettes");
const { stills, hd } = await fillStillGaps(id, affiches, { ...anizip.stills });
for (const n of [1, 2, 3]) {
  console.log(`  ep${n}  ani.zip=${(anizip.stills || {})[n] || "-"}`);
  console.log(`        rendu  =${stills[n] || "-"}`);
  console.log(`        hd     =${hd[n] || "-"}`);
}
process.exit(0);
