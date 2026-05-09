#!/usr/bin/env node
/**
 * Populate `tvdb_id` and `tmdb_id` on the `anime` table by joining against
 * Fribb/anime-lists.
 *
 * Why Fribb and not manami-project? manami-project's offline dump only ships
 * AniList / MAL / Kitsu / AniDB IDs — not TVDB or TMDB. Fribb republishes a
 * flat JSON with every cross-reference (anilist_id, tvdb_id, themoviedb_id…)
 * which is what we actually need to query fanart.tv.
 *
 * Mapping is keyed on AniList ID. Anime that aren't in the dump (obscure or
 * brand-new) won't get a TVDB id and will simply be skipped by the fanart
 * fetch.
 *
 * Usage:
 *   node scripts/map-tvdb.mjs                    # download + map
 *   node scripts/map-tvdb.mjs --json=./mini.json # use a local file
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@libsql/client";
import { writeFile, readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";

const args = process.argv.slice(2);
const jsonArg = args.find((a) => a.startsWith("--json="));
const localJsonPath = jsonArg ? jsonArg.split("=")[1] : null;

const FRIBB_URL =
  "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json";
const CACHE_DIR = "./.cache";
const CACHE_PATH = `${CACHE_DIR}/fribb-anime-list.json`;

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
  console.error("✘ TURSO env missing");
  process.exit(1);
}
const db = createClient({ url, authToken });

async function loadDump() {
  if (localJsonPath) {
    console.log(`→ Reading local dump: ${localJsonPath}`);
    const raw = await readFile(localJsonPath, "utf8");
    return JSON.parse(raw);
  }

  if (existsSync(CACHE_PATH)) {
    console.log(`→ Using cached dump: ${CACHE_PATH}`);
    const raw = await readFile(CACHE_PATH, "utf8");
    return JSON.parse(raw);
  }

  console.log(`→ Downloading: ${FRIBB_URL}`);
  const res = await fetch(FRIBB_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading dump`);
  const text = await res.text();
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_PATH, text, "utf8");
  console.log(`  ✓ cached to ${CACHE_PATH} (${(text.length / 1024 / 1024).toFixed(1)} MB)`);
  return JSON.parse(text);
}

async function main() {
  const t0 = Date.now();
  const dump = await loadDump();
  // Fribb dump is a flat array of entries.
  const entries = Array.isArray(dump) ? dump : dump.data || [];
  console.log(`→ Dump has ${entries.length} entries`);

  // Build the {anilistId: {tvdb, tmdb}} map.
  // Fribb fields: anilist_id, tvdb_id, themoviedb_id (snake_case, integers).
  const map = new Map();
  for (const entry of entries) {
    const anilistId = entry.anilist_id;
    if (!anilistId) continue;
    const tvdbId = entry.tvdb_id ?? null;
    const tmdbId = entry.themoviedb_id ?? null;
    if (tvdbId || tmdbId) {
      map.set(Number(anilistId), { tvdb: tvdbId, tmdb: tmdbId });
    }
  }
  console.log(`→ Built ${map.size} AniList → (TVDB/TMDB) mappings`);

  // Pull the IDs we have in DB, intersect with the map.
  const r = await db.execute("SELECT id FROM anime");
  const ourIds = new Set(r.rows.map((row) => Number(row.id)));
  console.log(`→ ${ourIds.size} anime in DB`);

  // Build the update batches
  const updates = [];
  for (const id of ourIds) {
    const m = map.get(id);
    if (m) updates.push({ id, tvdb: m.tvdb, tmdb: m.tmdb });
  }
  console.log(`→ ${updates.length} anime in DB will get a mapping`);

  // Apply in batches of 200 (libsql can handle large batches but small enough
  // to be friendly to bandwidth).
  const BATCH = 200;
  let written = 0;
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH);
    await db.batch(
      batch.map((u) => ({
        sql: "UPDATE anime SET tvdb_id = ?, tmdb_id = ? WHERE id = ?",
        args: [u.tvdb, u.tmdb, u.id],
      }))
    );
    written += batch.length;
    if (written % 1000 === 0 || i + BATCH >= updates.length) {
      console.log(`  ✓ ${written}/${updates.length} updated`);
    }
  }

  // Stats
  const stats = await db.execute(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN tvdb_id IS NOT NULL THEN 1 ELSE 0 END) AS with_tvdb,
      SUM(CASE WHEN tmdb_id IS NOT NULL THEN 1 ELSE 0 END) AS with_tmdb
    FROM anime
  `);
  const s = stats.rows[0];
  console.log(`\n✓ Mapping done in ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`  Total anime:        ${s.total}`);
  console.log(`  With TVDB id:       ${s.with_tvdb}`);
  console.log(`  With TMDB id:       ${s.with_tmdb}`);
}

main().catch((e) => {
  console.error("\n✘ Failed:", e);
  process.exit(1);
});
