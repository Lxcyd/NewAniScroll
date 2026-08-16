#!/usr/bin/env node
/**
 * One-shot migration: move the `anime_fanarts` table from the main Turso DB
 * to a dedicated fanarts DB.
 *
 * Run this AFTER you've:
 *   1. Created the new Turso database (`turso db create aniscroll-fanarts`)
 *   2. Generated an auth token (`turso db tokens create aniscroll-fanarts`)
 *   3. Added TURSO_FANARTS_DATABASE_URL and TURSO_FANARTS_AUTH_TOKEN to
 *      .env.local
 *
 * What it does:
 *   • Reads the full schema (table + indexes) from the source DB
 *   • Recreates them on the target DB
 *   • Streams rows in batches of 500 with INSERT OR IGNORE so re-running
 *     is safe — interrupted migrations resume cleanly
 *
 * Does NOT drop the source table. After you've verified the new DB is
 * serving traffic correctly, drop manually:
 *   turso db shell aniscroll-cache "DROP TABLE anime_fanarts"
 *
 * Usage:
 *   node scripts/fanarts/migrate-split-fanarts-db.mjs
 *   node scripts/fanarts/migrate-split-fanarts-db.mjs --batch=1000
 *   node scripts/fanarts/migrate-split-fanarts-db.mjs --dry-run
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const FORCE_SCHEMA = args.has("--force-schema");
const batchArg = [...args].find((a) => a.startsWith("--batch="));
const BATCH = batchArg ? parseInt(batchArg.split("=")[1], 10) : 500;
const concArg = [...args].find((a) => a.startsWith("--concurrency="));
const CONCURRENCY = concArg ? parseInt(concArg.split("=")[1], 10) : 6;

const SRC_URL = process.env.TURSO_DATABASE_URL;
const SRC_TOKEN = process.env.TURSO_AUTH_TOKEN;
const DST_URL = process.env.TURSO_FANARTS_DATABASE_URL;
const DST_TOKEN = process.env.TURSO_FANARTS_AUTH_TOKEN;

if (!SRC_URL || !DST_URL) {
  console.error("Missing env: need TURSO_DATABASE_URL and TURSO_FANARTS_DATABASE_URL");
  process.exit(1);
}
if (SRC_URL === DST_URL) {
  console.error("Source and destination URLs are identical — refusing to run");
  process.exit(1);
}

const src = createClient({ url: SRC_URL, authToken: SRC_TOKEN });
const dst = createClient({ url: DST_URL, authToken: DST_TOKEN });

/* Wrap any Turso call in retry-with-backoff. Turso occasionally returns
   502 Bad Gateway or drops the connection mid-request, and a single
   blip shouldn't kill a multi-hour migration. */
async function withRetry(label, fn) {
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const wait = 1000 * Math.pow(2, attempt);
      console.warn(`  ⚠ ${label} failed (attempt ${attempt + 1}/5): ${e?.message} — retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function getColumns() {
  const r = await withRetry("PRAGMA table_info", () =>
    src.execute("PRAGMA table_info(anime_fanarts)")
  );
  return r.rows.map((row) => String(row.name));
}

async function getCreateStatements() {
  const r = await withRetry("read schema", () =>
    src.execute(
      "SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND tbl_name='anime_fanarts' AND sql IS NOT NULL"
    )
  );
  return r.rows.map((row) => String(row.sql));
}

async function createSchemaOnDest() {
  // --force-schema: drop the existing fanarts table on the target so we
  // can recreate it without the stale FOREIGN KEY. Use this once after
  // a previous run created the table with a FK pointing at a missing
  // `anime` table.
  if (FORCE_SCHEMA && !DRY_RUN) {
    console.log("  --force-schema: dropping existing anime_fanarts on target");
    await dst.execute("DROP TABLE IF EXISTS anime_fanarts");
  }
  const stmts = await getCreateStatements();
  for (const stmt of stmts) {
    // 1. Add IF NOT EXISTS so re-running is safe.
    // 2. Strip FOREIGN KEY clauses. The source schema references the
    //    `anime` table, which doesn't exist on the fanarts DB (and FKs
    //    can't span Turso databases anyway). Without this the CREATE
    //    succeeds but the first INSERT fails with "no such table: main.anime".
    let safe = stmt
      .replace(/^CREATE TABLE /i, "CREATE TABLE IF NOT EXISTS ")
      .replace(/^CREATE INDEX /i, "CREATE INDEX IF NOT EXISTS ")
      .replace(/^CREATE UNIQUE INDEX /i, "CREATE UNIQUE INDEX IF NOT EXISTS ");
    // Strip the trailing `, FOREIGN KEY (...) REFERENCES ...(...) [ON ...]`
    // clause. We match the leading comma + whitespace + FOREIGN KEY, then
    // its column list `(...)`, then `REFERENCES table(...)`, then any
    // trailing `ON DELETE/UPDATE <action>` modifiers. The `s` flag lets
    // `.` cross newlines so the multi-line DDL stored in sqlite_master
    // still matches.
    safe = safe.replace(
      /,\s*FOREIGN\s+KEY\s*\([^)]*\)\s*REFERENCES\s+\w+\s*\([^)]*\)(?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:NO\s+ACTION|RESTRICT|SET\s+NULL|SET\s+DEFAULT|CASCADE))*/gis,
      ""
    );
    if (DRY_RUN) {
      console.log("[dry-run]", safe.slice(0, 80) + (safe.length > 80 ? "…" : ""));
    } else {
      await dst.execute(safe);
    }
  }
}

async function copyRows() {
  const cols = await getColumns();
  const colList = cols.join(", ");
  const rowPlaceholder = `(${cols.map(() => "?").join(", ")})`;

  // Build a batched multi-row INSERT and execute it on the destination.
  // Multi-row INSERT (instead of db.batch of N statements) does one SQL
  // parse + one round-trip per batch.
  // Includes retry-with-backoff because Turso occasionally drops the
  // connection mid-migration (transient `fetch failed`), and we'd lose
  // ~25 min of progress on every restart otherwise.
  async function flushBatch(rows) {
    const values = Array(rows.length).fill(rowPlaceholder).join(", ");
    const a = [];
    for (const row of rows) for (const c of cols) a.push(row[c]);
    const sql = `INSERT OR IGNORE INTO anime_fanarts (${colList}) VALUES ${values}`;
    let lastErr = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await dst.execute({ sql, args: a });
        return;
      } catch (e) {
        lastErr = e;
        const wait = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s, 8s, 16s
        console.warn(`  ⚠ batch insert failed (attempt ${attempt + 1}/5): ${e?.message} — retrying in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastErr;
  }

  // Resume from where the target left off. Without this, restarting a
  // crashed migration would re-fetch every already-copied row from the
  // source (free on a libsql SELECT but still costs Turso row reads),
  // then INSERT OR IGNORE them all as no-ops on the target.
  const maxRow = await withRetry("target MAX(id)", () =>
    dst.execute("SELECT COALESCE(MAX(id), 0) AS m FROM anime_fanarts")
  );
  let lastId = Number(maxRow.rows[0]?.m ?? 0);
  let total = 0;
  if (lastId > 0) {
    console.log(`  resuming from id=${lastId} (target already has rows)`);
  }
  const startMs = Date.now();

  // Hold up to CONCURRENCY in-flight insert promises. Each iteration of
  // the outer loop fetches one batch from the source and dispatches it
  // for INSERT — but doesn't await unless the in-flight set is at
  // capacity. Round-trip latency to Turso EU is the bottleneck, so
  // pipelining 6 concurrent inserts is ~6× faster than serial.
  const inflight = new Set();
  while (true) {
    const r = await withRetry(`source SELECT id>${lastId}`, () =>
      src.execute({
        sql: `SELECT ${colList} FROM anime_fanarts WHERE id > ? ORDER BY id ASC LIMIT ?`,
        args: [lastId, BATCH],
      })
    );
    if (r.rows.length === 0) break;

    const rows = r.rows;
    lastId = Number(rows[rows.length - 1].id);

    if (DRY_RUN) {
      total += rows.length;
      console.log(`[dry-run] would insert ${rows.length} rows (up to id=${lastId})`);
      continue;
    }

    const p = flushBatch(rows)
      .then(() => {
        total += rows.length;
        const elapsedS = Math.max(1, (Date.now() - startMs) / 1000);
        const rate = Math.round(total / elapsedS);
        console.log(`  copied ${total} rows (up to id=${lastId}, ${rate} rows/s)`);
      })
      .finally(() => inflight.delete(p));
    inflight.add(p);

    if (inflight.size >= CONCURRENCY) {
      // Wait for ANY of the in-flight inserts to finish before queueing
      // another. Keeps memory bounded and the source pagination paced
      // with destination throughput.
      await Promise.race(inflight);
    }
  }

  // Drain whatever's left in flight.
  await Promise.all(inflight);
  console.log(`  ✓ copied ${total} rows total`);
}

async function main() {
  console.log(`→ Source: ${SRC_URL}`);
  console.log(`→ Target: ${DST_URL}`);
  console.log(`→ Batch:  ${BATCH}${DRY_RUN ? "  [DRY-RUN]" : ""}`);

  console.log("\n→ Creating schema on target");
  await createSchemaOnDest();

  console.log("\n→ Copying rows");
  await copyRows();

  console.log("\nDone. Verify on the target with:");
  console.log("  turso db shell <fanarts-db> 'SELECT COUNT(*) FROM anime_fanarts'");
  console.log("\nWhen happy, drop the source table to reclaim row-read budget:");
  console.log("  turso db shell <main-db> 'DROP TABLE anime_fanarts'");
}

main().catch((e) => {
  console.error("✘", e?.message || e);
  process.exit(1);
});
