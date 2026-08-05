// Find player_map rows pinned to a HORS-SÉRIE / recap panel.
//
//   node scripts/scan-player-map-sidestory.mjs            # list them
//   node scripts/scan-player-map-sidestory.mjs --purge    # delete them
//
// Why this exists: anime-sama parks recap/log panels under a `saison*hs` dir.
// Such a panel is never the answer to a normal episode request, and the
// season-coherence guard in pages/api/v2/source/index.js could not catch it —
// `/saison\s*(\d+)/` reads "saison1hs" as season 1, exactly like "saison1", so
// a row pinned there looked coherent and was served from the fast path forever.
// Symptom: Bungou Stray Dogs S1 ep1 playing an 11:40 recap short instead of the
// 23:42 episode, on the main-season URL.
//
// The runtime guard (isSideStoryDir) now rejects these rows and lets the
// heuristic path re-derive the right panel, so this script is for auditing and
// for clearing the backlog rather than for correctness.
//
// Read-only by default. It touches Turso only — never the resolution worker —
// so it costs no worker quota.

import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const purge = process.argv.includes("--purge");
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const total = await db.execute("SELECT COUNT(*) n FROM player_map");
const bad = await db.execute(
  "SELECT * FROM player_map WHERE season_dir LIKE '%hs' ORDER BY ani_id",
);

console.log(`player_map: ${total.rows[0].n} rows total`);
console.log(`pinned to a side-story panel: ${bad.rows.length}\n`);
for (const r of bad.rows) {
  console.log(
    `  ani=${r.ani_id} ${r.source}/${r.lang} ${r.slug} -> ${r.season_dir} ` +
      `[${r.status}, ${r.note}]`,
  );
}

if (!bad.rows.length) process.exit(0);

if (!purge) {
  console.log(
    "\n(read-only — re-run with --purge to delete these rows so the resolver " +
      "re-derives the correct panel on the next request)",
  );
  process.exit(0);
}

const res = await db.execute("DELETE FROM player_map WHERE season_dir LIKE '%hs'");
console.log(`\ndeleted ${res.rowsAffected} row(s)`);
