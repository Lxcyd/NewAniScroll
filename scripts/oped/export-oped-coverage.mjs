/**
 * Export a COVERAGE snapshot from oped_host_skips for the detector's
 * version-based resume. ZERO worker calls, ZERO Upstash — one read of Turso.
 *
 *   node --env-file=.env.local scripts/oped/export-oped-coverage.mjs \
 *        --out=tools/opening-detector/coverage.json
 *
 * Output: which detector host has been processed for each (mal_id, lang), and at
 * what algo_version — the minimum across that panel's episodes, so a partially
 * re-processed anime still shows as stale and gets finished:
 *
 *   { "16498:vostfr": { "sibnet": 1, "megaplay": 2 }, "16498:vf": { "sibnet": 1 } }
 *
 * batch_detect.py --coverage reads this and (re)runs only the hosts that are
 * ABSENT here or below host_versions.json — i.e. a host we just added or fixed
 * (megaplay 1→2 after the de-PNG fix) is re-run on already-processed anime while
 * everything up to date is skipped.
 */
import fs from "node:fs";
import { createClient } from "@libsql/client";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const OUT = args.out || "tools/opening-detector/coverage.json";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// MIN(algo_version) per (mal, lang, host): if ANY episode of a panel is stale,
// the whole (host) counts as stale and gets re-run — never leaves a partial gap.
let rows = [];
try {
  const r = await db.execute(
    `SELECT mal_id, lang, host, MIN(algo_version) AS v
       FROM oped_host_skips
      GROUP BY mal_id, lang, host`,
  );
  rows = r.rows;
} catch (e) {
  // Table absent (first ever run) → empty coverage = "run everything".
  console.warn(`[export-coverage] read failed (${e.message}); emitting empty coverage`);
}

const coverage = {};
for (const row of rows) {
  const key = `${Number(row.mal_id)}:${String(row.lang)}`;
  (coverage[key] ??= {})[String(row.host)] = Number(row.v);
}

fs.writeFileSync(OUT, JSON.stringify(coverage, null, 2), "utf8");
console.log(
  `[export-coverage] ${rows.length} (mal,lang,host) rows → ` +
    `${Object.keys(coverage).length} panels → ${OUT}`,
);
