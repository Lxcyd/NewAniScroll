import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const statuses = ["suggestive", "nsfw", "error-perm"];

console.log("→ Bench main SELECT (admin/fanarts-pending)…");
const t1 = Date.now();
const r1 = await db.execute({
  sql: `SELECT MIN(f.id) AS id, MIN(f.anime_id) AS anime_id,
               f.type, f.url, MIN(f.nsfw_label) AS nsfw_label,
               MAX(f.nsfw_score) AS nsfw_score,
               MAX(f.likes) AS likes, MIN(f.language) AS language,
               MIN(f.season) AS season,
               MIN(json_extract(a.data, '$.title.userPreferred')) AS title,
               MAX(a.is_adult) AS is_adult,
               MIN(json_extract(a.data, '$.coverImage.color')) AS color
          FROM anime_fanarts f
          JOIN anime a ON a.id = f.anime_id
         WHERE nsfw_label IN (?, ?, ?)
         GROUP BY f.url, f.type
         ORDER BY MIN(f.id) ASC
         LIMIT 20`,
  args: statuses,
});
console.log(`  → ${Date.now() - t1}ms, rows=${r1.rows.length}`);

console.log("→ Bench counts (CTE)…");
const t2 = Date.now();
const r2 = await db.execute(`
  WITH grouped AS (
    SELECT MIN(nsfw_label) AS lbl
      FROM anime_fanarts
     GROUP BY url, type
  )
  SELECT
    SUM(CASE WHEN lbl IN ('suggestive', 'manual-suggestive') THEN 1 ELSE 0 END) AS suggestive,
    SUM(CASE WHEN lbl IN ('nsfw', 'manual-nsfw', 'manual-explicit') THEN 1 ELSE 0 END) AS nsfw,
    SUM(CASE WHEN lbl IN ('error-perm', 'manual-error') THEN 1 ELSE 0 END) AS error_perm,
    SUM(CASE WHEN lbl LIKE 'manual-%' THEN 1 ELSE 0 END) AS reviewed
  FROM grouped
`);
console.log(`  → ${Date.now() - t2}ms`);
console.log("  ", r2.rows[0]);
