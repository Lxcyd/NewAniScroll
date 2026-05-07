import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Sample 10 random anime missing idMal, look at their format / status / popularity
const r = await db.execute({
  sql: `SELECT id, format, status, season_year, popularity,
               json_extract(data, '$.title.userPreferred') AS title
          FROM anime
         WHERE id_mal IS NULL
         ORDER BY popularity DESC NULLS LAST
         LIMIT 15`,
  args: [],
});

console.log("Top-15 anime sans idMal (par popularité):");
for (const row of r.rows) {
  console.log(`  ${String(row.id).padEnd(7)} | ${String(row.format || "?").padEnd(8)} | ${String(row.status || "?").padEnd(16)} | ${row.season_year || "?"} | pop=${row.popularity || 0} | ${row.title}`);
}

// Distribution
console.log("\nRépartition par format :");
const f = await db.execute(`
  SELECT format, COUNT(*) AS n
    FROM anime WHERE id_mal IS NULL
   GROUP BY format ORDER BY n DESC
`);
for (const row of f.rows) {
  console.log(`  ${String(row.format || "(null)").padEnd(10)} ${row.n}`);
}

// Compare with overall
console.log("\nRépartition par format (TOUS anime) :");
const f2 = await db.execute(`
  SELECT format, COUNT(*) AS n
    FROM anime
   GROUP BY format ORDER BY n DESC
`);
for (const row of f2.rows) {
  console.log(`  ${String(row.format || "(null)").padEnd(10)} ${row.n}`);
}
