#!/usr/bin/env node
/**
 * Force every row in the cache to be stale.
 *
 * Sets expires_at = 0 so the next read of any anime triggers a background
 * refresh (stale-while-revalidate). Doesn't delete data — UI keeps working
 * with the old shape until the refresh completes.
 *
 * Useful after changing the Tier-1 query shape (added/removed fields) so
 * the cache progressively migrates to the new shape as users browse.
 *
 * Usage: node scripts/invalidate-cache.mjs
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

console.log("→ Marking all rows as stale (expires_at = 0)…");
const r = await db.execute("UPDATE anime SET expires_at = 0");
console.log(`✓ Invalidated ${r.rowsAffected} row(s).`);
console.log("\nThe data still serves immediately. Each anime visited triggers");
console.log("a background re-fetch from AniList that pulls the new query shape.");
