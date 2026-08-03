#!/usr/bin/env node
// Usage Monitor — daily diagnostic collector.
//
// Pulls the sources that actually explain AniScroll's cost/usage problems and
// writes a dated snapshot + a markdown report with day-over-day deltas:
//   1. Upstash keyspace CENSUS (REST)  → where the Redis load lives (by prefix).
//   2. Upstash daily-requests (mgmt)   → the "Daily Commands" chart + cap projection.
//   3. Vercel recent deployments (API) → correlate a usage spike with a release.
//
// Run:  node tools/usage-monitor/collect.mjs
// Creds: reads .env.local automatically (REDIS_URL is enough for the census).
//   Optional: UPSTASH_EMAIL + UPSTASH_API_KEY (daily chart), VERCEL_TOKEN (deploys).
//
// See README.md for setup and the daily GitHub Action.

import { join } from "node:path";
import { writeFileSync } from "node:fs";
import {
  loadDotEnv,
  resolveRestConfig,
  resolveMgmtConfig,
  resolveVercelConfig,
  REPO_ROOT,
} from "./lib/env.mjs";
import { censusKeyspace, fetchUpstashStats } from "./lib/upstash.mjs";
import { collectVercel } from "./lib/vercel.mjs";
import {
  loadPreviousSnapshot,
  writeSnapshot,
  renderReport,
  appendHistory,
} from "./lib/report.mjs";

const TOOL_DIR = join(REPO_ROOT, "tools", "usage-monitor");
const SNAPSHOTS_DIR = join(TOOL_DIR, "snapshots");

async function main() {
  loadDotEnv();

  const date = new Date().toISOString().slice(0, 10);
  const snapshot = {
    date,
    generatedAt: new Date().toISOString(),
    census: null,
    upstashStats: null,
    vercel: null,
  };

  // 1. Keyspace census (the money shot — needs only REDIS_URL).
  const rest = resolveRestConfig();
  if (rest) {
    try {
      console.log("• census: scanning keyspace…");
      snapshot.census = await censusKeyspace(rest);
      console.log(`  → DBSIZE ${snapshot.census.dbsize}, scanned ${snapshot.census.scanned}`);
    } catch (e) {
      snapshot.census = { error: e.message };
      console.warn(`  ! census failed: ${e.message}`);
    }
  } else {
    snapshot.census = { error: "no Redis REST config (set REDIS_URL or UPSTASH_REDIS_REST_URL/_TOKEN)" };
    console.warn("• census: skipped (no Redis config)");
  }

  // 2. Upstash daily-requests (management API — optional).
  const mgmt = resolveMgmtConfig();
  if (mgmt) {
    try {
      console.log("• upstash stats: fetching daily requests…");
      snapshot.upstashStats = await fetchUpstashStats(mgmt);
      console.log(`  → today ${snapshot.upstashStats.today}, proj ${snapshot.upstashStats.projectedCapPct}% of cap`);
    } catch (e) {
      snapshot.upstashStats = { error: e.message };
      console.warn(`  ! upstash stats failed: ${e.message}`);
    }
  } else {
    console.log("• upstash stats: skipped (no UPSTASH_EMAIL / UPSTASH_API_KEY)");
  }

  // 3. Vercel deployments (optional).
  const vercel = resolveVercelConfig();
  if (vercel) {
    console.log("• vercel: fetching deployments…");
    snapshot.vercel = await collectVercel(vercel);
  } else {
    console.log("• vercel: skipped (no VERCEL_TOKEN)");
  }

  // Persist + report.
  const file = `${date}.json`;
  const prev = loadPreviousSnapshot(SNAPSHOTS_DIR, file);
  writeSnapshot(SNAPSHOTS_DIR, file, snapshot);

  const report = renderReport(snapshot, prev);
  writeFileSync(join(TOOL_DIR, "LATEST.md"), report);
  appendHistory(join(TOOL_DIR, "HISTORY.md"), snapshot);

  console.log("\n" + report);
  console.log(`\n✓ snapshot → tools/usage-monitor/snapshots/${file}`);
  console.log("✓ report   → tools/usage-monitor/LATEST.md");

  // Fail LOUDLY when nothing was actually collected. Every collector above
  // degrades gracefully on purpose (a missing VERCEL_TOKEN must not lose the
  // Upstash census), but "all three skipped" is not a degraded run — it is a
  // monitor that reports nothing while staying green, which is precisely how
  // this tool sat dead from 30/07 to 03/08 without anyone noticing. A red run
  // is the signal that the secrets are missing.
  const censusOk = !!snapshot.census && !snapshot.census.error;
  const statsOk = !!snapshot.upstashStats && !snapshot.upstashStats.error;
  if (!censusOk && !statsOk) {
    console.error(
      "\n✗ no Upstash data collected — set UPSTASH_REDIS_REST_URL/_TOKEN " +
        "(census) and/or UPSTASH_EMAIL/UPSTASH_API_KEY (daily requests).",
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("usage-monitor failed:", e);
  process.exit(1);
});
