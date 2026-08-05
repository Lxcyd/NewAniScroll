// Find player_map rows pointing at an anime-sama LANGUAGE panel that doesn't exist.
//
//   node scripts/audit-animesama-lang-panels.mjs             # audit every lang
//   node scripts/audit-animesama-lang-panels.mjs --lang=vf   # VF only (faster)
//   node scripts/audit-animesama-lang-panels.mjs --purge     # delete dead rows
//
// Why: anime-sama publishes a panel per (season, language) at
// `catalogue/<slug>/<seasonDir>/<lang>/episodes.js`. A `heuristic` row is
// written at RUNTIME by the app and is never confronted with reality, so a row
// can name a language panel that 404s. The app then shows a server chip for a
// language it cannot actually deliver — measured on Dandadan, whose
// `animesama/vf/dandadan/saison1` row is dead (anime-sama lists only
// `saison1/vostfr` and `saison2/vostfr`).
//
// One HEAD-like GET per row, capped concurrency, so this stays polite. Turso is
// read-only unless --purge; the resolution worker is never involved.

import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const args = process.argv.slice(2);
const purge = args.includes("--purge");
const langArg = (args.find((a) => a.startsWith("--lang=")) || "").split("=")[1] || null;
const CONCURRENCY = 5;

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const rows = (
  await db.execute({
    sql: `SELECT ani_id, lang, slug, season_dir, status FROM player_map
           WHERE source = 'animesama' AND slug IS NOT NULL
             AND (? IS NULL OR lang = ?)
           ORDER BY ani_id`,
    args: [langArg, langArg],
  })
).rows;

console.log(`probing ${rows.length} anime-sama panel(s), concurrency ${CONCURRENCY}\n`);

const dead = [];
let done = 0;

async function probe(row) {
  const dir = row.season_dir ? String(row.season_dir) : "saison1";
  const url = `https://anime-sama.to/catalogue/${row.slug}/${dir}/${row.lang}/episodes.js`;
  let ok = false;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "follow",
    });
    ok = res.ok;
  } catch {
    ok = true; // a network error is OUR problem, not evidence the panel is dead
  }
  if (!ok) dead.push({ ...row, dir, url });
  if (++done % 100 === 0) console.log(`  … ${done}/${rows.length}`);
}

for (let i = 0; i < rows.length; i += CONCURRENCY) {
  await Promise.all(rows.slice(i, i + CONCURRENCY).map(probe));
}

console.log(`\n${dead.length} dead panel(s) of ${rows.length}\n`);
const byStatus = {};
for (const d of dead) {
  byStatus[`${d.lang}/${d.status}`] = (byStatus[`${d.lang}/${d.status}`] || 0) + 1;
}
console.log("by lang/status:", byStatus, "\n");
for (const d of dead.slice(0, 40)) {
  console.log(`  ani=${d.ani_id} ${d.lang} ${d.slug}/${d.dir} [${d.status}]`);
}
if (dead.length > 40) console.log(`  … and ${dead.length - 40} more`);

if (!dead.length) process.exit(0);
if (!purge) {
  console.log("\n(read-only — re-run with --purge to delete these rows)");
  process.exit(0);
}

let n = 0;
for (const d of dead) {
  const res = await db.execute({
    sql: `DELETE FROM player_map WHERE ani_id = ? AND source = 'animesama' AND lang = ?`,
    args: [d.ani_id, d.lang],
  });
  n += res.rowsAffected;
}
console.log(`\ndeleted ${n} row(s)`);
