#!/usr/bin/env node
/**
 * Bulk-fetch fanarts for every anime in our DB that has a tvdb_id or tmdb_id
 * mapping. Inserts URLs into anime_fanarts (NSFW scores are filled later by
 * scripts/classify-fanarts.mjs).
 *
 * fanart.tv exposes ~50 req/min for free keys. We sleep ~1.3s/request with a
 * concurrency of 1 to be safe. With ~8000 mapped anime that's ~3h wall time.
 *
 * Movies hit /v3/movies/<tmdb_id>; everything else /v3/tv/<tvdb_id>.
 *
 * Resume cursor: scrape_state['fanart_bootstrap_idx']
 *
 * Usage:
 *   node scripts/bootstrap-fanarts.mjs
 *   node scripts/bootstrap-fanarts.mjs --restart
 *   node scripts/bootstrap-fanarts.mjs --max=500
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const args = new Set(process.argv.slice(2));
const RESTART = args.has("--restart");
const maxArg = [...args].find((a) => a.startsWith("--max="));
const MAX = maxArg ? Number(maxArg.split("=")[1]) : Infinity;

const KEY = process.env.FANART_API_KEY;
if (!KEY) { console.error("✘ FANART_API_KEY missing"); process.exit(1); }

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const REQUEST_DELAY_MS = 1300; // ~46 req/min, well under their 50/min limit
const STATE_KEY = "fanart_bootstrap_idx";

// fanart.tv uses different category names for TV vs Movies. We normalise to a
// single internal `type` so the API endpoint doesn't have to care which
// upstream the row came from.
//
// Movies categories:  movieposter, moviebackground, moviedisc, moviethumb,
//                     moviebanner, hdmovielogo, hdmovieclearart, movielogo,
//                     movieclearart
// TV categories:      tvposter, showbackground, tvthumb, tvbanner, hdtvlogo,
//                     hdclearart, clearart, clearlogo, characterart,
//                     seasonposter, seasonbanner, seasonthumb
const TV_TYPE_MAP = {
  showbackground:  "background",
  tvposter:        "poster",
  tvthumb:         "thumb",
  tvbanner:        "banner",
  hdtvlogo:        "logo",
  hdclearart:      "clearart",
  clearart:        "clearart",
  clearlogo:       "logo",
  characterart:    "character",
  seasonposter:    "seasonposter",
  seasonbanner:    "seasonbanner",
  seasonthumb:     "seasonthumb",
};
const MOVIE_TYPE_MAP = {
  moviebackground: "background",
  movieposter:     "poster",
  moviethumb:      "thumb",
  moviebanner:     "banner",
  hdmovielogo:     "logo",
  hdmovieclearart: "clearart",
  movieclearart:   "clearart",
  movielogo:       "logo",
  moviedisc:       "disc",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fanartFetch(endpoint, attempt = 1) {
  const MAX_TRIES = 5;
  let res;
  try {
    res = await fetch(endpoint, { headers: { "api-key": KEY } });
  } catch (e) {
    if (attempt >= MAX_TRIES) throw e;
    const wait = Math.min(60_000, 5000 * attempt);
    console.warn(`  ↳ network ${e.cause?.code || e.message}, retry ${attempt}/${MAX_TRIES} in ${wait}ms`);
    await sleep(wait);
    return fanartFetch(endpoint, attempt + 1);
  }
  // 404 = no fanart for this id, treat as empty (not an error)
  if (res.status === 404) return null;
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after") || 30) * 1000;
    console.warn(`  ↳ 429, sleeping ${ra}ms`);
    await sleep(ra);
    return fanartFetch(endpoint, attempt);
  }
  if (res.status >= 500) {
    if (attempt >= MAX_TRIES) throw new Error(`fanart.tv HTTP ${res.status}`);
    const wait = Math.min(60_000, 5000 * attempt);
    console.warn(`  ↳ HTTP ${res.status}, retry ${attempt}/${MAX_TRIES} in ${wait}ms`);
    await sleep(wait);
    return fanartFetch(endpoint, attempt + 1);
  }
  if (!res.ok) throw new Error(`fanart.tv HTTP ${res.status}`);
  return res.json();
}

/** Convert a fanart.tv response into the rows we want to upsert. */
function parseAssets(data, isMovie) {
  if (!data) return [];
  const map = isMovie ? MOVIE_TYPE_MAP : TV_TYPE_MAP;
  const rows = [];
  for (const [category, items] of Object.entries(data)) {
    if (!Array.isArray(items)) continue;
    const internalType = map[category];
    if (!internalType) continue;
    for (const item of items) {
      if (!item.url) continue;
      // fanart.tv returns numeric fields as strings — normalize defensively.
      // Anything non-finite (NaN/Infinity) blows up libsql's bindings.
      const likes = Number.parseInt(item.likes, 10);
      const seasonNum = Number.parseInt(item.season, 10);
      rows.push({
        type:     internalType,
        url:      String(item.url),
        fanartId: item.id != null ? String(item.id) : null,
        language: item.lang ? String(item.lang) : null,
        likes:    Number.isFinite(likes) ? likes : 0,
        season:   Number.isFinite(seasonNum) ? seasonNum : null,
      });
    }
  }
  return rows;
}

async function upsertFanarts(animeId, rows) {
  if (rows.length === 0) return 0;
  const now = Math.floor(Date.now() / 1000);

  // batch INSERT OR IGNORE — UNIQUE(anime_id, type, url) prevents duplicates
  // on re-runs, so we never accidentally double up rows.
  await db.batch(
    rows.map((r) => ({
      sql: `INSERT OR IGNORE INTO anime_fanarts
              (anime_id, type, url, fanart_id, language, likes, season, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [animeId, r.type, r.url, r.fanartId, r.language, r.likes, r.season, now],
    }))
  );
  return rows.length;
}

async function main() {
  // Pull the candidates: anime with a mapping. Order by popularity desc so
  // popular anime get fanarts first (visible feature for users).
  const r = await db.execute(`
    SELECT id, tvdb_id, tmdb_id, format
      FROM anime
     WHERE tvdb_id IS NOT NULL OR tmdb_id IS NOT NULL
     ORDER BY popularity DESC NULLS LAST
  `);
  const rows = r.rows.map((row) => ({
    id:     Number(row.id),
    tvdb:   row.tvdb_id ? Number(row.tvdb_id) : null,
    tmdb:   row.tmdb_id ? Number(row.tmdb_id) : null,
    format: String(row.format || ""),
  }));
  console.log(`→ ${rows.length} anime with mapping`);

  let startIdx = 0;
  if (RESTART) {
    await db.execute({ sql: "DELETE FROM scrape_state WHERE key = ?", args: [STATE_KEY] });
    console.log("→ --restart: cleared progress");
  } else {
    const s = await db.execute({ sql: "SELECT value FROM scrape_state WHERE key = ?", args: [STATE_KEY] });
    if (s.rows[0]) {
      startIdx = Number(s.rows[0].value);
      console.log(`→ Resuming at ${startIdx}/${rows.length}`);
    }
  }

  const t0 = Date.now();
  let processed = 0, withImages = 0, totalImages = 0;

  for (let i = startIdx; i < rows.length && processed < MAX; i++) {
    const a = rows[i];
    const isMovie = a.format === "MOVIE";
    let endpoint = null;
    if (isMovie && a.tmdb) endpoint = `https://webservice.fanart.tv/v3/movies/${a.tmdb}`;
    else if (a.tvdb)       endpoint = `https://webservice.fanart.tv/v3/tv/${a.tvdb}`;
    else if (a.tmdb)       endpoint = `https://webservice.fanart.tv/v3/movies/${a.tmdb}`;
    if (!endpoint) { processed++; continue; }

    const t1 = Date.now();
    let data;
    try { data = await fanartFetch(endpoint); }
    catch (e) {
      console.error(`  ✘ ${a.id} (${endpoint.split("/").slice(-2).join("/")}): ${e.message}`);
      processed++;
      continue;
    }

    const assets = parseAssets(data, isMovie);
    if (assets.length > 0) {
      await upsertFanarts(a.id, assets);
      withImages++;
      totalImages += assets.length;
    }
    processed++;

    // Save resume cursor every 50 entries — not every entry (avoid hammering DB)
    if (processed % 50 === 0) {
      const now = Math.floor(Date.now() / 1000);
      await db.execute({
        sql: `INSERT INTO scrape_state (key, value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        args: [STATE_KEY, String(i + 1), now],
      });

      const elapsed = (Date.now() - t0) / 1000;
      const rate = processed / elapsed;
      const remaining = Math.min(rows.length - (i + 1), MAX - processed);
      const eta = rate > 0 ? Math.round(remaining / rate) : null;
      console.log(
        `  ✓ ${i + 1}/${rows.length} processed — ${withImages} hits, ${totalImages} images — ` +
        `last batch ${Date.now() - t1}ms` +
        (eta !== null ? ` — eta ${Math.floor(eta / 60)}m${eta % 60}s` : "")
      );
    }

    await sleep(REQUEST_DELAY_MS);
  }

  // Cleanup cursor when fully done
  if (processed === rows.length - startIdx) {
    await db.execute({ sql: "DELETE FROM scrape_state WHERE key = ?", args: [STATE_KEY] });
  }

  const dt = Math.round((Date.now() - t0) / 1000);
  console.log(`\n✓ Bootstrap complete in ${Math.floor(dt / 60)}m${dt % 60}s`);
  console.log(`  Processed:  ${processed}`);
  console.log(`  With imgs:  ${withImages}`);
  console.log(`  Total imgs: ${totalImages}`);

  const total = await db.execute("SELECT COUNT(*) AS n FROM anime_fanarts");
  console.log(`  Rows in anime_fanarts: ${total.rows[0].n}`);
}

main().catch((e) => { console.error("\n✘ Crashed:", e); process.exit(1); });
