#!/usr/bin/env node
/**
 * Garde du registre des lecteurs (lib/lecteurs.json), lance par build-test.
 *
 * Pourquoi : le 07/10/2026, sibnet (mort) et uqload (retire) tournaient encore
 * au lot OP/ED et s'affichaient sur le site, parce que quatre listes ecrites a
 * la main ne voyaient pas la decision de Luc. Le registre est desormais la
 * seule source ; ce script echoue si une liste du detecteur redevient ecrite en
 * dur, ou si un nom de lecteur inconnu du registre apparait dans une liste.
 * (Le cote site est garde au build par lib/hostRegistry.js.)
 *
 *   node scripts/check-lecteurs.mjs
 */
import fs from "node:fs";
import path from "node:path";

const RACINE = path.resolve(import.meta.dirname, "..");
const { lecteurs } = JSON.parse(fs.readFileSync(path.join(RACINE, "lib/lecteurs.json"), "utf8"));
const DET = path.join(RACINE, "tools/opening-detector-v2");

const erreurs = [];
for (const [h, d] of Object.entries(lecteurs)) {
  if (!["actif", "retire", "mort"].includes(d.etat)) erreurs.push(`lib/lecteurs.json : ${h} etat « ${d.etat} » inconnu`);
  if (d.etat !== "actif" && (d.site || d.lot)) erreurs.push(`lib/lecteurs.json : ${h} est ${d.etat} mais site/lot = true`);
  if (d.etat !== "actif" && !(d.depuis && d.raison)) erreurs.push(`lib/lecteurs.json : ${h} ${d.etat} sans « depuis » ni « raison »`);
}

// Les listes qui decident des lecteurs du lot ne s'ecrivent plus en dur.
const LISTES = /^\s*(MULTI_HOSTS|GUIDE_ORDER)\s*=\s*\[/;
const fichiers = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (["out", "cache", "node_modules", "__pycache__", "scratch"].includes(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(py|mjs)$/.test(e.name)) fichiers.push(p);
  }
})(DET);
for (const f of fichiers) {
  fs.readFileSync(f, "utf8").split(/\r?\n/).forEach((l, i) => {
    if (LISTES.test(l)) erreurs.push(`${path.relative(RACINE, f)}:${i + 1} : liste de lecteurs ecrite en dur (deriver de lecteurs.py)`);
  });
}

if (erreurs.length) {
  console.error("Registre des lecteurs : " + erreurs.length + " probleme(s)\n  " + erreurs.join("\n  "));
  process.exit(1);
}
const actifs = Object.entries(lecteurs).filter(([, d]) => d.etat === "actif").map(([h]) => h);
console.log(`lecteurs OK — actifs : ${actifs.join(", ")} ; ${fichiers.length} fichiers du detecteur verifies`);
