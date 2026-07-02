// Purge HEURISTIC player_map rows en masse.
//
// Why: heuristic rows are best-effort season→slug guesses written back at
// runtime. Any written while the season cache was on a slow/poisoned Redis
// could encode the WRONG season (the "SnK S1 -> saison2 / shingeki-no-kyojin-2"
// bug). verified/broken/absent rows are owned by the verifier or explicit
// signals and are NOT touched. Deleting the heuristic rows forces a fresh
// re-resolution (now that season resolution is on Turso, not Redis), which
// rewrites them correctly on next access.
//
//   node scripts/purge-heuristic-player-map.mjs           # count only (dry run)
//   node scripts/purge-heuristic-player-map.mjs --commit    # actually delete
//
// Reads TURSO_DATABASE_URL / TURSO_AUTH_TOKEN from .env.local.

import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const commit = process.argv.includes("--commit");
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const counts = await db.execute(
  "SELECT status, COUNT(*) AS n FROM player_map GROUP BY status",
);
console.log("player_map by status:");
for (const r of counts.rows) console.log(`  ${r.status}: ${r.n}`);

const heur = await db.execute(
  "SELECT COUNT(*) AS n FROM player_map WHERE status = 'heuristic'",
);
const n = Number(heur.rows[0].n);
console.log(`\n${n} heuristic row(s) eligible for purge.`);

if (!commit) {
  console.log("dry run — pass --commit to delete them.");
  process.exit(0);
}

const d = await db.execute("DELETE FROM player_map WHERE status = 'heuristic'");
console.log(`PURGED ${d.rowsAffected} heuristic row(s). They will be re-resolved on next access.`);
