import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const r = await db.execute({
  sql: `SELECT id, json_extract(data,'$.title.userPreferred') AS title
          FROM anime_fts f JOIN anime a ON a.id = f.rowid
          WHERE anime_fts MATCH ? ORDER BY a.popularity DESC LIMIT 10`,
  args: ['"re:zero"*'],
});
console.log("Re:Zero matches:");
for (const row of r.rows) console.log("  •", row.id, "|", row.title);

// Now check the relations shape on the most popular one
if (r.rows.length > 0) {
  const id = r.rows[0].id;
  const m = await db.execute({ sql: "SELECT data FROM anime WHERE id = ?", args: [id] });
  const data = JSON.parse(m.rows[0].data);
  console.log(`\nRow ${id} relations:`);
  if (data.relations?.edges) {
    for (const e of data.relations.edges.slice(0, 3)) {
      console.log(`  • ${e.relationType} | ${e.node.format} | ${e.node.title?.userPreferred || e.node.title?.romaji}`);
      console.log(`    coverImage:`, JSON.stringify(e.node.coverImage));
      console.log(`    bannerImage:`, e.node.bannerImage);
    }
  }
  console.log(`\nCharacters: ${data.characters?.edges?.length || 0} edges`);
  console.log(`Recommendations: ${data.recommendations?.nodes?.length || 0} nodes`);
}
