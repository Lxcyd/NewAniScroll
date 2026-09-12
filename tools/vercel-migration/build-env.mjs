#!/usr/bin/env node
/**
 * Fabrique UN fichier `.env` complet : les 32 variables du projet, dans l'ordre
 * alphabetique, valeur renseignee quand on l'a, `NOM=` vide sinon.
 *
 * POURQUOI. Les variables du projet vivaient jusqu'ici a trois endroits — le
 * dashboard Vercel (illisible pour 25 d'entre elles), `.env.local` (incomplet
 * et partiellement perime), et des valeurs par defaut noyees dans le code. Il
 * n'existait aucun endroit ou lire la liste ENTIERE. C'est ce fichier.
 *
 * Une variable manquante s'ecrit `NOM=` plutot que d'etre absente : une ligne
 * vide se VOIT, une absence ne se voit pas. `import-env.mjs` saute les valeurs
 * vides — il ne poussera jamais une chaine vide, qui n'est pas la meme chose
 * qu'une variable absente (le code teste partout `if (!process.env.X)`).
 *
 * Le fichier produit est `.env` a la racine, couvert par .gitignore. Ne jamais
 * le renommer en `.env.production` : ce nom-la n'est PAS ignore.
 *
 * Usage : node tools/vercel-migration/build-env.mjs [source] [destination]
 */

import fs from "node:fs";
import path from "node:path";

const RACINE = path.resolve(import.meta.dirname, "..", "..");
const source =
  process.argv[2] || "C:/Users/Luc/aniscroll-vercel-backup/env.production.merged";
const destination = process.argv[3] || path.join(RACINE, ".env");

/** Ou retrouver chaque variable qu'on n'a pas, et ce qui casse sans elle.
 *  Ecrit dans le fichier : l'information doit voyager AVEC la ligne vide,
 *  sinon elle reste dans un README qu'on n'ouvre pas au bon moment. */
const OU_TROUVER = {
  UPSTASH_REDIS_REST_URL: "console Upstash -> base -> onglet REST API. SANS ELLE : aucun cache.",
  UPSTASH_REDIS_REST_TOKEN: "idem, meme onglet.",
  REDIS_URL:
    "idem (forme rediss://). L'ancienne valeur pointait sur stable-tahr-110008, base SUPPRIMEE — ne pas la reprendre.",
  TURSO_USERS_URL: "console Turso. Sans elle, les comptes AniScroll sont inactifs.",
  TURSO_USERS_TOKEN: "idem.",
  CF_ACCOUNT_ID: "Cloudflare -> Workers. Sans le trio CF_*, le cache KV du watch-party est muet.",
  CF_KV_NAMESPACE_ID: "Cloudflare -> Workers KV -> namespace W2G_CACHE.",
  CF_KV_API_TOKEN: "Cloudflare -> jeton avec la permission 'Workers KV Storage: Edit'.",
  ABLY_API_KEY: "console Ably. Sans elle, le watch-party perd son transport temps reel.",
  RESEND_API_KEY:
    "console Resend (regenerable). Sans elle, les liens d'inscription partent dans les logs au lieu des mails.",
};

/**
 * Variables encore declarees sur Vercel mais que PLUS AUCUN code ne lit. Les
 * reporter dans le .env ferait perdre du temps a aller chercher une valeur qui
 * ne sert a rien — c'est exactement ce qui a failli arriver avec Simkl.
 *
 * Verification : `rg "process\.env\.<NOM>"` hors .next/ et hors cet outil. Si
 * une variable reapparait dans le code, la retirer d'ici.
 */
const OBSOLETES = {
  SIMKL_CLIENT_ID:
    "Simkl a ete retire de la chaine d'episodes le 22/08/2026 (voir " +
    "pages/api/v2/episode/[id].tsx, passage v6 -> v7). Plus aucun appel, plus de cle a tenir.",
};

/** Lit un fichier d'env en Map, en ignorant commentaires et lignes vides. */
function lire(chemin) {
  const m = new Map();
  if (!fs.existsSync(chemin)) return m;
  for (const ligne of fs.readFileSync(chemin, "utf8").split(/\r?\n/)) {
    const v = ligne.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (v && v[2].trim()) m.set(v[1], v[2]);
  }
  return m;
}

/* Ce qui a deja ete rempli dans le .env existant est PRIORITAIRE sur la
   sauvegarde. Regenerer ne doit jamais effacer une valeur saisie a la main :
   c'est le seul moyen que l'outil reste utilisable apres le premier jour. */
const dejaRempli = lire(destination);

/* Recupere l'id du namespace KV depuis wrangler.toml, ou il est deja versionne.
   Aller le chercher dans une console alors qu'il est dans le depot serait une
   corvee inventee. */
const wrangler = path.join(RACINE, "worker", "wrangler.toml");
let kvNamespace = null;
if (fs.existsSync(wrangler)) {
  const m = fs.readFileSync(wrangler, "utf8").match(/binding\s*=\s*"W2G_CACHE"[\s\S]{0,200}?id\s*=\s*"([a-f0-9]+)"/);
  if (m) kvNamespace = m[1];
}

const entrees = new Map();
for (const ligne of fs.readFileSync(source, "utf8").split(/\r?\n/)) {
  const manquante = ligne.match(/^# MANQUANT ([A-Z][A-Z0-9_]*)=$/);
  if (manquante) {
    entrees.set(manquante[1], "");
    continue;
  }
  const v = ligne.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (!v) continue;
  if (/^(VERCEL|NX_|TURBO)/.test(v[1])) continue; // injectees par Vercel
  entrees.set(v[1], v[2]);
}

if (kvNamespace && !entrees.get("CF_KV_NAMESPACE_ID")) {
  entrees.set("CF_KV_NAMESPACE_ID", kvNamespace);
}
for (const [k, v] of dejaRempli) entrees.set(k, v);

for (const nom of Object.keys(OBSOLETES)) entrees.delete(nom);

const noms = [...entrees.keys()].sort();
const remplies = noms.filter((n) => entrees.get(n));
const vides = noms.filter((n) => !entrees.get(n));

const out = [
  "# AniScroll — toutes les variables d'environnement du projet.",
  "#",
  "# Genere par tools/vercel-migration/build-env.mjs. Les variables que Vercel",
  "# injecte lui-meme (VERCEL_*, TURBO_*, NX_*) n'y figurent pas : les definir",
  "# serait au mieux inutile.",
  "#",
  `# ${remplies.length} renseignees, ${vides.length} a completer (lignes vides, chacune commentee).`,
  "#",
  ...Object.entries(OBSOLETES).flatMap(([nom, raison]) => [
    `# ${nom} n'y figure PLUS : ${raison}`,
    "#",
  ]),
  "# Pour pousser ce fichier vers un projet Vercel :",
  "#   node tools/vercel-migration/import-env.mjs .env --env=production --apply",
  "# Les lignes vides sont sautees — jamais poussees comme chaine vide.",
  "",
];

for (const nom of noms) {
  const valeur = entrees.get(nom);
  if (!valeur && OU_TROUVER[nom]) out.push(`# ${OU_TROUVER[nom]}`);
  out.push(`${nom}=${valeur}`);
  if (!valeur) out.push("");
}

fs.writeFileSync(destination, out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n");
console.log(`ecrit : ${destination}`);
console.log(`  ${noms.length} variables — ${remplies.length} renseignees, ${vides.length} vides`);
console.log(`  a completer : ${vides.join(", ")}`);
