// Inspect (and optionally purge) player_map rows for one aniId.
//
//   node scripts/player-map/inspect-player-map.mjs 16498          # show rows
//   node scripts/player-map/inspect-player-map.mjs 16498 --purge   # delete rows
//
// Reads TURSO_DATABASE_URL / TURSO_AUTH_TOKEN from .env.local.

import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";

// Minimal .env.local loader (no dotenv dep).
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const aniId = Number(process.argv[2]);
const purge = process.argv.includes("--purge");
if (!aniId) {
  console.error("usage: node scripts/player-map/inspect-player-map.mjs <aniId> [--purge]");
  process.exit(2);
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const r = await db.execute({
  sql: "SELECT * FROM player_map WHERE ani_id = ?",
  args: [aniId],
});

if (!r.rows.length) {
  console.log(`no player_map rows for aniId ${aniId}`);
} else {
  console.log(`player_map rows for aniId ${aniId}:`);
  for (const row of r.rows) {
    console.log(
      `  source=${row.source} lang=${row.lang} status=${row.status} ` +
        `slug=${row.slug} seasonDir=${row.season_dir} epOffset=${row.ep_offset} ` +
        `algoV=${row.algo_version} conf=${row.confidence} note=${row.note ?? ""}`,
    );
  }
}

if (purge) {
  const d = await db.execute({
    sql: "DELETE FROM player_map WHERE ani_id = ?",
    args: [aniId],
  });
  console.log(`\nPURGED ${d.rowsAffected} row(s) for aniId ${aniId}.`);
}
