import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const ids = [145260, 139648, 126791, 141534, 170732]; // those AniList confirmed had data

const r = await db.execute({
  sql: `SELECT id,
               json_array_length(json_extract(data,'$.characters.edges'))     AS chars,
               json_array_length(json_extract(data,'$.recommendations.nodes')) AS recs,
               json_extract(data,'$.trailer.id')                               AS trailer,
               json_extract(data,'$.bannerImage')                              AS banner,
               last_fetched_at,
               json_extract(data,'$.title.userPreferred') AS title
          FROM anime WHERE id IN (?, ?, ?, ?, ?)`,
  args: ids,
});

for (const row of r.rows) {
  const fetched = new Date(Number(row.last_fetched_at) * 1000).toISOString();
  console.log(`${row.id} | chars=${row.chars} recs=${row.recs} trailer=${row.trailer ? "set" : "null"} banner=${row.banner ? "set" : "null"} | fetched ${fetched} | ${row.title}`);
}
