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

console.log(`\n${dead.length} unreachable at the constructed URL, of ${rows.length}\n`);
const byStatus = {};
for (const d of dead) {
  byStatus[`${d.lang}/${d.status}`] = (byStatus[`${d.lang}/${d.status}`] || 0) + 1;
}
console.log("by lang/status:", byStatus, "\n");
for (const d of dead.slice(0, 40)) {
  console.log(`  ani=${d.ani_id} ${d.lang} ${d.slug}/${d.dir} [${d.status}]`);
}
if (dead.length > 40) console.log(`  … and ${dead.length - 40} more`);

// THIS SCRIPT NO LONGER DELETES ANYTHING, and the removal is the whole point.
//
// A 404 on the URL above is not proof the panel is dead. That URL is a GUESS at
// anime-sama's layout, and the site serves some language panels by a path the
// template does not generate. Measured on Vinland Saga: the constructed VF URL
// 404s while the app resolves and plays a genuine French track for the same
// anime — it is still in the list above, and it is a false positive.
//
// Acting on that signal cost 4 `verified` VF rows (re-zero, kimi-wa-kanata,
// asagao-to-kase-san x2). Heuristic rows survive a wrong delete because the
// runtime rewrites them; verified rows come from the seed and nothing
// regenerates them, so they were gone until restored by hand. See
// scripts/repair-purged-player-map.mjs.
//
// Restricting --purge to heuristic rows was not enough either: Vinland's row IS
// heuristic, so the narrower rule still deleted a mapping that works. The
// missing evidence is not "which rows are safe to delete" but a probe that
// reflects how the APP resolves a panel. Until this asks the resolver itself,
// the honest output is a list for a human to confirm in the player.
if (purge) {
  console.log(
    "\n--purge is disabled: a 404 on a hand-built URL is not evidence a panel " +
      "is dead (proven false on vinland-saga/vf). Confirm in the app first.",
  );
}
console.log("\n(report only — verify each entry in the player before removing it)");
