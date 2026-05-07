import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const r = await db.execute({
  sql: "SELECT data FROM anime WHERE id = 151807",
  args: [],
});

const m = JSON.parse(r.rows[0].data);
console.log("Top-level keys:", Object.keys(m).sort().join(", "));
console.log("\ntitle:        ", JSON.stringify(m.title));
console.log("idMal:        ", m.idMal);
console.log("description:  ", m.description ? m.description.slice(0,80) + "..." : "(none)");
console.log("characters:   ", m.characters?.edges?.length, "edges");
console.log("recommendations:", m.recommendations?.nodes?.length, "nodes");
console.log("relations:    ", m.relations?.edges?.length, "edges");
if (m.relations?.edges?.length) {
  console.log("  first relation node:", JSON.stringify(m.relations.edges[0].node, null, 2));
}
