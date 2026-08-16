#!/usr/bin/env node
/**
 * One-shot cleanup for user_analytics.
 *
 * The first version of the tracking endpoint only had a permissive UA
 * blocklist, so many crawlers and probes that spoofed `User-Agent:
 * Chrome/...` slipped through and counted as unique visitors. After
 * the filter was hardened (track.ts: BROWSER_UA + Accept-Language +
 * Sec-Fetch-Site checks), the historical rows are still polluting
 * the COUNT(DISTINCT visitor_id) on the admin dashboard.
 *
 * This script applies the same heuristics retroactively:
 *   - DELETE rows whose user_agent matches the bot blocklist
 *   - DELETE rows whose user_agent doesn't match the browser pattern
 *   - DELETE rows from visitor_ids that have only ever produced ONE
 *     pageview total (real users hit at least 2-3 pages on a session)
 *
 * Usage:
 *   node scripts/audit/purge-fake-visitors.mjs --dry-run   # show counts only
 *   node scripts/audit/purge-fake-visitors.mjs             # actually delete
 *
 * Env:
 *   TURSO_ADMIN_URL + TURSO_ADMIN_TOKEN  (required)
 */
import { createClient } from "@libsql/client";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  })
);
const DRY = args["dry-run"] === "1" || args["dry-run"] === "true";

const url = process.env.TURSO_ADMIN_URL;
const authToken = process.env.TURSO_ADMIN_TOKEN;
if (!url) {
  console.error("Missing TURSO_ADMIN_URL");
  process.exit(1);
}

const db = createClient({ url, authToken });

/* Keep these two regexes in sync with pages/api/v2/track.ts. SQLite's
   REGEXP isn't available out of the box on Turso, so we evaluate the
   match in JS by streaming rows. The table is small enough (<1M rows)
   that this is fine; if it ever grows we can move to a CTE + GLOB. */
const BOT_UA = /(bot|crawl|spider|headless|scrapy|favicon|vercel|prerender|preview|warmer|wget|curl|axios|node-fetch|python|java|ruby|go-http|httpclient|okhttp|libwww|lighthouse|pagespeed|gtmetrix|pingdom|uptimerobot|yandex|baidu|duckduck|semrush|ahrefs|mj12|dotbot|petalbot)/i;
const BROWSER_UA = /(Mozilla\/5\.0).*(Chrome|Firefox|Safari|Edg|OPR|Opera)\//;

console.log(`[purge] querying user_analytics...`);
const rows = (await db.execute("SELECT id, visitor_id, user_agent FROM user_analytics")).rows;
console.log(`[purge] ${rows.length} rows total`);

const idsToDelete = new Set();
const visitorsToDelete = new Set();

for (const r of rows) {
  const ua = String(r.user_agent || "");
  if (!ua) {
    idsToDelete.add(Number(r.id));
    continue;
  }
  if (BOT_UA.test(ua)) {
    idsToDelete.add(Number(r.id));
    continue;
  }
  if (!BROWSER_UA.test(ua)) {
    idsToDelete.add(Number(r.id));
  }
}

/* Second pass: collapse visitor_ids with only 1 pageview total
   (skipping rows already marked for deletion). Genuine humans
   browse at least a couple of pages; one-hit-only IDs are almost
   always probes / link previews. */
const remaining = rows.filter((r) => !idsToDelete.has(Number(r.id)));
const countByVisitor = new Map();
for (const r of remaining) {
  const v = String(r.visitor_id);
  countByVisitor.set(v, (countByVisitor.get(v) || 0) + 1);
}
for (const [v, n] of countByVisitor) {
  if (n <= 1) visitorsToDelete.add(v);
}

const totalUniqueBefore = new Set(rows.map((r) => String(r.visitor_id))).size;
const totalUniqueAfter = new Set(
  remaining
    .filter((r) => !visitorsToDelete.has(String(r.visitor_id)))
    .map((r) => String(r.visitor_id))
).size;

console.log(`[purge] would delete:`);
console.log(`  - ${idsToDelete.size} rows by UA filter`);
console.log(`  - ${visitorsToDelete.size} singleton visitor_ids`);
console.log(`[purge] unique visitor_ids: ${totalUniqueBefore} -> ${totalUniqueAfter}`);

if (DRY) {
  console.log("[purge] DRY RUN — no deletes performed");
  process.exit(0);
}

/* Batched DELETEs: Turso's HTTP API limits each statement size and the
   `IN (?, ?, ...)` list can't grow unbounded. Chunk to 200 ids per call. */
async function deleteInChunks(sql, values) {
  const CHUNK = 200;
  let done = 0;
  for (let i = 0; i < values.length; i += CHUNK) {
    const slice = values.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    await db.execute({ sql: sql.replace("?LIST?", placeholders), args: slice });
    done += slice.length;
    process.stdout.write(`\r[purge] ${done}/${values.length}   `);
  }
  if (values.length) process.stdout.write("\n");
}

if (idsToDelete.size) {
  console.log(`[purge] deleting ${idsToDelete.size} rows by id...`);
  await deleteInChunks(
    "DELETE FROM user_analytics WHERE id IN (?LIST?)",
    [...idsToDelete]
  );
}

if (visitorsToDelete.size) {
  console.log(`[purge] deleting rows for ${visitorsToDelete.size} singleton visitors...`);
  await deleteInChunks(
    "DELETE FROM user_analytics WHERE visitor_id IN (?LIST?)",
    [...visitorsToDelete]
  );
}

const after = (await db.execute("SELECT COUNT(*) AS c, COUNT(DISTINCT visitor_id) AS v FROM user_analytics")).rows[0];
console.log(`[purge] done — ${after.c} rows, ${after.v} unique visitors`);
