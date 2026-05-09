import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const r = await db.execute(`
  SELECT nsfw_label, COUNT(*) AS n
    FROM anime_fanarts
   GROUP BY nsfw_label
   ORDER BY n DESC
`);

console.log("Final classification breakdown:\n");
let total = 0;
for (const row of r.rows) {
  console.log(`  ${String(row.nsfw_label || "(NULL)").padEnd(22)} ${String(row.n).padStart(8)}`);
  total += Number(row.n);
}
console.log(`  ${"─".repeat(22)} ${"─".repeat(8)}`);
console.log(`  ${"TOTAL".padEnd(22)} ${String(total).padStart(8)}`);

// Group by url for review-side stats
const r2 = await db.execute(`
  SELECT lbl, COUNT(*) AS n
    FROM (
      SELECT MIN(nsfw_label) AS lbl FROM anime_fanarts GROUP BY url, type
    )
   GROUP BY lbl
   ORDER BY n DESC
`);
console.log("\nUnique (url, type) pairs by label:\n");
for (const row of r2.rows) {
  console.log(`  ${String(row.lbl || "(NULL)").padEnd(22)} ${String(row.n).padStart(8)}`);
}
