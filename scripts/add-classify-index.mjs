#!/usr/bin/env node
/**
 * Add a composite index that matches the classifier's hot query exactly:
 *
 *   SELECT url, MIN(id), COUNT(*)
 *     FROM anime_fanarts
 *    WHERE nsfw_label IS NULL
 *      AND classification_attempts < ?
 *      AND type NOT IN ('logo','disc')
 *    GROUP BY url
 *    LIMIT 500
 *
 * Without an index covering `nsfw_label` + `type`, SQLite scans all 122k
 * rows on every batch — millions of wasted reads. The composite index
 * lets it skip directly to the unclassified slice.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

console.log("→ Creating composite index for classifier hot query…");
await db.execute(`
  CREATE INDEX IF NOT EXISTS idx_fanart_classifier
    ON anime_fanarts (nsfw_label, type, classification_attempts)
`);
console.log("  ✓ idx_fanart_classifier ready");

// Also add an index on url for the bulk UPDATE...WHERE url = ? we do later
console.log("→ Creating index on url for bulk fan-out updates…");
await db.execute(`
  CREATE INDEX IF NOT EXISTS idx_fanart_url
    ON anime_fanarts (url)
`);
console.log("  ✓ idx_fanart_url ready");

console.log("\n✓ Done. Hot queries will now use the index.");
