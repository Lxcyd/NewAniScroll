import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const r = await db.execute(`
  SELECT
    COUNT(*) AS total_rows,
    COUNT(DISTINCT url) AS distinct_urls
  FROM anime_fanarts
`);
const s = r.rows[0];
console.log(`Total rows in anime_fanarts:    ${s.total_rows}`);
console.log(`Distinct URLs:                  ${s.distinct_urls}`);
console.log(`Duplicates (same url, different anime): ${Number(s.total_rows) - Number(s.distinct_urls)}`);

// Worst offenders
const worst = await db.execute(`
  SELECT url, COUNT(*) AS n
    FROM anime_fanarts
   GROUP BY url
   HAVING n > 1
   ORDER BY n DESC
   LIMIT 10
`);
console.log(`\nTop 10 most-shared URLs:`);
for (const row of worst.rows) {
  console.log(`  ${row.n}× ${String(row.url).slice(-60)}`);
}
