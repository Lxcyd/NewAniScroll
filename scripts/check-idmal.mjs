import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const ids = [113415, 21519, 154587, 151807, 21, 1, 5114, 140960];
const r = await db.execute({
  sql: `SELECT id, id_mal, json_extract(data, '$.idMal') AS data_idmal,
               json_extract(data, '$.title.userPreferred') AS title
          FROM anime WHERE id IN (${ids.map(() => "?").join(",")})`,
  args: ids,
});

for (const row of r.rows) {
  console.log(`  • ${row.id} | col=${String(row.id_mal).padEnd(8)} data.idMal=${String(row.data_idmal).padEnd(8)} | ${row.title}`);
}

const stats = await db.execute(`
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN id_mal IS NULL THEN 1 ELSE 0 END) AS null_in_col,
    SUM(CASE WHEN json_extract(data,'$.idMal') IS NULL THEN 1 ELSE 0 END) AS null_in_data
  FROM anime
`);
console.log("\nStats globales:");
const s = stats.rows[0];
console.log(`  total: ${s.total}`);
console.log(`  id_mal NULL dans la colonne: ${s.null_in_col}`);
console.log(`  data.idMal NULL dans le JSON: ${s.null_in_data}`);
