#!/usr/bin/env node
/**
 * UN SEUL POSTE, DEUX COMPTES VERCEL.
 *
 * Depuis le 12/09/2026 le projet vit sur deux comptes : la production et la
 * dev, chacun avec son propre palier gratuit. Le CLI Vercel ne garde qu'UNE
 * session a la fois dans `~/.vercel`, donc se connecter a l'un deconnectait
 * l'autre — et on l'a paye : la session de l'ancien compte est morte en cours
 * de migration, au moment precis ou il fallait encore y lire des choses.
 *
 * Le CLI expose pourtant ce qu'il faut :
 *
 *     -Q DIR, --global-config=DIR    Path to the global `.vercel` directory
 *
 * Un repertoire de session PAR COMPTE, et les deux connexions coexistent
 * indefiniment. Ce script ne fait qu'une chose : injecter le bon repertoire,
 * plus les identifiants de projet, pour qu'on n'ait jamais a s'en souvenir.
 *
 * PREMIERE FOIS, une fois par compte, dans un vrai terminal (ca ouvre un
 * navigateur, donc un agent ne peut pas le faire) :
 *
 *     node tools/vercel/vc.mjs prod login
 *     node tools/vercel/vc.mjs dev  login
 *
 * ENSUITE, tout le reste marche sans rien redemander :
 *
 *     node tools/vercel/vc.mjs prod ls
 *     node tools/vercel/vc.mjs dev  env ls
 *     node tools/vercel/vc.mjs prod whoami
 *
 * POURQUOI PAS DES JETONS. On aurait pu passer `--token` a chaque appel. Mais
 * un jeton doit etre stocke quelque part, et il a fini par etre colle dans une
 * conversation — donc expose, donc a revoquer. Une session par repertoire ne
 * transite nulle part : elle est posee une fois, a la main, par la personne
 * qui possede le compte.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RACINE = path.resolve(import.meta.dirname, "..", "..");
const CONFIG = path.join(RACINE, "tools", "vercel", "comptes.json");

/* Les identifiants de projet et d'equipe ne sont PAS des secrets : ce sont des
   identifiants, pas des cles. Ils sont donc versionnes, pour qu'un clone frais
   sache a quoi il parle sans avoir a redecouvrir. Les SESSIONS, elles, vivent
   hors du depot. */
const comptes = fs.existsSync(CONFIG)
  ? JSON.parse(fs.readFileSync(CONFIG, "utf8"))
  : {};

const [compte, ...args] = process.argv.slice(2);

if (!compte || !comptes[compte]) {
  const connus = Object.keys(comptes).join(", ") || "(aucun — comptes.json absent)";
  console.error(`usage : node tools/vercel/vc.mjs <compte> <commande vercel...>`);
  console.error(`comptes connus : ${connus}`);
  console.error(`\nexemples :`);
  console.error(`  node tools/vercel/vc.mjs prod login`);
  console.error(`  node tools/vercel/vc.mjs dev  ls`);
  process.exit(1);
}

const c = comptes[compte];
// Hors du depot : une session dans le repertoire de travail finirait un jour
// par etre commitee ou effacee par un `git clean`.
const sessionDir = path.join(os.homedir(), `.vercel-aniscroll-${compte}`);
fs.mkdirSync(sessionDir, { recursive: true });

/* VERCEL_ORG_ID / VERCEL_PROJECT_ID priment sur le `.vercel/project.json` du
   dossier, qui ne peut designer qu'UN projet. Sans ca, une commande lancee sur
   le compte dev irait ecrire dans le projet de prod — l'erreur exacte qu'on
   veut rendre impossible. */
const env = { ...process.env };
if (c.orgId) env.VERCEL_ORG_ID = c.orgId;
if (c.projectId) env.VERCEL_PROJECT_ID = c.projectId;

const complets = ["vercel", "--global-config", sessionDir, ...args];
if (c.scope && !args.includes("--scope") && args[0] !== "login") {
  complets.splice(3, 0, "--scope", c.scope);
}

console.error(`[vc] compte=${compte} session=${sessionDir}`);
const r = spawnSync("npx", complets, { stdio: "inherit", shell: true, env });
process.exit(r.status ?? 1);
