#!/usr/bin/env node
/**
 * Pousse un fichier d'environnement complet vers un projet Vercel.
 *
 * POURQUOI CET OUTIL EXISTE. Le 12/09/2026 la production a ete remontee sur un
 * nouveau compte Vercel. Le formulaire d'import du dashboard demande les
 * variables une par une : 32 saisies a la main, chacune une occasion de coller
 * une valeur dans le mauvais champ. Et surtout, `vercel env add` lit sa valeur
 * sur STDIN, ce qui rend la chose scriptable — mais une variable a la fois.
 *
 * CE QU'IL NE FAIT PAS. Il n'affiche jamais une valeur, ni dans son resume ni
 * dans une erreur : seulement le nom, la longueur, et le verdict. Un journal de
 * migration qui recopie les jetons est un secret de plus a effacer.
 *
 * Usage :
 *   node tools/vercel-migration/import-env.mjs <fichier> [--env=production]
 *   node tools/vercel-migration/import-env.mjs <fichier> --apply
 *
 * Sans `--apply` il ne fait RIEN : il liste ce qu'il pousserait. C'est le
 * defaut parce que l'erreur typique est de viser le mauvais projet — `vercel
 * env add` ecrit dans le projet lie au dossier courant, pas dans celui qu'on a
 * en tete. Verifier avec `vercel project ls` ou `.vercel/project.json` avant.
 */

import fs from "node:fs";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const fichier = args.find((a) => !a.startsWith("--"));
const apply = args.includes("--apply");

/* Jeton d'API. Utile quand la session de la CLI est celle d'un AUTRE compte —
   c'est le cas pendant une migration, ou l'ancien compte detient encore le
   domaine et ou se deconnecter serait irreversible sans navigateur. Se donne
   par --token=... ou par la variable VERCEL_TOKEN, que la CLI ne lit pas
   d'elle-meme. Jamais journalise. */
const tokenArg = args.find((a) => a.startsWith("--token="));
const token = tokenArg ? tokenArg.slice(8) : process.env.VERCEL_TOKEN || null;
const envArg = args.find((a) => a.startsWith("--env="));
const cibles = envArg
  ? envArg.slice(6).split(",")
  : ["production", "preview", "development"];

if (!fichier) {
  console.error("usage: import-env.mjs <fichier> [--env=production,preview] [--apply]");
  process.exit(1);
}
if (!fs.existsSync(fichier)) {
  console.error(`fichier introuvable : ${fichier}`);
  process.exit(1);
}

/** Les variables que Vercel injecte lui-meme : les pousser serait au mieux
 *  inutile, au pire un conflit au build. */
const RESERVEES = /^(VERCEL|NX_|TURBO)/;

const vars = [];
const ignorees = [];
const manquantes = [];

for (const ligne of fs.readFileSync(fichier, "utf8").split(/\r?\n/)) {
  const m = ligne.match(/^# MANQUANT ([A-Z][A-Z0-9_]*)=$/);
  if (m) {
    manquantes.push(m[1]);
    continue;
  }
  const v = ligne.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (!v) continue;
  const nom = v[1];
  let valeur = v[2].trim();
  if (
    (valeur.startsWith('"') && valeur.endsWith('"')) ||
    (valeur.startsWith("'") && valeur.endsWith("'"))
  ) {
    valeur = valeur.slice(1, -1);
  }
  if (RESERVEES.test(nom)) {
    ignorees.push(nom);
    continue;
  }
  // Une variable vide pousserait une chaine vide, qui n'est PAS la meme chose
  // qu'une variable absente : le code teste souvent `if (!process.env.X)`.
  if (!valeur) {
    manquantes.push(nom);
    continue;
  }
  if (valeur === "[SENSITIVE]") {
    manquantes.push(nom);
    continue;
  }
  vars.push({ nom, valeur });
}

console.log(`fichier      : ${fichier}`);
console.log(`environnements : ${cibles.join(", ")}`);
console.log(`a pousser    : ${vars.length}`);
if (ignorees.length) {
  console.log(`ignorees (injectees par Vercel) : ${ignorees.length}`);
}
if (manquantes.length) {
  console.log(`SANS VALEUR  : ${manquantes.join(", ")}`);
}
console.log("");

if (!apply) {
  for (const v of vars) {
    console.log(`  [simulation] ${v.nom.padEnd(30)} ${v.valeur.length} caracteres`);
  }
  console.log("\nRien n'a ete ecrit. Relancer avec --apply pour appliquer.");
  process.exit(0);
}

/**
 * Chemin API. Un jeton de portee EQUIPE n'a pas d'utilisateur derriere lui :
 * `vercel whoami` rend 404 et la CLI refuse de resoudre le projet ("Could not
 * retrieve Project Settings"), meme avec un .vercel/project.json correct.
 * L'API REST, elle, ne demande aucun utilisateur — juste le projet et l'equipe.
 * C'est donc la seule voie praticable pendant une migration entre comptes.
 */
async function pousserParApi(projet, equipe) {
  let ok = 0;
  let ko = 0;
  for (const v of vars) {
    const url =
      `https://api.vercel.com/v10/projects/${projet}/env` +
      `?upsert=true${equipe ? `&teamId=${equipe}` : ""}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          key: v.nom,
          value: v.valeur,
          type: "encrypted",
          target: cibles,
        }),
      });
      if (res.ok) {
        ok++;
        console.log(`  ok     ${v.nom.padEnd(30)} ${cibles.join(", ")}`);
      } else {
        ko++;
        const corps = await res.text();
        console.log(`  ECHEC  ${v.nom.padEnd(30)} HTTP ${res.status} — ${corps.slice(0, 120)}`);
      }
    } catch (e) {
      ko++;
      console.log(`  ECHEC  ${v.nom.padEnd(30)} ${String(e.message).slice(0, 120)}`);
    }
  }
  return { ok, ko };
}

const projetArg = args.find((a) => a.startsWith("--project="));
const equipeArg = args.find((a) => a.startsWith("--team="));

if (token && projetArg) {
  const { ok, ko } = await pousserParApi(
    projetArg.slice(10),
    equipeArg ? equipeArg.slice(7) : null,
  );
  console.log(`\n${ok} ecriture(s), ${ko} echec(s).`);
  if (manquantes.length) {
    console.log(
      `\nRappel — ${manquantes.length} variable(s) restent sans valeur :\n  ${manquantes.join("\n  ")}`,
    );
  }
  process.exit(ko ? 1 : 0);
}

let ok = 0;
let ko = 0;
for (const v of vars) {
  for (const cible of cibles) {
    // --force ecrase une variable deja presente : l'outil doit etre rejouable
    // sans qu'on ait a nettoyer entre deux essais.
    const argv = ["vercel", "env", "add", v.nom, cible, "--force"];
    if (token) argv.push(`--token=${token}`);
    const r = spawnSync("npx", argv, {
      input: v.valeur,
      encoding: "utf8",
      shell: true,
    });
    // La CLI peut recracher la ligne de commande dans une erreur d'usage, jeton
    // compris. On le masque avant toute lecture de la sortie, pas apres.
    let sortie = `${r.stdout || ""}${r.stderr || ""}`;
    if (token) sortie = sortie.split(token).join("[token masque]");
    if (r.status === 0) {
      ok++;
      console.log(`  ok     ${v.nom.padEnd(30)} ${cible}`);
    } else {
      ko++;
      // La sortie de la CLI peut contenir la valeur en cas d'erreur de parsing :
      // on n'en garde que la premiere ligne, et jamais la valeur elle-meme.
      const raison = sortie.split("\n").find((l) => /error|Error/.test(l)) || `code ${r.status}`;
      console.log(`  ECHEC  ${v.nom.padEnd(30)} ${cible} — ${raison.slice(0, 120)}`);
    }
  }
}

console.log(`\n${ok} ecriture(s), ${ko} echec(s).`);
if (manquantes.length) {
  console.log(
    `\nRappel — ${manquantes.length} variable(s) restent sans valeur et devront ` +
      `etre recuperees a leur source :\n  ${manquantes.join("\n  ")}`,
  );
}
process.exit(ko ? 1 : 0);
