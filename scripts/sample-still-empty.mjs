import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// 10 random anime that STILL have chars=0 after fill-gaps, sorted by popularity
const r = await db.execute(`
  SELECT id, popularity, json_extract(data,'$.title.userPreferred') AS title
    FROM anime
   WHERE (json_array_length(json_extract(data,'$.characters.edges')) = 0
       OR json_extract(data,'$.characters') IS NULL)
     AND popularity > 1000
   ORDER BY popularity DESC
   LIMIT 10
`);

const ids = r.rows.map(row => Number(row.id));
console.log(`Picking ${ids.length} popular anime that still have chars=0:`);

const live = await fetch("https://graphql.anilist.co", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    query: `query($ids:[Int]){Page(page:1,perPage:50){media(id_in:$ids,type:ANIME){
      id
      title { userPreferred }
      bannerImage
      trailer { id }
      characters { edges { role } }
      recommendations { nodes { mediaRecommendation { id } } }
    }}}`,
    variables: { ids },
  }),
});
const j = await live.json();
const mediaById = new Map();
for (const m of j.data.Page.media) mediaById.set(m.id, m);

console.log("\n  ID      | DB chars/recs/trailer/banner | LIVE chars/recs/trailer/banner | title");
for (const row of r.rows) {
  const id = Number(row.id);
  const m = mediaById.get(id);
  if (!m) { console.log(`  ${id} | not in live response`); continue; }
  const liveChars = m.characters?.edges?.length || 0;
  const liveRecs = m.recommendations?.nodes?.length || 0;
  console.log(
    `  ${String(id).padEnd(7)} | DB:0/0/?/? | LIVE:${liveChars}/${liveRecs}/${m.trailer?.id ? "set" : "null"}/${m.bannerImage ? "set" : "null"} | ${row.title}`
  );
}
