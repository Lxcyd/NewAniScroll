#!/usr/bin/env node
/**
 * Sentinelle de parite voir-anime : pour chaque anime AniList que voir-anime
 * propose avec un lien myTV VIVANT, notre player_map (source `voiranime`)
 * sert-elle EXACTEMENT cette page, au bon decalage ? Lit la copie (va_page,
 * tools/voir-anime/copie.mjs), player_map et AniList — aucune requete au site.
 *
 * L'attente vient de l'ALIGNEMENT (tools/anime-sama/alignement.mjs) : l'ancre
 * de la page (meme titre et meme date de debut sur AniList), puis la chaine
 * SEQUEL tant que les nombres d'episodes tombent juste — une page qui reunit
 * deux entrees AniList les sert toutes les deux, la seconde avec un decalage.
 * Le decalage est dans la NUMEROTATION DE LA PAGE (le site cherche l'episode
 * « numero + decalage ») : une page qui commence a 13 decale tout de 12.
 *
 *   node tools/voir-anime/parite.mjs                         rapport seul
 *   node tools/voir-anime/parite.mjs --corriger=100 [--imposer] [--dry]
 *   options : --site=https://dev.aniscroll.com (verificateur), --md=F (rapport)
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createClient } from "@libsql/client";
import { aligner, chaineSequel, suitesPossibles } from "../anime-sama/alignement.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? "1"];
}));
function env(nom) {
  if (process.env[nom]) return process.env[nom];
  try {
    const l = fs.readFileSync(new URL("../../.env", import.meta.url), "utf8").split(/\r?\n/).find((x) => x.startsWith(`${nom}=`));
    return l ? l.slice(nom.length + 1).replace(/^"|"$/g, "") : undefined;
  } catch { return undefined; }
}
const db = createClient({ url: env("TURSO_DATABASE_URL"), authToken: env("TURSO_AUTH_TOKEN") });
const dors = (ms) => new Promise((r) => setTimeout(r, ms));

const pages = (await db.execute(
  "SELECT slug, langue, anilist, num_min, num_max, nb_ep, nb_vivants, nb_morts FROM va_page",
)).rows;
const ligne = new Map((await db.execute(
  "SELECT ani_id, lang, status, slug, ep_offset, note FROM player_map WHERE source = 'voiranime'",
)).rows.map((r) => [`${r.ani_id}:${r.lang}`, r]));

/* ── AniList par lots (50 ids par requete), niveau par niveau ───────────── */
const MEDIA = new Map();
async function chargerLot(ids) {
  ids = [...new Set(ids)].filter((i) => i && !MEDIA.has(i));
  for (let i = 0; i < ids.length; i += 50) {
    const q = `query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){id format episodes status startDate{year month day} relations{edges{relationType node{id format}}}}}}`;
    for (let essai = 0; essai < 4; essai++) {
      const r = await fetch("https://graphql.anilist.co", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, variables: { ids: ids.slice(i, i + 50) } }),
        signal: AbortSignal.timeout(30000),
      }).catch(() => null);
      if (!r || r.status === 429) { await dors(30000); continue; }
      const j = await r.json().catch(() => null);
      for (const m of j?.data?.Page?.media || []) MEDIA.set(m.id, m);
      for (const id of ids.slice(i, i + 50)) if (!MEDIA.has(id)) MEDIA.set(id, null);
      break;
    }
    await dors(2500);
  }
}

/* Groupes : les pages d'une meme ancre (en general la VOSTFR et la VF). */
const groupes = new Map();
for (const p of pages) {
  if (!p.anilist || !Number(p.nb_ep)) continue;
  const g = groupes.get(Number(p.anilist)) || groupes.set(Number(p.anilist), []).get(Number(p.anilist));
  g.push(p);
}
let frontiere = [...groupes.keys()];
for (let niveau = 0; niveau < 30 && frontiere.length; niveau++) {
  await chargerLot(frontiere);
  frontiere = [...new Set(frontiere.flatMap((id) => suitesPossibles(MEDIA.get(id))))].filter((id) => id && !MEDIA.has(id));
}

/* ── Attentes ─────────────────────────────────────────────────────────────── */
const attentes = [];
let pagesVivantes = 0, pagesAlignees = 0, groupesDoubles = 0;
for (const [ancre, g] of groupes) {
  // Deux pages de la meme langue sur la meme ancre : on ne choisit pas.
  if (new Set(g.map((p) => p.langue)).size !== g.length) { groupesDoubles++; continue; }
  const debut = Math.min(...g.map((p) => Number(p.num_min)));
  const nbEp = Math.max(...g.map((p) => Number(p.num_max))) - debut + 1;
  const chaine = await chaineSequel(ancre, async (id) => MEDIA.get(id));
  const a = aligner([{ dossier: "page", nbEp }], chaine);
  const vivantes = g.filter((p) => Number(p.nb_vivants) > 0);
  pagesVivantes += vivantes.length;
  if (!a.complet) continue;
  pagesAlignees += vivantes.length;
  for (const [id, x] of a) {
    for (const p of vivantes) {
      const decalage = x.decalage + debut - 1;
      const r = ligne.get(`${id}:${p.langue}`);
      const servie = r && (r.status === "verified" || r.status === "heuristic");
      /* Exacte = la ligne d'ALIGNEMENT elle-meme : une autre ligne au meme
         slug et au decalage 0 laisse le site recalculer un decalage (cf.
         voiranimeChainOffset), donc ne garantit pas le bon episode. */
      const exacte = servie && r.slug === p.slug && Number(r.ep_offset || 0) === decalage &&
        r.status === "verified" && String(r.note || "").startsWith("verify:alignement-voir-anime");
      attentes.push({
        id, lang: p.langue, slug: p.slug, decalage,
        etat: exacte ? "servie" : servie ? "contredite" : "manquante",
        // Une AUTRE page : le visiteur voit peut-etre un autre anime. Meme page : seul le decalage est a confirmer.
        autrePage: !!(servie && r.slug !== p.slug),
        sert: servie ? `${r.slug}+${r.ep_offset || 0}` : r ? r.status : "aucune ligne",
      });
    }
  }
}
// Un meme anime attendu sur deux pages : on n'attend rien.
const parCle = new Map();
for (const a of attentes) {
  const k = `${a.id}:${a.lang}`;
  (parCle.get(k) || parCle.set(k, new Set()).get(k)).add(`${a.slug}+${a.decalage}`);
}
for (let i = attentes.length - 1; i >= 0; i--) if (parCle.get(`${attentes[i].id}:${attentes[i].lang}`).size > 1) attentes.splice(i, 1);

const par = (e) => attentes.filter((a) => a.etat === e);
const sansAncre = pages.filter((p) => !p.anilist && Number(p.nb_vivants) > 0).length;
const resume = [
  `${pagesVivantes} page(s) avec un lien myTV vivant et une ancre AniList, dont ${pagesAlignees} alignee(s) ; ${sansAncre} page(s) jouable(s) sans ancre ; ${groupesDoubles} ancre(s) portee(s) par deux pages de meme langue`,
  `${attentes.length} anime(s)×langue attendus : ${par("servie").length} servis exactement, ${par("manquante").length} manquants, ${par("contredite").length} servis sur une autre page ou un autre decalage`,
];
resume.forEach((l) => console.log(l));
const morts = pages.reduce((a, p) => a + Number(p.nb_morts || 0), 0);
console.log(`episodes dont le lien myTV est mort chez voir-anime : ${morts}`);

/* ── Corrections ──────────────────────────────────────────────────────────── */
/* Priorites : d'abord les lignes qui servent une AUTRE page (le visiteur voit
   peut-etre un autre anime, cf. Cyberpunk 2 cote anime-sama le 31/10), puis
   les autres. Au hasard dans chaque groupe : chaque nuit ne reprend pas les memes echecs. */
const auHasard = (l) => l.sort(() => Math.random() - 0.5);
const aFaire = [
  ...auHasard(attentes.filter((a) => a.autrePage)),
  ...auHasard(attentes.filter((a) => a.etat !== "servie" && !a.autrePage)),
].slice(0, Number(args.corriger || 0));
console.log(`dont ${attentes.filter((a) => a.autrePage).length} servi(s) sur une AUTRE page (corriges en premier)`);
const lignesRapport = [...par("contredite"), ...par("manquante")].slice(0, 200).map((a) =>
  `| ${a.etat} | ${a.id} | ${a.lang} | ${a.slug}+${a.decalage} | ${a.sert} |`);
lignesRapport.slice(0, 30).forEach((l) => console.log(l));
if (aFaire.length) {
  console.log(`\nverification de ${aFaire.length} attente(s)…`);
  const r = spawnSync(process.execPath, [
    "scripts/player-map/verify-player-map.mjs",
    `--site=${args.site || "https://dev.aniscroll.com"}`,
    // `id:langue@slug+decalage!` : la page attendue ; `!` = alignement complet.
    `--ids=${aFaire.map((a) => `${a.id}:${a.lang}@${a.slug}+${a.decalage}!`).join(",")}`,
    "--source=voiranime", "--concurrency=2",
    ...(args.imposer ? ["--imposer-alignement"] : []),
    ...(args.dry ? ["--dry"] : []),
  ], { stdio: "inherit", env: { ...process.env, TURSO_DATABASE_URL: env("TURSO_DATABASE_URL"), TURSO_AUTH_TOKEN: env("TURSO_AUTH_TOKEN") } });
  if (r.status) console.error(`verificateur : code ${r.status}`);
}
if (args.md) {
  fs.appendFileSync(args.md, [
    "## Parite voir-anime (myTV)", "", ...resume.flatMap((l) => [l, ""]),
    `Episodes dont le lien myTV est mort chez eux : ${morts}`, "",
    "| etat | id AniList | langue | attendu | sert aujourd'hui |", "| --- | --: | --- | --- | --- |",
    ...lignesRapport, "",
  ].join("\n"));
}
process.exit(par("manquante").length + par("contredite").length ? 1 : 0);
