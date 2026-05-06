#!/usr/bin/env node
/**
 * Quick read-only snapshot of what's in the anime cache. Useful for the
 * mini-simulation: run before/after a page visit to see what got cached.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const r = await db.execute(`
  SELECT id, status, format,
         json_extract(data, '$.title.userPreferred') AS title,
         datetime(last_fetched_at, 'unixepoch') AS fetched_at,
         datetime(last_accessed_at, 'unixepoch') AS accessed_at,
         datetime(expires_at, 'unixepoch')      AS expires_at
    FROM anime
   ORDER BY last_accessed_at DESC
   LIMIT 20
`);

console.log(`\n${r.rows.length} row(s) in anime cache (most recent first):\n`);
for (const row of r.rows) {
  console.log(
    `  • [${row.id}] ${row.status?.padEnd(16) || "?".padEnd(16)} ${(row.format || "?").padEnd(8)} | ${row.title}`
  );
  console.log(
    `    fetched ${row.fetched_at} | accessed ${row.accessed_at} | expires ${row.expires_at}`
  );
}

const total = await db.execute("SELECT COUNT(*) AS n FROM anime");
console.log(`\nTotal: ${total.rows[0].n} anime in cache.`);
