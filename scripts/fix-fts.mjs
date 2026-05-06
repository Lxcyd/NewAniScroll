#!/usr/bin/env node
/**
 * One-shot fix: drop and recreate `anime_fts` because the original schema
 * used `content=''` which forbids manual DELETEs — we need standalone FTS.
 *
 * Repopulates it from existing `anime` rows so search keeps working.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

console.log("→ Dropping old anime_fts");
await db.execute("DROP TABLE IF EXISTS anime_fts");

console.log("→ Recreating anime_fts (standalone FTS5)");
await db.execute(`
  CREATE VIRTUAL TABLE anime_fts USING fts5(
    romaji, english, native, synonyms,
    tokenize='unicode61 remove_diacritics 2'
  )
`);

console.log("→ Repopulating from existing anime rows");
const r = await db.execute("SELECT id, data FROM anime");
let n = 0;
for (const row of r.rows) {
  const m = JSON.parse(row.data);
  await db.execute({
    sql: `INSERT INTO anime_fts (rowid, romaji, english, native, synonyms)
            VALUES (?, ?, ?, ?, ?)`,
    args: [
      Number(row.id),
      m.title?.romaji ?? "",
      m.title?.english ?? "",
      m.title?.native ?? "",
      (m.synonyms || []).join(" "),
    ],
  });
  n++;
}
console.log(`✓ Repopulated ${n} row(s)`);
