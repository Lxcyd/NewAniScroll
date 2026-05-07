import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const r = await db.execute(`
  SELECT
    SUM(CASE WHEN COALESCE(popularity,0) >= 0     AND has_gap = 1 THEN 1 ELSE 0 END) AS gaps_all,
    SUM(CASE WHEN COALESCE(popularity,0) >= 100   AND has_gap = 1 THEN 1 ELSE 0 END) AS gaps_pop100,
    SUM(CASE WHEN COALESCE(popularity,0) >= 1000  AND has_gap = 1 THEN 1 ELSE 0 END) AS gaps_pop1k,
    SUM(CASE WHEN COALESCE(popularity,0) >= 5000  AND has_gap = 1 THEN 1 ELSE 0 END) AS gaps_pop5k,
    SUM(CASE WHEN COALESCE(popularity,0) >= 10000 AND has_gap = 1 THEN 1 ELSE 0 END) AS gaps_pop10k
  FROM (
    SELECT popularity,
      CASE WHEN
           json_extract(data,'$.trailer.id') IS NULL
        OR json_array_length(json_extract(data,'$.characters.edges'))     = 0
        OR json_array_length(json_extract(data,'$.recommendations.nodes')) = 0
        OR json_extract(data,'$.characters') IS NULL
        OR json_extract(data,'$.recommendations') IS NULL
      THEN 1 ELSE 0 END AS has_gap
    FROM anime
  )
`);

const row = r.rows[0];
console.log("Anime to refresh by popularity threshold:");
console.log(`  pop ≥     0  →  ${row.gaps_all}  (everything)`);
console.log(`  pop ≥   100  →  ${row.gaps_pop100}`);
console.log(`  pop ≥  1000  →  ${row.gaps_pop1k}`);
console.log(`  pop ≥  5000  →  ${row.gaps_pop5k}`);
console.log(`  pop ≥ 10000  →  ${row.gaps_pop10k}`);
console.log("\nETA (50 ids/req, ~6s/req):");
const sec = (n) => Math.round((n / 50) * 6);
const fmt = (s) => `${Math.floor(s/60)}m${s%60}s`;
console.log(`  ≥     0  →  ${fmt(sec(row.gaps_all))}`);
console.log(`  ≥   100  →  ${fmt(sec(row.gaps_pop100))}`);
console.log(`  ≥  1000  →  ${fmt(sec(row.gaps_pop1k))}`);
console.log(`  ≥  5000  →  ${fmt(sec(row.gaps_pop5k))}`);
console.log(`  ≥ 10000  →  ${fmt(sec(row.gaps_pop10k))}`);
