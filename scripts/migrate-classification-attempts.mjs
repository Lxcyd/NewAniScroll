#!/usr/bin/env node
/**
 * Adds `classification_attempts` to anime_fanarts so we can distinguish
 * permanent errors (3+ failures) from transient ones (< 3) and retry the
 * latter on subsequent runs.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function columnExists(table, column) {
  const r = await db.execute(`PRAGMA table_info(${table})`);
  return r.rows.some((row) => row.name === column);
}

if (!(await columnExists("anime_fanarts", "classification_attempts"))) {
  await db.execute(
    "ALTER TABLE anime_fanarts ADD COLUMN classification_attempts INTEGER NOT NULL DEFAULT 0"
  );
  console.log("✓ added classification_attempts");
} else {
  console.log("• classification_attempts already exists");
}
