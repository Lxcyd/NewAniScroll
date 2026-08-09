// Report player_map rows whose anime-sama LANGUAGE panel cannot be reached.
//
//   node scripts/audit/audit-animesama-lang-panels.mjs             # every lang
//   node scripts/audit/audit-animesama-lang-panels.mjs --lang=vf   # VF only (faster)
//
// READ-ONLY BY DESIGN — see "why this no longer deletes" at the bottom.
//
// HOW IT DECIDES. It probes exactly the paths the app's resolver probes, and
// declares a panel absent only when ALL of them fail. Anything else has been
// measured to produce false positives:
//
//   * Probing `<slug>/<dir>/vf/episodes.js` alone. The resolver tries vf, vf1,
//     vf2, vf3 (animeSamaLangDirs in pages/api/v2/source/index.js). Vinland
//     Saga's VF lives at `saison1/vf1`, so the single-path probe called a
//     working panel dead — and acting on that cost 4 `verified` VF rows.
//   * Reading the catalogue page as a manifest. Its `panneauAnime("Saison 1",
//     "saison1/vostfr")` calls declare SEASONS with a default language path and
//     never enumerate the language variants: vinland-saga's page mentions no VF
//     at all while `saison1/vf1` returns 200. Judging rows against it reported
//     546 of 607 VF panels missing — the site simply does not publish that list.
//
// So there is no cheap declarative source for "which language panels exist",
// and the only faithful test is the resolver's own. KEEP langDirs() AND the
// film fallback IN SYNC with pages/api/v2/source/index.js: if the app learns a
// new language directory and this does not, working panels get reported dead
// again.
//
// Cost: rows resolve on the first or second path in practice, and probes stop
// at the first success. The resolution worker is never involved.

import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const args = process.argv.slice(2);
const langArg = (args.find((a) => a.startsWith("--lang=")) || "").split("=")[1] || null;
const CONCURRENCY = 5;
const BASE = "https://anime-sama.to";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const rows = (
  await db.execute({
    sql: `SELECT ani_id, lang, slug, season_dir, status FROM player_map
           WHERE source = 'animesama' AND slug IS NOT NULL
             AND (? IS NULL OR lang = ?)
           ORDER BY slug`,
    args: [langArg, langArg],
  })
).rows;

/** Mirrors animeSamaLangDirs() in pages/api/v2/source/index.js. */
const langDirs = (lang) => (lang === "vf" ? ["vf", "vf1", "vf2", "vf3"] : [lang]);

/**
 * The language directories to try for a row, in the resolver's order. Film
 * panels are frequently published in a single language and fetchPanelIframe
 * falls back to the other one, which is how a VF row on kimi-wa-kanata/film
 * resolves at all. (That fallback means the app can serve a VOSTFR film under a
 * VF chip — a labelling question, not a missing-panel one, and out of scope
 * here.)
 */
function candidateDirs(dir, lang) {
  if (/^film/i.test(dir)) return [lang, lang === "vf" ? "vostfr" : "vf"];
  return langDirs(lang);
}

console.log(`probing ${rows.length} row(s), concurrency ${CONCURRENCY}\n`);

const missing = [];
let unknown = 0;
let ok = 0;
let done = 0;

async function probe(row) {
  const dir = row.season_dir ? String(row.season_dir) : "saison1";
  const lang = String(row.lang);
  const tried = [];
  let found = null;
  let hadNetworkError = false;

  for (const lp of candidateDirs(dir, lang)) {
    tried.push(lp);
    try {
      const res = await fetch(`${BASE}/catalogue/${row.slug}/${dir}/${lp}/episodes.js`, {
        headers: { "User-Agent": "Mozilla/5.0" },
        redirect: "follow",
      });
      if (res.ok) {
        found = lp;
        break;
      }
    } catch {
      // A network error is OUR problem, not evidence about the panel. One is
      // enough to make the whole row inconclusive: without it, a flaky probe on
      // the `vf` path would silently promote the row to "absent" the moment the
      // remaining paths also 404.
      hadNetworkError = true;
    }
  }

  if (found) ok++;
  else if (hadNetworkError) unknown++;
  else missing.push({ ...row, dir, tried });

  if (++done % 100 === 0) console.log(`  … ${done}/${rows.length}`);
}

for (let i = 0; i < rows.length; i += CONCURRENCY) {
  await Promise.all(rows.slice(i, i + CONCURRENCY).map(probe));
}

console.log(
  `\nreachable: ${ok}   no panel: ${missing.length}   inconclusive (network): ${unknown}\n`,
);

const byStatus = {};
for (const d of missing) byStatus[`${d.lang}/${d.status}`] = (byStatus[`${d.lang}/${d.status}`] || 0) + 1;
console.log("no-panel by lang/status:", byStatus, "\n");

for (const d of missing.slice(0, 60)) {
  console.log(`  ani=${d.ani_id} ${d.lang} ${d.slug}/${d.dir} [${d.status}] — tried: ${d.tried.join(", ")}`);
}
if (missing.length > 60) console.log(`  … and ${missing.length - 60} more`);

// WHY THIS NO LONGER DELETES. The previous --purge acted on a single guessed
// URL and cost 4 `verified` VF rows, which nothing regenerates: heuristic rows
// are rewritten by the runtime, verified ones come from the seed only. See
// scripts/player-map/repair-purged-player-map.mjs.
//
// The probe above is faithful to today's resolver, but "faithful to the
// resolver" is not "authoritative about the site" — it cannot see slug aliases,
// redirects, or a directory convention the app has not learned yet. Two
// criteria have already looked sound and been wrong. A wrong delete is silent
// and permanent; a wrong report costs a glance.
console.log("\n(report only — confirm in the player before removing anything)");
