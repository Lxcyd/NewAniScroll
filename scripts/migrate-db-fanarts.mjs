#!/usr/bin/env node
/**
 * Idempotent migration for the fanarts schema:
 *   - Adds `tvdb_id` / `tmdb_id` columns to `anime` if they don't already
 *     exist (SQLite ALTER doesn't support IF NOT EXISTS).
 *   - Creates indexes on those columns.
 *   - Creates the `anime_fanarts` table + indexes.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
  console.error("✘ TURSO env missing");
  process.exit(1);
}
const db = createClient({ url, authToken });

async function columnExists(table, column) {
  const r = await db.execute(`PRAGMA table_info(${table})`);
  return r.rows.some((row) => row.name === column);
}

async function main() {
  console.log("→ Migrating anime table for fanarts");

  if (!(await columnExists("anime", "tvdb_id"))) {
    await db.execute("ALTER TABLE anime ADD COLUMN tvdb_id INTEGER");
    console.log("  ✓ added column tvdb_id");
  } else {
    console.log("  • tvdb_id already exists, skipping");
  }

  if (!(await columnExists("anime", "tmdb_id"))) {
    await db.execute("ALTER TABLE anime ADD COLUMN tmdb_id INTEGER");
    console.log("  ✓ added column tmdb_id");
  } else {
    console.log("  • tmdb_id already exists, skipping");
  }

  await db.execute("CREATE INDEX IF NOT EXISTS idx_anime_tvdb_id ON anime(tvdb_id)");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_anime_tmdb_id ON anime(tmdb_id)");
  console.log("  ✓ indexes ensured");

  console.log("\n→ Creating anime_fanarts table");
  await db.execute(`
    CREATE TABLE IF NOT EXISTS anime_fanarts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      anime_id        INTEGER NOT NULL,
      type            TEXT NOT NULL,
      url             TEXT NOT NULL,
      fanart_id       TEXT,
      width           INTEGER,
      height          INTEGER,
      language        TEXT,
      likes           INTEGER DEFAULT 0,
      season          INTEGER,
      nsfw_drawing    REAL,
      nsfw_hentai     REAL,
      nsfw_neutral    REAL,
      nsfw_porn       REAL,
      nsfw_sexy       REAL,
      nsfw_label      TEXT,
      classified_at   INTEGER,
      fetched_at      INTEGER NOT NULL,
      UNIQUE (anime_id, type, url),
      FOREIGN KEY (anime_id) REFERENCES anime(id) ON DELETE CASCADE
    )
  `);

  await db.execute("CREATE INDEX IF NOT EXISTS idx_fanart_anime  ON anime_fanarts(anime_id)");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_fanart_type   ON anime_fanarts(type)");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_fanart_label  ON anime_fanarts(nsfw_label)");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_fanart_unclassified ON anime_fanarts(classified_at)");

  console.log("  ✓ anime_fanarts ready");
  console.log("\n✓ Fanart migration complete.");
}

main().catch((e) => {
  console.error("\n✘ Migration failed:", e);
  process.exit(1);
});
