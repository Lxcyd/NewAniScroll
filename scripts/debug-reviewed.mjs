import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Check what's in the DB matching the "reviewed" filter
const labels = ["manual-safe", "manual-suggestive", "manual-nsfw", "manual-explicit", "manual-error"];

const r = await db.execute({
  sql: `SELECT id, anime_id, type, nsfw_label, classified_at
          FROM anime_fanarts
         WHERE nsfw_label IN (?, ?, ?, ?, ?)
         ORDER BY id`,
  args: labels,
});
console.log(`Manual rows: ${r.rows.length}`);
for (const row of r.rows) {
  console.log(`  id=${row.id} anime=${row.anime_id} type=${row.type} label=${row.nsfw_label}`);
}

// Also count grouped by label to see distribution
const counts = await db.execute(`
  SELECT nsfw_label, COUNT(*) AS n
    FROM anime_fanarts
   GROUP BY nsfw_label
   ORDER BY n DESC
`);
console.log("\nLabel distribution:");
for (const row of counts.rows) {
  console.log(`  ${String(row.nsfw_label).padEnd(20)} ${row.n}`);
}
