#!/usr/bin/env node
/**
 * Test the classifier on real fanarts already in our DB.
 *
 * Picks fanarts from anime that span the SFW↔NSFW spectrum and prints scores.
 * Helps us calibrate the threshold without internet-image guesswork.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";
import { classifyImageUrl, loadModel } from "../lib/nsfw/classifier.mjs";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

console.log("→ Loading model…");
await loadModel();
console.log("  ✓ ready\n");

// Pull a handful of fanarts from popular anime + an obvious NSFW (isAdult)
// for sanity. We grab `background` and `character` types because those are
// the ones most likely to be stylized character art (high signal for NSFW).
const popularAnime = await db.execute(`
  SELECT a.id, json_extract(a.data, '$.title.userPreferred') AS title, a.is_adult
    FROM anime a
   WHERE EXISTS (SELECT 1 FROM anime_fanarts f WHERE f.anime_id = a.id)
   ORDER BY a.popularity DESC
   LIMIT 5
`);

const adultAnime = await db.execute(`
  SELECT a.id, json_extract(a.data, '$.title.userPreferred') AS title, a.is_adult
    FROM anime a
   WHERE EXISTS (SELECT 1 FROM anime_fanarts f WHERE f.anime_id = a.id)
     AND a.is_adult = 1
   ORDER BY a.popularity DESC
   LIMIT 2
`);

const targets = [...popularAnime.rows, ...adultAnime.rows];

for (const a of targets) {
  console.log(`\n=== ${a.title} (id=${a.id}, adult=${a.is_adult}) ===`);

  // Get up to 3 fanarts of various types
  const fanarts = await db.execute({
    sql: `SELECT type, url FROM anime_fanarts
           WHERE anime_id = ?
             AND type IN ('background', 'character', 'poster', 'thumb')
           LIMIT 3`,
    args: [a.id],
  });

  for (const f of fanarts.rows) {
    process.stdout.write(`  ${f.type.padEnd(10)} ${String(f.url).slice(0, 70).padEnd(70)} `);
    try {
      const t0 = Date.now();
      const { safe, nsfw } = await classifyImageUrl(f.url);
      const dt = Date.now() - t0;
      const verdict = nsfw > 0.5 ? "🔴 NSFW" : "🟢 SAFE";
      console.log(`safe=${(safe * 100).toFixed(0)}% nsfw=${(nsfw * 100).toFixed(0)}% ${verdict} (${dt}ms)`);
    } catch (e) {
      console.log(`✘ ${e.message}`);
    }
  }
}
