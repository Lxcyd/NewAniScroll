#!/usr/bin/env node
/**
 * Smoke-test fanart.tv API for one anime to validate the key + URL shape.
 *
 * Picks a popular anime from our DB, queries fanart.tv with its tvdb_id,
 * prints the asset shape so we know what to store.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const KEY = process.env.FANART_API_KEY;
if (!KEY) { console.error("✘ FANART_API_KEY missing"); process.exit(1); }

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Pick the most popular anime that has both tvdb and tmdb mapped
const r = await db.execute(`
  SELECT id, tvdb_id, tmdb_id, format,
         json_extract(data,'$.title.userPreferred') AS title
    FROM anime
   WHERE tvdb_id IS NOT NULL OR tmdb_id IS NOT NULL
   ORDER BY popularity DESC LIMIT 5
`);

for (const row of r.rows) {
  console.log(`\n=== ${row.title} (anilist=${row.id}, tvdb=${row.tvdb_id}, tmdb=${row.tmdb_id}, format=${row.format}) ===`);

  // Pick endpoint based on format
  const isMovie = row.format === "MOVIE";
  const endpoint = isMovie && row.tmdb_id
    ? `https://webservice.fanart.tv/v3/movies/${row.tmdb_id}`
    : row.tvdb_id
    ? `https://webservice.fanart.tv/v3/tv/${row.tvdb_id}`
    : null;

  if (!endpoint) { console.log("  no compatible id"); continue; }

  const t1 = Date.now();
  const res = await fetch(endpoint, { headers: { "api-key": KEY } });
  const dt = Date.now() - t1;
  console.log(`  HTTP ${res.status} in ${dt}ms`);

  if (!res.ok) {
    console.log(`  body:`, (await res.text()).slice(0, 200));
    continue;
  }
  const data = await res.json();
  // Print all top-level keys (asset categories)
  console.log(`  categories:`, Object.keys(data).filter(k => Array.isArray(data[k])));
  // Show one sample of each
  for (const k of Object.keys(data)) {
    if (!Array.isArray(data[k])) continue;
    if (data[k].length === 0) continue;
    const sample = data[k][0];
    console.log(`  ${k}[0]:`, JSON.stringify(sample));
  }
}
