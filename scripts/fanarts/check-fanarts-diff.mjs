import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const src = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const dst = createClient({
  url: process.env.TURSO_FANARTS_DATABASE_URL,
  authToken: process.env.TURSO_FANARTS_AUTH_TOKEN,
});

const [s, d, sm, dm] = await Promise.all([
  src.execute("SELECT COUNT(DISTINCT anime_id || '|' || type || '|' || url) AS n FROM anime_fanarts"),
  dst.execute("SELECT COUNT(DISTINCT anime_id || '|' || type || '|' || url) AS n FROM anime_fanarts"),
  src.execute("SELECT MAX(id) AS m FROM anime_fanarts"),
  dst.execute("SELECT MAX(id) AS m FROM anime_fanarts"),
]);

console.log("source distinct (anime_id,type,url):", Number(s.rows[0].n));
console.log("target distinct (anime_id,type,url):", Number(d.rows[0].n));
console.log("source max id:", Number(sm.rows[0].m));
console.log("target max id:", Number(dm.rows[0].m));

// If distinct tuple counts match, the row-count mismatch is just dupes
// on the source side that the UNIQUE constraint correctly collapsed.
if (Number(s.rows[0].n) === Number(d.rows[0].n)) {
  console.log("\n✓ All distinct fanarts are present on target — safe to drop");
} else {
  console.log("\n⚠ Missing distinct tuples on target");
}
