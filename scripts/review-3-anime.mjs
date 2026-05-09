#!/usr/bin/env node
/**
 * Walk through every fanart for 3 reference anime and report each
 * verdict (safe/suggestive/nsfw) so the user can sanity-check the
 * classifier behaviour on a known set.
 *
 * Targets:
 *   - Akame ga Kill                 (TVDB 280329 → AniList 20613)
 *   - Danmachi (Is It Wrong…)        (TVDB 289882)
 *   - Kaguya-sama Love is War        (TVDB 354198)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";
import { classifyImageUrl, loadModel } from "../lib/nsfw/wd14-classifier.mjs";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const TVDBS = [
  { tvdb: 280329, label: "Akame ga Kill" },
  { tvdb: 289882, label: "Danmachi" },
  { tvdb: 354198, label: "Kaguya-sama Love is War" },
];

console.log("→ Loading model…");
const t0 = Date.now();
await loadModel();
console.log(`  ✓ ready (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);

for (const { tvdb, label } of TVDBS) {
  // Find the AniList id mapped to this TVDB id (we can have several seasons
  // mapped to the same TVDB; we collect all of them).
  const anime = await db.execute({
    sql: `SELECT id, json_extract(data, '$.title.userPreferred') AS title
            FROM anime WHERE tvdb_id = ?`,
    args: [tvdb],
  });
  if (anime.rows.length === 0) {
    console.log(`\n=== ${label} (TVDB ${tvdb}) — NOT FOUND in DB ===`);
    continue;
  }

  const ids = anime.rows.map((r) => Number(r.id));
  console.log(`\n=== ${label} (TVDB ${tvdb} → AniList ${ids.join(", ")}) ===`);

  // Pull every fanart, dedupe by URL — multiple AniList ids can map to the
  // same TVDB id (sequels / specials), and they share the same fanart rows
  // duplicated. We only want to classify each image once.
  const fanarts = await db.execute({
    sql: `SELECT MIN(id) AS id, MIN(anime_id) AS anime_id, type, url, MAX(likes) AS likes
            FROM anime_fanarts
           WHERE anime_id IN (${ids.map(() => "?").join(",")})
             AND type NOT IN ('logo', 'disc')
           GROUP BY url
           ORDER BY type, MAX(likes) DESC`,
    args: ids,
  });

  console.log(`  Total unique fanarts: ${fanarts.rows.length}\n`);

  const stats = { safe: 0, suggestive: 0, nsfw: 0, error: 0 };
  for (const f of fanarts.rows) {
    const url = String(f.url);
    const short = url.split("/").pop().slice(0, 50);
    process.stdout.write(`  [${String(f.type).padEnd(13)}] ${short.padEnd(50)} `);
    try {
      const v = await classifyImageUrl(url);
      stats[v.label]++;
      const emoji =
        v.label === "nsfw" ? "🔴" : v.label === "suggestive" ? "🟡" : "🟢";
      const reason = v.reason.length > 30 ? v.reason.slice(0, 30) + "…" : v.reason;
      console.log(`${emoji} ${v.label.padEnd(10)} (${reason})  ${url}`);
    } catch (e) {
      stats.error++;
      console.log(`✘ ${e.message}`);
    }
  }

  console.log(`\n  Summary: 🟢 ${stats.safe} safe · 🟡 ${stats.suggestive} suggestive · 🔴 ${stats.nsfw} nsfw · ✘ ${stats.error} errors`);
}
