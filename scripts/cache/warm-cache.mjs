#!/usr/bin/env node
/**
 * Cache warmer for AniScroll.
 *
 * Visits every anime page (and triggers fanart requests through the
 * Cloudflare Worker proxy) so the first real visitor of each region
 * hits a warm CDN cache instead of paying the cold-start penalty.
 *
 * Default mode is **delta**: only anime whose fanarts were fetched in
 * the last --since-days days get warmed. First run after deploy should
 * use --full to seed the cache for the entire catalog.
 *
 * Usage:
 *   node scripts/cache/warm-cache.mjs                  # delta (last 7 days)
 *   node scripts/cache/warm-cache.mjs --since-days=14  # delta (last 14 days)
 *   node scripts/cache/warm-cache.mjs --full           # warm everything
 *   node scripts/cache/warm-cache.mjs --limit=200      # cap visits
 *   node scripts/cache/warm-cache.mjs --concurrency=8  # tune parallelism
 *
 * Env:
 *   SITE_URL          (default: https://aniscroll.com)
 *   TURSO_FANARTS_DATABASE_URL + TURSO_FANARTS_AUTH_TOKEN  (required)
 *
 * Sends `User-Agent: aniscroll-warmer` + `X-Warmer: 1` so /api/v2/track
 * skips us — visitor stats stay clean.
 */
import { createClient } from "@libsql/client";

const SITE = (process.env.SITE_URL || "https://aniscroll.com").replace(/\/$/, "");
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  })
);
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const CONCURRENCY = Number(args.concurrency || 6);
const FULL = args.full === "1" || args.full === "true";
const SINCE_DAYS = Number(args["since-days"] || 7);

const url = process.env.TURSO_FANARTS_DATABASE_URL;
const authToken = process.env.TURSO_FANARTS_AUTH_TOKEN;
if (!url || !authToken) {
  console.error("Missing TURSO_FANARTS_DATABASE_URL / TURSO_FANARTS_AUTH_TOKEN");
  process.exit(1);
}

const db = createClient({ url, authToken });

let r;
if (FULL) {
  console.log(`[warm] FULL mode — listing all anime ids...`);
  r = await db.execute(
    "SELECT DISTINCT anime_id FROM anime_fanarts ORDER BY anime_id"
  );
} else {
  const sinceEpoch = Math.floor(Date.now() / 1000) - SINCE_DAYS * 86400;
  console.log(
    `[warm] DELTA mode — anime with fanarts fetched in last ${SINCE_DAYS}d (since epoch ${sinceEpoch})`
  );
  r = await db.execute({
    sql: "SELECT DISTINCT anime_id FROM anime_fanarts WHERE fetched_at >= ? ORDER BY anime_id",
    args: [sinceEpoch],
  });
}
const ids = r.rows.map((row) => Number(row.anime_id)).filter(Boolean);
const total = Math.min(ids.length, LIMIT);
console.log(`[warm] ${ids.length} anime ids total, warming first ${total}`);

let done = 0;
let ok = 0;
let fail = 0;
const t0 = Date.now();

async function visit(id) {
  const target = `${SITE}/en/anime/${id}`;
  try {
    const res = await fetch(target, {
      headers: {
        "User-Agent": "aniscroll-warmer/1.0",
        "X-Warmer": "1",
        Accept: "text/html",
      },
      redirect: "follow",
    });
    if (res.ok) ok++;
    else fail++;
  } catch {
    fail++;
  }
  done++;
  if (done % 25 === 0 || done === total) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const rate = (done / (elapsed || 1)).toFixed(1);
    process.stdout.write(
      `\r[warm] ${done}/${total}  ok=${ok}  fail=${fail}  ${rate}/s  ${elapsed}s`
    );
  }
}

// simple bounded-concurrency worker pool
const slice = ids.slice(0, total);
const queue = slice.slice();
async function worker() {
  while (queue.length) {
    const id = queue.shift();
    if (id == null) return;
    await visit(id);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(
  `\n[warm] done in ${elapsed}s — ok=${ok}  fail=${fail}  rate=${(
    done /
    (Number(elapsed) || 1)
  ).toFixed(1)}/s`
);
process.exit(fail > total / 2 ? 1 : 0);
