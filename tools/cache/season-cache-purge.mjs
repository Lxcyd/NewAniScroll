#!/usr/bin/env node
/**
 * Purge les entrees de `season_cache` ecrites PENDANT une panne de la source.
 *
 * POURQUOI CE CAS EST PARTICULIER. Partout ailleurs dans le depot, la regle est
 * « ne cachons pas un echec ». `resolveSeasonList` et `resolveBonusFilms` font
 * l'inverse : elles ecrivent meme un tableau VIDE, avec le TTL plein de 7 jours,
 * au motif qu'« un anime sans saisons soeurs est un fait stable ». C'est vrai
 * quand AniList repond. Quand la source est morte, chaque fiche visitee
 * enregistre un faux « serie unique » valable une semaine.
 *
 * C'est le seul degat de la panne du 02-12/09/2026 qui NE DISPARAIT PAS quand
 * la source revient : le cache Redis, lui, a ete remis a zero par le changement
 * de base Upstash, mais `season_cache` vit dans Turso et a survecu.
 *
 * Et il ne se signale pas : un selecteur de saisons vide ressemble a un anime
 * qui n'a qu'une saison. Personne ne remonte le bug, il s'efface tout seul au
 * bout de sept jours, et entre-temps il est faux.
 *
 * Par defaut le script ne fait que COMPTER. `--apply` supprime.
 *
 * Usage :
 *   node tools/cache/season-cache-purge.mjs --depuis=2026-09-02
 *   node tools/cache/season-cache-purge.mjs --depuis=2026-09-02 --apply
 *   node tools/cache/season-cache-purge.mjs --depuis=2026-09-02 --tout --apply
 *
 * `--tout` purge aussi les entrees NON vides de la periode. A n'utiliser que si
 * la source rendait des reponses partielles plutot que des erreurs : une entree
 * non vide obtenue pendant une panne reste probablement correcte, et la
 * reconstruire coute des appels a la source.
 */

import { createClient } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";

const RACINE = path.resolve(import.meta.dirname, "..", "..");

function chargerEnv() {
  for (const nom of [".env", ".env.local"]) {
    const p = path.join(RACINE, nom);
    if (!fs.existsSync(p)) continue;
    for (const l of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = l.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (m && m[2].trim() && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
    }
  }
}
chargerEnv();

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const tout = args.includes("--tout");
const depuisArg = args.find((a) => a.startsWith("--depuis="));
if (!depuisArg) {
  console.error("usage: season-cache-purge.mjs --depuis=YYYY-MM-DD [--tout] [--apply]");
  process.exit(1);
}
const depuis = Math.floor(Date.parse(`${depuisArg.slice(9)}T00:00:00Z`) / 1000);
if (!Number.isFinite(depuis)) {
  console.error("date invalide");
  process.exit(1);
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

/* Les deux prefixes qui pratiquent l'ecriture d'un vide a TTL plein. Ne PAS
   elargir a `seasonChain:` sans raison : lui ne cache pas les vides, et le
   reconstruire coute des appels a la source. */
const PREFIXES = ["seasonList:", "bonusFilms:"];

/** Un vide au sens de ce cache : tableau ou objet sans contenu. */
const CONDITION_VIDE = `(value = '[]' OR value = 'null' OR value = '{}' OR value = '')`;

const q = async (sql, args = []) => (await db.execute({ sql, args })).rows;

console.log(`Fenetre : ecrit depuis ${depuisArg.slice(9)} (>= ${depuis})`);
console.log(`Mode    : ${apply ? "SUPPRESSION" : "comptage seul"}${tout ? " · toutes les entrees" : " · entrees vides seulement"}\n`);

let totalCible = 0;
for (const prefixe of PREFIXES) {
  const filtre = tout ? "1=1" : CONDITION_VIDE;
  const [r] = await q(
    `SELECT COUNT(*) AS n FROM season_cache
      WHERE cache_key LIKE ? AND updated_at >= ? AND ${filtre}`,
    [`${prefixe}%`, depuis],
  );
  const [tot] = await q(`SELECT COUNT(*) AS n FROM season_cache WHERE cache_key LIKE ?`, [
    `${prefixe}%`,
  ]);
  totalCible += Number(r.n);
  console.log(`  ${prefixe.padEnd(14)} ${String(r.n).padStart(6)} a purger  (sur ${tot.n} au total)`);
}

if (!totalCible) {
  console.log("\nRien a purger.");
  process.exit(0);
}

if (!apply) {
  console.log(`\n${totalCible} entree(s) seraient supprimees. Relancer avec --apply.`);
  process.exit(0);
}

let supprime = 0;
for (const prefixe of PREFIXES) {
  const filtre = tout ? "1=1" : CONDITION_VIDE;
  const r = await db.execute({
    sql: `DELETE FROM season_cache
           WHERE cache_key LIKE ? AND updated_at >= ? AND ${filtre}`,
    args: [`${prefixe}%`, depuis],
  });
  supprime += Number(r.rowsAffected || 0);
  console.log(`  ${prefixe.padEnd(14)} ${r.rowsAffected} supprimee(s)`);
}
console.log(`\n${supprime} entree(s) supprimees. Elles se reconstruiront a la prochaine visite.`);
