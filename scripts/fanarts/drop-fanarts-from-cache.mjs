/**
 * One-shot: drop the now-obsolete `anime_fanarts` table from the main
 * cache DB. After the split-fanarts migration, fanarts live on a
 * dedicated Turso instance (TURSO_FANARTS_DATABASE_URL) and the copy
 * still sitting on TURSO_DATABASE_URL just wastes ~80 MB of storage
 * and counts against the cache DB's row-read quota whenever a stray
 * query hits it.
 *
 * Safety:
 *   • Verifies the table exists on the SOURCE (main cache) before
 *     dropping — silently no-ops if already gone.
 *   • Verifies the TARGET (fanarts DB) has at least 100k rows before
 *     touching the source. If the migration was rolled back or never
 *     completed, we refuse to drop and leave both copies in place.
 *
 * Usage:
 *   node scripts/fanarts/drop-fanarts-from-cache.mjs           # dry-run by default
 *   node scripts/fanarts/drop-fanarts-from-cache.mjs --confirm # actually drop
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const CONFIRM = process.argv.includes("--confirm");

const src = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const dst = createClient({
  url: process.env.TURSO_FANARTS_DATABASE_URL,
  authToken: process.env.TURSO_FANARTS_AUTH_TOKEN,
});

// 1. Does the table even exist on source?
const exists = await src.execute(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='anime_fanarts'"
);
if (exists.rows.length === 0) {
  console.log("✓ anime_fanarts already absent from main cache DB — nothing to do");
  process.exit(0);
}

// 2. Sanity-check that the fanarts DB has the data.
const targetCount = await dst.execute(
  "SELECT COUNT(*) AS n FROM anime_fanarts"
);
const targetN = Number(targetCount.rows[0]?.n ?? 0);
console.log(`Fanarts DB has ${targetN} rows.`);
if (targetN < 100000) {
  console.error(
    `✘ Refusing to drop: fanarts DB has only ${targetN} rows, " +
    "expected ≥100k. Re-run the migration first.`
  );
  process.exit(1);
}

const sourceCount = await src.execute(
  "SELECT COUNT(*) AS n FROM anime_fanarts"
);
console.log(`Main cache DB has ${sourceCount.rows[0]?.n} rows (will be dropped).`);

if (!CONFIRM) {
  console.log("\n(dry-run) re-run with --confirm to actually drop the table:");
  console.log("  node scripts/fanarts/drop-fanarts-from-cache.mjs --confirm");
  process.exit(0);
}

console.log("\n→ Dropping anime_fanarts from main cache DB…");
await src.execute("DROP TABLE anime_fanarts");
console.log("✓ Done. Storage on cache DB will shrink after Turso's next compaction.");
