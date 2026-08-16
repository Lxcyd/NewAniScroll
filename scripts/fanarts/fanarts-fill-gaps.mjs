/**
 * Fill the row-count gap between the source `anime_fanarts` and the
 * (already-migrated) target. The main migration uses MAX(id) on the
 * target as its resume cursor, which means any batch that silently
 * crashed AFTER a later batch succeeded leaves a permanent hole — the
 * cursor jumps past the missing ids and never comes back.
 *
 * This script walks the source by id (small chunks) and INSERT-OR-
 * IGNOREs every row. Rows already on the target are no-ops; rows that
 * fell into a gap finally land. Fast: only the 2k missing rows
 * actually write to the target.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const BATCH = 1000;

const src = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const dst = createClient({
  url: process.env.TURSO_FANARTS_DATABASE_URL,
  authToken: process.env.TURSO_FANARTS_AUTH_TOKEN,
});

async function withRetry(label, fn) {
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const wait = 1000 * Math.pow(2, attempt);
      console.warn(`  ⚠ ${label} (try ${attempt + 1}/5): ${e?.message} — wait ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

const colInfo = await src.execute("PRAGMA table_info(anime_fanarts)");
const cols = colInfo.rows.map((r) => String(r.name));
const colList = cols.join(", ");
const rowPlaceholder = `(${cols.map(() => "?").join(", ")})`;

let lastId = 0;
let scanned = 0;
let inserted = 0;
const startMs = Date.now();

while (true) {
  const r = await withRetry(`SELECT id>${lastId}`, () =>
    src.execute({
      sql: `SELECT ${colList} FROM anime_fanarts WHERE id > ? ORDER BY id ASC LIMIT ?`,
      args: [lastId, BATCH],
    })
  );
  if (r.rows.length === 0) break;

  const values = Array(r.rows.length).fill(rowPlaceholder).join(", ");
  const args = [];
  for (const row of r.rows) for (const c of cols) args.push(row[c]);
  const res = await withRetry("INSERT OR IGNORE", () =>
    dst.execute({
      sql: `INSERT OR IGNORE INTO anime_fanarts (${colList}) VALUES ${values}`,
      args,
    })
  );

  scanned += r.rows.length;
  inserted += Number(res.rowsAffected ?? 0);
  lastId = Number(r.rows[r.rows.length - 1].id);

  if (scanned % 10000 < BATCH) {
    const elapsedS = Math.max(1, (Date.now() - startMs) / 1000);
    console.log(
      `  scanned ${scanned}, inserted ${inserted} new (up to id=${lastId}, ${Math.round(
        scanned / elapsedS
      )} rows/s)`
    );
  }
}

console.log(`\n✓ done: scanned ${scanned}, inserted ${inserted} new rows`);
