import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const statuses = ["suggestive", "nsfw", "error-perm"];
const placeholders = statuses.map(() => "?").join(",");

console.log("→ Stage 1: id selection…");
const t1 = Date.now();
const idsRow = await db.execute({
  sql: `SELECT MIN(id) AS id
          FROM anime_fanarts f
         WHERE nsfw_label IN (${placeholders})
         GROUP BY f.url, f.type
         ORDER BY id ASC
         LIMIT 20`,
  args: statuses,
});
console.log(`  → ${Date.now() - t1}ms, ${idsRow.rows.length} ids`);

console.log("→ Stage 2: hydrate metadata…");
const ids = idsRow.rows.map(r => Number(r.id));
const t2 = Date.now();
const r2 = await db.execute({
  sql: `SELECT f.id, f.url, f.type, json_extract(a.data,'$.title.userPreferred') AS title
          FROM anime_fanarts f
          JOIN anime a ON a.id = f.anime_id
         WHERE f.id IN (${ids.map(() => "?").join(",")})
         ORDER BY f.id ASC`,
  args: ids,
});
console.log(`  → ${Date.now() - t2}ms, rows=${r2.rows.length}`);

console.log("→ Counts (4 parallel)…");
const t3 = Date.now();
await Promise.all([
  db.execute(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM anime_fanarts WHERE nsfw_label IN ('suggestive', 'manual-suggestive') GROUP BY url, type)`),
  db.execute(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM anime_fanarts WHERE nsfw_label IN ('nsfw', 'manual-nsfw', 'manual-explicit') GROUP BY url, type)`),
  db.execute(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM anime_fanarts WHERE nsfw_label IN ('error-perm', 'manual-error') GROUP BY url, type)`),
  db.execute(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM anime_fanarts WHERE nsfw_label LIKE 'manual-%' GROUP BY url, type)`),
]);
console.log(`  → ${Date.now() - t3}ms`);
