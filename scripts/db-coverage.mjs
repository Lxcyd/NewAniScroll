import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const queries = [
  ["Total anime in DB", "SELECT COUNT(*) AS n FROM anime"],
  ["With characters (≥1 edge)", "SELECT COUNT(*) AS n FROM anime WHERE json_array_length(json_extract(data,'$.characters.edges')) > 0"],
  ["With recommendations (≥1 node)", "SELECT COUNT(*) AS n FROM anime WHERE json_array_length(json_extract(data,'$.recommendations.nodes')) > 0"],
  ["With relations.coverImage.extraLarge", "SELECT COUNT(*) AS n FROM anime WHERE json_extract(data,'$.relations.edges[0].node.coverImage.extraLarge') IS NOT NULL"],
  ["With trailer", "SELECT COUNT(*) AS n FROM anime WHERE json_extract(data,'$.trailer.id') IS NOT NULL"],
];

for (const [label, sql] of queries) {
  const r = await db.execute(sql);
  console.log(`${label.padEnd(40)} ${r.rows[0].n}`);
}
