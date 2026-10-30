#!/usr/bin/env node
/**
 * Sentinelle de parite : pour chaque anime AniList qu'anime-sama propose avec un
 * lien vidmoly VIVANT, notre player_map sert-elle EXACTEMENT ce panneau, au bon
 * decalage d'episodes ? Lit la copie (as_panneau, tools/anime-sama/copie.mjs),
 * player_map et AniList (par lots) — aucune requete au site.
 *
 * L'attente vient de l'ALIGNEMENT (tools/anime-sama/alignement.mjs) : la fiche
 * donne l'id AniList de l'oeuvre, ses saisons se remplissent avec la chaine
 * SEQUEL tant que les nombres d'episodes tombent juste.
 *
 * Chaque attente non servie est :
 *   - manquante : aucune ligne servie pour cet anime et cette langue ;
 *   - contredite : une ligne `verified` sert un autre panneau ou un autre
 *     decalage (le visiteur voit le mauvais contenu).
 * Avec --corriger=N, N attentes (tirees au sort) passent au verificateur avec
 * leur panneau attendu ; il n'ecrit que si le resolveur conclut pareil, ou —
 * avec --imposer — ecrit l'alignement quand le resolveur diverge.
 *
 *   node tools/anime-sama/parite.mjs                         rapport seul
 *   node tools/anime-sama/parite.mjs --corriger=100 [--imposer] [--dry]
 *   options : --site=https://dev.aniscroll.com (verificateur), --md=F (rapport)
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createClient } from "@libsql/client";
import {
  aligner, chaineSequel, saisonsOrdonnees,
  GENRES_HORS_SAISON, LIENS_FRANCHISE, panneauxGenre, chaineGenre,
} from "./alignement.mjs";

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
const langueMap = (l) => (l === "vostfr" ? "vostfr" : "vf"); // vf, vf1, vf2 -> vf
const sansVf = (s) => String(s || "").replace(/-vf$/, "");

const panneaux = (await db.execute(
  "SELECT slug, dossier, langue, anilist_fiche, nb_ep, nb_vivants, nb_morts FROM as_panneau",
)).rows;
const lignesMap = (await db.execute(
  "SELECT ani_id, lang, status, slug, season_dir, ep_offset FROM player_map WHERE source = 'animesama'",
)).rows;
const ligne = new Map(lignesMap.map((r) => [`${r.ani_id}:${r.lang}`, r]));

/* ── AniList par lots (50 ids par requete), niveau par niveau ───────────── */
const MEDIA = new Map();
async function chargerLot(ids) {
  ids = [...new Set(ids)].filter((i) => i && !MEDIA.has(i));
  for (let i = 0; i < ids.length; i += 50) {
    const q = `query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){id format episodes status startDate{year month day} relations{edges{relationType node{id format}}}}}}`;
    for (let essai = 0; essai < 4; essai++) {
      // Une coupure reseau (ECONNRESET, 30/10) ne doit pas tuer tout le rapport.
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
    await dors(2500); // AniList : 30 a 90 requetes / minute
  }
}

// Fiches : saisons (nb d'episodes = le panneau le plus fourni) et langues vivantes.
const fiches = new Map();
for (const p of panneaux) {
  if (!p.anilist_fiche) continue;
  const f = fiches.get(p.slug) || fiches.set(p.slug, { id: Number(p.anilist_fiche), nbEp: new Map(), vivantes: new Map() }).get(p.slug);
  f.nbEp.set(p.dossier, Math.max(f.nbEp.get(p.dossier) || 0, Number(p.nb_ep)));
  if (p.nb_vivants > 0) {
    const k = `${p.dossier}/${langueMap(p.langue)}`;
    f.vivantes.set(k, Math.max(f.vivantes.get(k) || 0, Number(p.nb_vivants)));
  }
}
let frontiere = [...new Set([...fiches.values()].map((f) => f.id))];
for (let niveau = 0; niveau < 30 && frontiere.length; niveau++) {
  await chargerLot(frontiere);
  frontiere = frontiere.map((id) => MEDIA.get(id)?.relations?.edges?.find((e) => e.relationType === "SEQUEL" && ["TV", "TV_SHORT", "ONA"].includes(e.node?.format))?.node?.id)
    .filter((id) => id && !MEDIA.has(id));
}

// Franchises (films, OAV) : parcours des relations d'histoire, niveau par niveau.
const franchise = new Map(); // slug -> Set(ids)
for (const [slug, f] of fiches) {
  if ([...f.nbEp.keys()].some((d) => GENRES_HORS_SAISON.some((g) => g.re.test(d)))) franchise.set(slug, new Set([f.id]));
}
frontiere = [...new Set([...franchise.values()].flatMap((s) => [...s]))];
for (let niveau = 0; niveau < 6 && frontiere.length; niveau++) {
  await chargerLot(frontiere);
  const suivants = [];
  for (const membres of franchise.values()) {
    for (const id of [...membres]) {
      for (const e of MEDIA.get(id)?.relations?.edges || []) {
        if (LIENS_FRANCHISE.has(e.relationType) && !membres.has(e.node.id) && membres.size < 80) {
          membres.add(e.node.id);
          suivants.push(e.node.id);
        }
      }
    }
  }
  frontiere = suivants;
}
await chargerLot([...franchise.values()].flatMap((s) => [...s]));

/* ── Attentes ─────────────────────────────────────────────────────────────── */
const attentes = []; // {id, lang, slug, dossier, decalage, complet, etat, sert}
let panneauxVivants = 0, panneauxAlignes = 0;
for (const [slug, f] of fiches) {
  const dossiers = [...f.nbEp.keys()];
  const saisons = saisonsOrdonnees(dossiers).map((d) => ({ dossier: d, nbEp: f.nbEp.get(d) }));
  const chaine = await chaineSequel(f.id, async (id) => MEDIA.get(id));
  const alignees = aligner(saisons, chaine);
  const toutes = [...alignees].map(([id, a]) => ({ id, ...a, complet: alignees.complet }));
  // Films et OAV : seulement un alignement COMPLET (le compte exact de la franchise).
  const membres = [...(franchise.get(slug) || [])].map((id) => MEDIA.get(id));
  for (const g of GENRES_HORS_SAISON) {
    const pans = panneauxGenre(dossiers, g.re).map((d) => ({ dossier: d, nbEp: f.nbEp.get(d) }));
    if (!pans.length) continue;
    const a = aligner(pans, chaineGenre(membres, g.formats));
    if (a.complet) for (const [id, x] of a) toutes.push({ id, ...x, complet: true });
  }
  const dossiersAlignes = new Set(toutes.map((a) => a.dossier));
  for (const k of f.vivantes.keys()) {
    panneauxVivants++;
    if (dossiersAlignes.has(k.split("/")[0])) panneauxAlignes++;
  }
  for (const a of toutes) {
    const id = a.id;
    for (const lang of ["vostfr", "vf"]) {
      if (!f.vivantes.has(`${a.dossier}/${lang}`)) continue;
      const r = ligne.get(`${id}:${lang}`);
      const servie = r && (r.status === "verified" || r.status === "heuristic");
      const exacte = servie && sansVf(r.slug) === slug && r.season_dir === a.dossier && Number(r.ep_offset || 0) === a.decalage;
      attentes.push({
        id, lang, slug, dossier: a.dossier, decalage: a.decalage, complet: a.complet,
        etat: exacte ? "servie" : servie ? "contredite" : "manquante",
        sert: servie ? `${r.slug}/${r.season_dir}+${r.ep_offset || 0}` : r ? r.status : "aucune ligne",
      });
    }
  }
}
/* Un meme anime attendu a DEUX endroits (un film present dans deux fiches,
   Naruto et Boruto) : on ne choisit pas, on n'attend rien. */
const parCle = new Map();
for (const a of attentes) {
  const k = `${a.id}:${a.lang}`;
  (parCle.get(k) || parCle.set(k, new Set()).get(k)).add(`${a.slug}/${a.dossier}+${a.decalage}`);
}
for (let i = attentes.length - 1; i >= 0; i--) {
  if (parCle.get(`${attentes[i].id}:${attentes[i].lang}`).size > 1) attentes.splice(i, 1);
}
const par = (e) => attentes.filter((a) => a.etat === e);
const resume = [
  `${panneauxVivants} saison(s)×langue avec un lien vidmoly vivant chez anime-sama, dont ${panneauxAlignes} alignee(s) sur AniList`,
  `${attentes.length} anime(s)×langue attendus : ${par("servie").length} servis exactement, ${par("manquante").length} manquants, ${par("contredite").length} servis sur un autre panneau ou decalage`,
];
resume.forEach((l) => console.log(l));
const morts = panneaux.reduce((a, p) => a + Number(p.nb_morts || 0), 0);
console.log(`episodes dont tous les liens vidmoly sont morts chez anime-sama : ${morts}`);

/* ── Corrections ──────────────────────────────────────────────────────────── */
const aCorriger = Number(args.corriger || 0);
// Ordre TIRE AU SORT : sinon chaque nuit reprend les memes cas, dont les echecs.
const aFaire = [...par("contredite"), ...par("manquante")].sort(() => Math.random() - 0.5).slice(0, aCorriger);
const lignesRapport = [...par("contredite"), ...par("manquante")].slice(0, 200).map((a) =>
  `| ${a.etat} | ${a.id} | ${a.lang} | ${a.slug}/${a.dossier}+${a.decalage} | ${a.sert} |`);
lignesRapport.slice(0, 30).forEach((l) => console.log(l));

if (aFaire.length) {
  console.log(`\nverification de ${aFaire.length} attente(s)…`);
  const r = spawnSync(process.execPath, [
    "scripts/player-map/verify-player-map.mjs",
    `--site=${args.site || "https://dev.aniscroll.com"}`,
    // `id:langue@slug/dossier+decalage[!]` : le panneau attendu (cf. le verificateur) ;
    // `!` = fiche alignee de bout en bout, seule a pouvoir contredire le resolveur.
    `--ids=${aFaire.map((a) => `${a.id}:${a.lang}@${a.slug}/${a.dossier}+${a.decalage}${a.complet ? "!" : ""}`).join(",")}`,
    "--source=animesama", "--concurrency=2",
    ...(args.imposer ? ["--imposer-alignement"] : []),
    ...(args.dry ? ["--dry"] : []),
  ], { stdio: "inherit", env: { ...process.env, TURSO_DATABASE_URL: env("TURSO_DATABASE_URL"), TURSO_AUTH_TOKEN: env("TURSO_AUTH_TOKEN") } });
  if (r.status) console.error(`verificateur : code ${r.status}`);
}

if (args.md) {
  fs.appendFileSync(args.md, [
    "## Parite anime-sama (lecteurs valides)", "", ...resume.flatMap((l) => [l, ""]),
    `Episodes dont tous les liens vidmoly sont morts chez eux : ${morts}`, "",
    "| etat | id AniList | langue | attendu | sert aujourd'hui |", "| --- | --: | --- | --- | --- |",
    ...lignesRapport, "",
  ].join("\n"));
}
process.exit(par("manquante").length + par("contredite").length ? 1 : 0);
