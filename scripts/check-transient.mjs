import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const r = await db.execute(`
  SELECT
    SUM(CASE WHEN nsfw_label IS NULL AND classification_attempts = 0 THEN 1 ELSE 0 END) AS untouched,
    SUM(CASE WHEN nsfw_label IS NULL AND classification_attempts = 1 THEN 1 ELSE 0 END) AS attempts_1,
    SUM(CASE WHEN nsfw_label IS NULL AND classification_attempts = 2 THEN 1 ELSE 0 END) AS attempts_2,
    SUM(CASE WHEN nsfw_label = 'error-perm' THEN 1 ELSE 0 END) AS error_perm,
    SUM(CASE WHEN nsfw_label LIKE 'manual-error' THEN 1 ELSE 0 END) AS manual_error
  FROM anime_fanarts
`);

const s = r.rows[0];
console.log("État actuel des erreurs :");
console.log(`  Jamais essayé (NULL, 0 attempts):       ${s.untouched}`);
console.log(`  1 échec, à retenter (NULL, 1 attempt):  ${s.attempts_1}`);
console.log(`  2 échecs, à retenter (NULL, 2 attempts):${s.attempts_2}`);
console.log(`  3 échecs → 'error-perm' (DB):           ${s.error_perm}`);
console.log(`  Marquées 'manual-error' par toi:        ${s.manual_error}`);
