#!/usr/bin/env node
/**
 * Replace the NSFWJS-style columns (drawing/hentai/neutral/porn/sexy) on
 * anime_fanarts with the binary AdamCodd ViT model output (safe/nsfw).
 *
 * Idempotent: checks each column before adding.
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

async function main() {
  console.log("→ Adapting anime_fanarts NSFW columns for the binary classifier");

  // Add the two new ones
  if (!(await columnExists("anime_fanarts", "nsfw_safe"))) {
    await db.execute("ALTER TABLE anime_fanarts ADD COLUMN nsfw_safe REAL");
    console.log("  ✓ added nsfw_safe");
  }
  if (!(await columnExists("anime_fanarts", "nsfw_score"))) {
    await db.execute("ALTER TABLE anime_fanarts ADD COLUMN nsfw_score REAL");
    console.log("  ✓ added nsfw_score (P(nsfw))");
  }

  // We could DROP the legacy multi-class columns but SQLite makes that
  // expensive (rebuild table). Leave them — they'll just be NULL.
  console.log("\n  • legacy NSFWJS cols (nsfw_drawing/…/sexy) left in place (always NULL)");
  console.log("\n✓ Done.");
}

main().catch((e) => { console.error("\n✘ Failed:", e); process.exit(1); });
