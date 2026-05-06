#!/usr/bin/env node
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const id = Number(process.argv[2] || 154587);
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const r = await db.execute({
  sql: "SELECT data FROM anime WHERE id = ?",
  args: [id],
});
if (r.rows.length === 0) {
  console.log("Not found");
  process.exit(0);
}
const m = JSON.parse(r.rows[0].data);
console.log("Top-level fields:", Object.keys(m).sort().join(", "));
console.log();
console.log("title:       ", JSON.stringify(m.title));
console.log("status:      ", m.status);
console.log("format:      ", m.format);
console.log("description: ", m.description ? m.description.slice(0, 80) + "…" : "(none)");
console.log("coverImage:  ", JSON.stringify(m.coverImage));
console.log("genres:      ", m.genres);
console.log("studios:     ", m.studios?.edges?.length, "edges");
console.log("relations:   ", m.relations?.edges?.length, "edges");
console.log("trailer:     ", m.trailer);
console.log("tags:        ", m.tags?.length, "tags");
console.log("synonyms:    ", m.synonyms?.length, "synonyms");
