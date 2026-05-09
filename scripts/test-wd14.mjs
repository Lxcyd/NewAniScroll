#!/usr/bin/env node
/**
 * Smoke test: classify ~30 fanarts spanning the SFW↔NSFW spectrum so we
 * can see how WD14 + our rules behave before classifying the whole DB.
 *
 * Pulls fanarts from anime that should clearly fall on each side:
 *   • SnK Titans (male bare_chest → must be SAFE under our whitelist)
 *   • Kaguya school uniform → must be SAFE
 *   • Kaguya swimsuit → must be NSFW
 *   • Akame ga Kill (Esdeath / Mine — frequent fanservice) → expect mostly NSFW
 *   • Re:Zero with Rem/Ram lingerie variants → NSFW
 *   • Death Note Misa (lingerie/filet) → NSFW (acceptable, user said even
 *     borderline cases should err toward flagging).
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";
import { classifyImageUrl, loadModel } from "../lib/nsfw/wd14-classifier.mjs";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const ANIME_TARGETS = [
  { id: 16498,  hint: "Shingeki no Kyojin (Titans, male bare chest expected SAFE)" },
  { id: 113415, hint: "Jujutsu Kaisen" },
  { id: 154587, hint: "Frieren" },
  { id: 1535,   hint: "Death Note (Misa borderline)" },
  { id: 21355,  hint: "Re:Zero (Rem/Ram fanservice)" },
  { id: 20613,  hint: "Akame ga Kill (heavy fanservice)" },
  { id: 101921, hint: "Kaguya-sama Love is War" },
];

console.log("→ Loading WD14 SwinV2 model…");
const t0 = Date.now();
await loadModel();
console.log(`  ✓ ready (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);

for (const target of ANIME_TARGETS) {
  const animeRow = await db.execute({
    sql: `SELECT json_extract(data,'$.title.userPreferred') AS title FROM anime WHERE id = ?`,
    args: [target.id],
  });
  const title = animeRow.rows[0]?.title || `(anime ${target.id})`;
  console.log(`\n=== ${title} — ${target.hint} ===`);

  // Pick a handful of fanarts of various types
  const fanarts = await db.execute({
    sql: `SELECT type, url FROM anime_fanarts
           WHERE anime_id = ?
             AND type IN ('background', 'character', 'poster', 'thumb', 'clearart')
           ORDER BY likes DESC
           LIMIT 4`,
    args: [target.id],
  });

  for (const f of fanarts.rows) {
    const url = String(f.url);
    process.stdout.write(`  ${String(f.type).padEnd(10)} ${url.slice(-50).padEnd(50)} `);
    try {
      const t1 = Date.now();
      const v = await classifyImageUrl(url, {}, { includeTopTags: true });
      const dt = Date.now() - t1;
      const emoji =
        v.label === "nsfw" ? "🔴" : v.label === "suggestive" ? "🟡" : "🟢";
      console.log(`${emoji} ${v.label.padEnd(10)} (${v.reason}) — ${dt}ms`);
      if (v.topTags) {
        const interesting = v.topTags
          .filter((t) => !["1girl", "1boy", "long_hair", "looking_at_viewer", "solo", "smile",
                           "sky", "cloud", "open_mouth", "blue_eyes", "red_eyes", "black_hair",
                           "blue_sky", "outdoors", "japanese_clothes"].includes(t.name))
          .slice(0, 6)
          .map((t) => `${t.name}=${t.score.toFixed(2)}`)
          .join(" ");
        if (interesting) console.log(`             top: ${interesting}`);
      }
    } catch (e) {
      console.log(`✘ ${e.message}`);
    }
  }
}
