#!/usr/bin/env node
/**
 * Publie les fonds animés (lib/profile/fonds.json) sur Cloudflare Pages,
 * projet `aniscroll-fonds`, servi sous https://fonds.aniscroll.com.
 *
 * Pourquoi Pages et pas R2 (24/10/2026) : R2 exige une carte bancaire même
 * pour l'offre gratuite. Pages est gratuit sans carte, bande passante
 * illimitée, même compte Cloudflare que proxy.aniscroll.com. Limite : 25 Mio
 * par fichier (vérifiée ici avant l'envoi) et 20 000 fichiers.
 *
 * usage :
 *   node scripts/fonds/deploy-pages.mjs <dossier>        # ex. C:/Users/Luc/Downloads/aniscroll-fonds
 *   node scripts/fonds/deploy-pages.mjs <dossier> --dry  # contrôle sans envoyer
 *
 * Seuls les fichiers nouveaux ou modifiés repartent (Pages compare les
 * empreintes). Le projet est créé s'il manque. Le domaine fonds.aniscroll.com
 * se branche une fois, au tableau de bord : Pages > aniscroll-fonds > Custom
 * domains (le DNS est posé tout seul, la zone est sur ce compte).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [dir] = process.argv.slice(2);
const DRY = process.argv.includes("--dry");
if (!dir) {
  console.error("usage : node scripts/fonds/deploy-pages.mjs <dossier> [--dry]");
  process.exit(1);
}
const PROJET = "aniscroll-fonds";
const MAX = 25 * 1024 * 1024;
const WORKER = resolve("worker"); // le wrangler connecté du dépôt

// 1. Tout le catalogue est là, et rien ne dépasse la limite de Pages.
const catalogue = JSON.parse(readFileSync("lib/profile/fonds.json", "utf8"));
const cles = catalogue.flatMap((f) => [f.file, f.poster, ...(f.thumb ? [f.thumb] : [])]);
let total = 0;
const tropGros = [];
for (const k of cles) {
  const s = statSync(join(dir, k)).size; // lève si un fichier manque
  total += s;
  if (s > MAX) tropGros.push(`${k} (${(s / 1048576).toFixed(1)} Mio)`);
}
console.log(`${cles.length} fichiers, ${(total / 1e6).toFixed(0)} Mo`);
if (tropGros.length) {
  console.error(`au-dessus de 25 Mio, Pages refusera :\n  ${tropGros.join("\n  ")}\nRecompresser (CRF plus haut) — jamais raccourcir.`);
  process.exit(1);
}
if (DRY) process.exit(0);

// 2. Les en-têtes : lecture depuis le site (CORS, Range pour la lecture vidéo)
// et un an de cache — un fond ne change jamais sous le même nom.
writeFileSync(
  join(dir, "_headers"),
  `/*
  Access-Control-Allow-Origin: *
  Access-Control-Allow-Headers: Range
  Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges
  Cache-Control: public, max-age=31536000, immutable
`,
);

function wrangler(args, { quiet = false } = {}) {
  try {
    return execFileSync("npx", ["--no-install", "wrangler", ...args], {
      cwd: WORKER,
      encoding: "utf8",
      shell: true,
      env: { ...process.env, CI: "1" },
      stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    });
  } catch (e) {
    if (quiet) return null;
    throw e;
  }
}

// 3. Le projet, puis l'envoi.
const projets = wrangler(["pages", "project", "list"], { quiet: true }) || "";
if (!projets.includes(PROJET)) {
  console.log(`création du projet ${PROJET}`);
  wrangler(["pages", "project", "create", PROJET, "--production-branch", "main"]);
}
wrangler(["pages", "deploy", `"${resolve(dir)}"`, "--project-name", PROJET, "--branch", "main", "--commit-dirty=true"]);
console.log(`fini — test : curl -I https://${PROJET}.pages.dev/${cles[0]}`);
