#!/usr/bin/env node
/**
 * Image warmer for AniScroll.
 *
 * Fetches every fanart image URL through the Cloudflare Worker proxy
 * with `Accept: image/avif` so Cloudflare Image Transformations
 * generates and caches the AVIF variant. After warming, real users
 * hit the AVIF cache directly (no transformation cost, no latency).
 *
 * Strategy: clearart first (above-the-fold on the anime page), then
 * the rest by type priority. Use --limit to spread the work across
 * months and stay under the 5000 transformations/month free quota.
 *
 * Usage:
 *   node scripts/warm-images.mjs --limit=4000          # warm 4000 images
 *   node scripts/warm-images.mjs --types=clearart      # only clearart
 *   node scripts/warm-images.mjs --skip=4000           # skip first N (resume)
 *   node scripts/warm-images.mjs --since-days=7        # only recent fanarts
 *   node scripts/warm-images.mjs --concurrency=8       # tune parallelism
 *   node scripts/warm-images.mjs --dry-run             # list, don't fetch
 *   node scripts/warm-images.mjs --budget=1000         # stop after N NEW transformations
 *
 * QUOTA AWARENESS — CF bills "unique transformations" per source image per
 * month (5,000 free); re-serving an already-transformed variant from the edge
 * cache is FREE. We read CF-Cache-Status on every response to tell the two
 * apart: HIT = already transformed this month (costs nothing), anything else
 * that ran the resizer (cf-resized header) = one unit of quota consumed.
 * --budget hard-stops the run once that many NEW transformations were spent,
 * so a warm can never blow through the month's allowance. The summary prints
 * the split so you know exactly what a run cost.
 *
 * Env:
 *   TURSO_FANARTS_DATABASE_URL + TURSO_FANARTS_AUTH_TOKEN  (required)
 *   FANART_PROXY_HOST  (default: fanart-proxy.aniscroll.com)
 */
import { createClient } from "@libsql/client";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  })
);
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const SKIP = args.skip ? Number(args.skip) : 0;
const CONCURRENCY = Number(args.concurrency || 6);
const DRY_RUN = args["dry-run"] === "1" || args["dry-run"] === "true";
const TYPES = args.types
  ? args.types.split(",").map((s) => s.trim()).filter(Boolean)
  : null;
const SINCE_DAYS = args["since-days"] ? Number(args["since-days"]) : null;
// Max NEW transformations this run may consume (cache HITs are free and don't
// count). Protects the 5,000/month CF free tier from an over-eager warm.
const BUDGET = args.budget ? Number(args.budget) : Infinity;

const PROXY_HOST = process.env.FANART_PROXY_HOST || "fanart-proxy.aniscroll.com";

const url = process.env.TURSO_FANARTS_DATABASE_URL;
const authToken = process.env.TURSO_FANARTS_AUTH_TOKEN;
if (!url || !authToken) {
  console.error("Missing TURSO_FANARTS_DATABASE_URL / TURSO_FANARTS_AUTH_TOKEN");
  process.exit(1);
}

const db = createClient({ url, authToken });

/* Clearart is above-the-fold on every anime page so warm it first.
   Background/banner come next (used in Hero), then the long tail. */
const TYPE_PRIORITY = `CASE type
  WHEN 'clearart' THEN 0
  WHEN 'hdmovieclearart' THEN 0
  WHEN 'background' THEN 1
  WHEN 'showbackground' THEN 1
  WHEN 'tvbanner' THEN 2
  WHEN 'hdtvlogo' THEN 3
  WHEN 'tvthumb' THEN 4
  ELSE 5
END`;

let sql = `SELECT url, type FROM anime_fanarts
           WHERE nsfw_label IN ('safe', 'safe-skipped', 'manual-safe')`;
const sqlArgs = [];
if (TYPES) {
  const placeholders = TYPES.map(() => "?").join(",");
  sql += ` AND type IN (${placeholders})`;
  sqlArgs.push(...TYPES);
}
if (SINCE_DAYS) {
  const sinceEpoch = Math.floor(Date.now() / 1000) - SINCE_DAYS * 86400;
  sql += ` AND fetched_at >= ?`;
  sqlArgs.push(sinceEpoch);
}
sql += ` ORDER BY ${TYPE_PRIORITY}, likes DESC`;

console.log(
  `[warm-images] querying DB${TYPES ? ` (types: ${TYPES.join(",")})` : ""}${SINCE_DAYS ? ` (last ${SINCE_DAYS}d)` : ""}...`
);
const r = await db.execute({ sql, args: sqlArgs });

function rewrite(u) {
  return u.replace(/^https?:\/\/assets\.fanart\.tv/i, `https://${PROXY_HOST}`);
}

const all = r.rows
  .map((row) => ({ url: rewrite(String(row.url)), type: String(row.type) }))
  .filter((x) => x.url.startsWith(`https://${PROXY_HOST}`));

const slice = all.slice(SKIP, SKIP + LIMIT);
console.log(
  `[warm-images] ${all.length} total, skipping ${SKIP}, warming ${slice.length}`
);

if (DRY_RUN) {
  const byType = {};
  for (const x of slice) byType[x.type] = (byType[x.type] || 0) + 1;
  console.log("[warm-images] DRY RUN — breakdown by type:");
  for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t}: ${n}`);
  }
  process.exit(0);
}

let done = 0;
let ok = 0;
let fail = 0;
let bytes = 0;
let alreadyCached = 0;   // CF-Cache-Status: HIT — already transformed, FREE
let transformed = 0;     // resizer ran on a non-HIT — consumed 1 quota unit
let budgetStop = false;
const t0 = Date.now();

async function visit({ url: u }) {
  try {
    const res = await fetch(u, {
      headers: {
        "User-Agent": "aniscroll-image-warmer/1.0",
        "X-Warmer": "1",
        /* Asking for AVIF triggers the CF Image Transformation pipeline
           with format=auto; CF will negotiate AVIF and cache that variant. */
        Accept: "image/avif,image/webp,image/*;q=0.8",
      },
    });
    if (res.ok) {
      ok++;
      const len = res.headers.get("content-length");
      if (len) bytes += Number(len);
      // Tell a free cache-serve apart from a quota-consuming transformation.
      // HIT = the transformed variant already sat in the edge cache (already
      // transformed this month → costs nothing). Any other status where the
      // resizer ran (cf-resized present) just spent one unique transformation.
      const cacheStatus = (res.headers.get("cf-cache-status") || "").toUpperCase();
      const resized = res.headers.has("cf-resized");
      if (cacheStatus === "HIT") alreadyCached++;
      else if (resized) transformed++;
    } else {
      fail++;
    }
    // Drain nothing: we only needed headers. Cancel the body to save transfer.
    try { await res.body?.cancel(); } catch {}
  } catch {
    fail++;
  }
  done++;
  if (done % 50 === 0 || done === slice.length) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const rate = (done / (Number(elapsed) || 1)).toFixed(1);
    const mb = (bytes / 1024 / 1024).toFixed(1);
    process.stdout.write(
      `\r[warm-images] ${done}/${slice.length}  ok=${ok}  fail=${fail}  cached=${alreadyCached}  new-transforms=${transformed}  ${rate}/s  ${mb}MB  ${elapsed}s   `
    );
  }
}

const queue = slice.slice();
async function worker() {
  while (queue.length) {
    // Hard budget: once N new transformations were consumed, stop pulling
    // work. Already-cached images would still be free, but we can't know
    // which are cached without requesting them — and a non-cached one would
    // overshoot the budget. Stopping is the safe interpretation.
    if (transformed >= BUDGET) { budgetStop = true; return; }
    const item = queue.shift();
    if (!item) return;
    await visit(item);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(
  `\n[warm-images] done in ${elapsed}s — ok=${ok}  fail=${fail}  ${(bytes / 1024 / 1024).toFixed(1)}MB transferred`
);
console.log(
  `[warm-images] quota: ${alreadyCached} already transformed (free), ${transformed} NEW transformations consumed${Number.isFinite(BUDGET) ? ` (budget ${BUDGET})` : ""}${budgetStop ? " — BUDGET REACHED, stopped early" : ""}`
);
process.exit(fail > slice.length / 2 ? 1 : 0);
