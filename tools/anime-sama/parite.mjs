#!/usr/bin/env node
/**
 * Sentinelle de parite : « anime-sama a un lien vidmoly VIVANT pour cette saison
 * et cette langue » contre « notre player_map la sert ». Lit la copie
 * (as_panneau, tools/anime-sama/copie.mjs) et player_map — aucune requete au site.
 *
 * Chaque ecart est rattache a un anime AniList : la fiche anime-sama donne l'id
 * de l'oeuvre ; pour « Saison N », on suit N-1 aretes SEQUEL (formats TV) sur
 * AniList. Avec --corriger, ces ids passent au verificateur
 * (scripts/player-map/verify-player-map.mjs), qui re-derive avec le resolveur du
 * jour : un mauvais rattachement ne peut donc rien casser, il ne verifie juste pas.
 *
 *   node tools/anime-sama/parite.mjs                    rapport seul
 *   node tools/anime-sama/parite.mjs --corriger=100     + verification de 100 ids au plus
 *   options : --site=https://dev.aniscroll.com (verificateur), --md=F (rapport)
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createClient } from "@libsql/client";

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

const panneaux = (await db.execute(
  "SELECT slug, dossier, langue, libelle, anilist_fiche, nb_ep, nb_vivants, nb_morts FROM as_panneau",
)).rows;
const map = (await db.execute(
  "SELECT ani_id, lang, status, slug, season_dir FROM player_map WHERE source = 'animesama'",
)).rows;

// Ce que nous servons : (slug, dossier, langue de player_map).
const servi = new Set(
  map.filter((r) => r.status === "verified" || r.status === "heuristic")
    .map((r) => `${r.slug}/${r.season_dir}/${r.lang}`),
);
const langueMap = (l) => (l === "vostfr" ? "vostfr" : "vf"); // vf, vf1, vf2 -> vf

// Une langue VF peut vivre sous vf, vf1 ou vf2 : on regroupe par langue de player_map.
const attendu = new Map(); // cle slug/dossier/lang -> panneau (le plus fourni)
for (const p of panneaux) {
  if (!p.nb_vivants) continue;
  const cle = `${p.slug}/${p.dossier}/${langueMap(p.langue)}`;
  if (!attendu.has(cle) || attendu.get(cle).nb_vivants < p.nb_vivants) attendu.set(cle, p);
}
const ecarts = [...attendu.entries()].filter(([cle]) => !servi.has(cle)).map(([, p]) => p);

/* ── Rattachement a un anime AniList ─────────────────────────────────────── */
const SUITES = new Map();
async function suite(id) {
  if (SUITES.has(id)) return SUITES.get(id);
  const q = `query($id:Int){Media(id:$id,type:ANIME){relations{edges{relationType node{id format}}}}}`;
  for (let essai = 0; essai < 3; essai++) {
    const r = await fetch("https://graphql.anilist.co", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, variables: { id } }),
    });
    if (r.status === 429) { await dors(30000); continue; }
    const j = await r.json().catch(() => null);
    const s = j?.data?.Media?.relations?.edges?.find(
      (e) => e.relationType === "SEQUEL" && ["TV", "TV_SHORT", "ONA"].includes(e.node?.format),
    )?.node?.id || null;
    SUITES.set(id, s);
    await dors(1500); // AniList : 30 a 90 requetes / minute
    return s;
  }
  return null;
}
async function rattacher(p) {
  const n = Number(p.dossier.match(/^saison(\d+)$/)?.[1]);
  if (!p.anilist_fiche || !n) return null; // films, OAV, saisons speciales : rapport seul
  let id = p.anilist_fiche;
  for (let i = 1; i < n && id; i++) id = await suite(id);
  return id;
}

const aCorriger = Number(args.corriger || 0);
const lignes = [];
const ids = new Set();
for (const p of ecarts) {
  const id = ids.size < aCorriger ? await rattacher(p) : null;
  if (id) ids.add(id);
  lignes.push(`| ${p.slug} | ${p.dossier} | ${langueMap(p.langue)} | ${p.nb_vivants}/${p.nb_ep} | ${p.anilist_fiche ?? "?"} | ${id ?? ""} |`);
}

const resume = `${attendu.size} saison(s)×langue avec un lien vidmoly vivant chez anime-sama ; ${attendu.size - ecarts.length} servie(s), ${ecarts.length} ecart(s)`;
console.log(resume);
const morts = panneaux.reduce((a, p) => a + Number(p.nb_morts || 0), 0);
console.log(`episodes dont tous les liens vidmoly sont morts chez anime-sama : ${morts}`);
lignes.slice(0, 30).forEach((l) => console.log(l));

if (ids.size) {
  console.log(`\nverification de ${ids.size} anime(s)…`);
  const r = spawnSync(process.execPath, [
    "scripts/player-map/verify-player-map.mjs",
    `--site=${args.site || "https://dev.aniscroll.com"}`,
    `--ids=${[...ids].join(",")}`, "--concurrency=2",
  ], { stdio: "inherit", env: { ...process.env, TURSO_DATABASE_URL: env("TURSO_DATABASE_URL"), TURSO_AUTH_TOKEN: env("TURSO_AUTH_TOKEN") } });
  if (r.status) console.error(`verificateur : code ${r.status}`);
}

if (args.md) {
  fs.writeFileSync(args.md, [
    "## Parite anime-sama (lecteurs valides)", "", resume, "",
    `Episodes dont tous les liens vidmoly sont morts chez eux : ${morts}`, "",
    "| slug | saison | langue | vivants | id fiche | id verifie |", "| --- | --- | --- | --: | --: | --: |",
    ...lignes, "",
  ].join("\n"));
}
process.exit(ecarts.length ? 1 : 0);
