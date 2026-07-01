#!/usr/bin/env node
/**
 * Purge the cached season-mapping keys from Redis.
 *
 * Season keys are versioned (seasonChain:v2:, seasonList:v7:), so a version
 * bump already stops the old keys from ever being read. This script removes
 * them for real — both the stale older versions AND the current version — so
 * the very next request recomputes everything with the freshly ingested Fribb
 * data (canonical franchise + TMDB restriction).
 *
 * Uses SCAN (never KEYS) so it is safe against a production Redis.
 *
 * Usage:
 *   node scripts/purge-season-cache.mjs            # dry-run: only counts
 *   node scripts/purge-season-cache.mjs --delete   # actually delete
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { Redis } from "ioredis";

const DELETE = new Set(process.argv.slice(2)).has("--delete");
const PATTERNS = ["seasonChain:*", "seasonList:*"];

const url = process.env.REDIS_URL;
if (!url) {
  console.error("✘ REDIS_URL missing (put it in .env.local)");
  process.exit(1);
}

const redis = new Redis(url);

async function purge(pattern) {
  let cursor = "0";
  let found = 0;
  let deleted = 0;
  do {
    const [next, keys] = await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      500
    );
    cursor = next;
    if (keys.length) {
      found += keys.length;
      if (DELETE) {
        await redis.del(...keys);
        deleted += keys.length;
      }
    }
  } while (cursor !== "0");
  return { found, deleted };
}

async function main() {
  for (const pattern of PATTERNS) {
    const { found, deleted } = await purge(pattern);
    if (DELETE) {
      console.log(`✓ ${pattern}: deleted ${deleted} keys`);
    } else {
      console.log(`• ${pattern}: ${found} keys match (dry-run, none deleted)`);
    }
  }
  if (!DELETE) {
    console.log("\nRe-run with --delete to actually purge.");
  }
}

main()
  .then(() => redis.quit())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("✘ purge failed:", e);
    process.exit(1);
  });
