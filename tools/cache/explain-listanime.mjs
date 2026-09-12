#!/usr/bin/env node
/**
 * Mesure le plan d'execution de `listAnime`, avant/apres.
 *
 * Le plan de la page d'accueil triait sur
 * `CAST(json_extract(data,'$.trending') AS INTEGER)` — une expression qu'AUCUN
 * index ne peut servir. SQLite lit donc toutes les lignes de `anime`,
 * deserialise un blob de ~15 ko pour chacune, trie, et en garde 15. L'accueil
 * en lance trois en parallele.
 *
 * Ce script ne devine pas : il demande son plan a SQLite (`EXPLAIN QUERY PLAN`)
 * et compte les lignes reellement candidates. A relancer apres toute
 * modification d'un `ORDER BY` sur cette table.
 *
 * Lecture seule.
 */

import { createClient } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";

const RACINE = path.resolve(import.meta.dirname, "..", "..");
for (const nom of [".env", ".env.local"]) {
  const p = path.join(RACINE, nom);
  if (!fs.existsSync(p)) continue;
  for (const l of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = l.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m && m[2].trim() && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
  }
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const VARIANTES = {
  "TRENDING (json_extract, avant)":
    "CAST(json_extract(data, '$.trending') AS INTEGER) DESC NULLS LAST",
  "POPULARITY (colonne indexee)": "popularity DESC NULLS LAST",
  "SCORE (colonne)": "average_score DESC NULLS LAST",
  "ID_DESC": "id DESC",
};

const [{ n: total }] = (await db.execute("SELECT COUNT(*) AS n FROM anime")).rows;
const [{ n: candidates }] = (
  await db.execute("SELECT COUNT(*) AS n FROM anime WHERE is_adult = 0 AND data IS NOT NULL")
).rows;

console.log(`lignes dans anime            : ${Number(total).toLocaleString("fr-FR")}`);
console.log(`candidates (is_adult=0, data): ${Number(candidates).toLocaleString("fr-FR")}\n`);

for (const [nom, orderBy] of Object.entries(VARIANTES)) {
  const sql = `SELECT data FROM anime
                WHERE is_adult = 0 AND data IS NOT NULL
                ORDER BY ${orderBy} LIMIT 15`;
  const plan = await db.execute(`EXPLAIN QUERY PLAN ${sql}`);
  const lignes = plan.rows.map((r) => String(r.detail));
  // Un "USE TEMP B-TREE FOR ORDER BY" signale que SQLite doit materialiser et
  // trier l'ensemble : c'est la que part le temps, et les lignes lues.
  const trieEnMemoire = lignes.some((l) => /TEMP B-TREE/i.test(l));
  const utiliseIndex = lignes.some((l) => /USING INDEX/i.test(l));
  console.log(`${nom}`);
  for (const l of lignes) console.log(`    ${l}`);
  console.log(
    `    -> ${utiliseIndex ? "index utilise" : "SCAN complet"}` +
      `${trieEnMemoire ? " + tri materialise (toutes les lignes lues)" : " + pas de tri materialise"}\n`,
  );
}
