#!/usr/bin/env node
/**
 * For 5 anime in our DB that lack bannerImage / trailer / characters,
 * fetch AniList live and compare. If AniList itself returns null, our cache
 * is faithful — no trou. If AniList returns a value but we have null, it's
 * a real bug we need to fix.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function liveFetch(id) {
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query($id:Int){Media(id:$id){
        id bannerImage trailer{id}
        characters{edges{role}}
        recommendations{nodes{mediaRecommendation{id}}}
        title{userPreferred}
      }}`,
      variables: { id },
    }),
  });
  const j = await res.json();
  return j.data?.Media;
}

async function compareCase(label, where) {
  console.log(`\n=== ${label} ===`);
  const r = await db.execute(`
    SELECT id, json_extract(data,'$.title.userPreferred') AS title
      FROM anime
     WHERE ${where}
     ORDER BY popularity DESC NULLS LAST
     LIMIT 5
  `);
  for (const row of r.rows) {
    const id = Number(row.id);
    const live = await liveFetch(id);
    if (!live) { console.log(`  ${id} | live: NULL`); continue; }
    const charsLive = live.characters?.edges?.length || 0;
    const recsLive = live.recommendations?.nodes?.length || 0;
    console.log(`  ${id} | ${row.title}`);
    console.log(`    DB → bannerImage=null, trailer=null, chars=0, recs=0`);
    console.log(`    LIVE → bannerImage=${live.bannerImage ? "set" : "null"}, trailer=${live.trailer?.id ? "set" : "null"}, chars=${charsLive}, recs=${recsLive}`);
    await new Promise(r => setTimeout(r, 700));
  }
}

await compareCase(
  "Anime missing bannerImage (top by popularity)",
  "json_extract(data,'$.bannerImage') IS NULL"
);
await compareCase(
  "Anime missing characters",
  "json_array_length(json_extract(data,'$.characters.edges')) = 0 OR json_extract(data,'$.characters') IS NULL"
);
