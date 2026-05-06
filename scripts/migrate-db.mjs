#!/usr/bin/env node
/**
 * Apply lib/db/schema.sql to the Turso DB.
 *
 * Idempotent: every CREATE statement uses IF NOT EXISTS, so re-running this
 * is safe and won't drop data.
 *
 * Usage:  node scripts/migrate-db.mjs
 */

import { createClient } from "@libsql/client";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { config } from "dotenv";

// Load .env.local explicitly (Node scripts don't pick it up like Next.js does)
config({ path: ".env.local" });
config({ path: ".env" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const schemaPath = join(__dirname, "..", "lib", "db", "schema.sql");

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url || !authToken) {
  console.error("✘ TURSO_DATABASE_URL or TURSO_AUTH_TOKEN missing in .env.local");
  process.exit(1);
}

const client = createClient({ url, authToken });

async function main() {
  console.log("→ Connecting to", url);
  const sql = await readFile(schemaPath, "utf8");

  // Strip line comments first, THEN split on `;` at end of statement.
  // We don't have any embedded semicolons (no triggers / strings yet) so a
  // simple split on ';' is correct after comments are gone.
  const cleaned = sql.replace(/--.*$/gm, "");
  const statements = cleaned
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  console.log(`→ Applying ${statements.length} statements`);

  for (const stmt of statements) {
    const preview = stmt.replace(/\s+/g, " ").slice(0, 70);
    try {
      await client.execute(stmt);
      console.log(`  ✓ ${preview}…`);
    } catch (e) {
      console.error(`  ✘ ${preview}…`);
      console.error(`    ${e.message}`);
      throw e;
    }
  }

  // Sanity check
  const r = await client.execute(
    "SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name"
  );
  console.log("\n→ Schema objects in DB:");
  for (const row of r.rows) console.log("  •", row.name);

  console.log("\n✓ Migration complete.");
}

main().catch((e) => {
  console.error("\n✘ Migration failed:", e);
  process.exit(1);
});
