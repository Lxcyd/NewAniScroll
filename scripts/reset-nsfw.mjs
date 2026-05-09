#!/usr/bin/env node
/**
 * Wipe every NSFW classification field on anime_fanarts so the new WD14
 * classifier starts from scratch. Manual reviews (label LIKE 'manual-%')
 * are preserved — those are user truth, never re-decided by an IA.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

console.log("→ Resetting IA classification state (manual-* labels preserved)…");
const r = await db.execute(`
  UPDATE anime_fanarts SET
    classified_at = NULL,
    classification_attempts = 0,
    nsfw_safe = NULL,
    nsfw_score = NULL,
    nsfw_label = NULL
  WHERE nsfw_label IS NULL
     OR nsfw_label NOT LIKE 'manual-%'
`);
console.log(`  ✓ reset ${r.rowsAffected} row(s)`);

const stats = await db.execute(`
  SELECT
    SUM(CASE WHEN nsfw_label IS NULL THEN 1 ELSE 0 END)        AS unclassified,
    SUM(CASE WHEN nsfw_label LIKE 'manual-%' THEN 1 ELSE 0 END) AS manual_kept
  FROM anime_fanarts
`);
const s = stats.rows[0];
console.log(`\n  Unclassified now: ${s.unclassified}`);
console.log(`  Manual kept:      ${s.manual_kept}`);
