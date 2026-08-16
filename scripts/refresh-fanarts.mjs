#!/usr/bin/env node
/**
 * Daily delta refresh of fanarts.
 *
 * Strategy:
 *   1. Read scrape_state['fanart_last_check']
 *   2. fanart.tv exposes /v3/tv/latest?date=<unix> and /v3/movies/latest?date=
 *      → returns the IDs of TVs/movies whose images changed since `date`.
 *   3. Intersect with our DB (anime that have a tvdb_id / tmdb_id matching).
 *   4. For each matched anime, query the regular endpoint and INSERT OR
 *      IGNORE → only new URLs are added (UNIQUE constraint dedupes).
 *   5. Save current timestamp.
 *
 * Why not query everything every day? Because at 8000 anime × 1.3 s/req that's
 * 3 hours of API calls. The /latest endpoint lets us only touch the ~50-200
 * IDs that actually changed in the last 24 h.
 *
 * The classifier is NOT run from here — that's a separate cron step. The
 * fanart_last_check timestamp is saved BEFORE we kick off classification so
 * a classifier crash doesn't make us miss images.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";

const KEY = process.env.FANART_API_KEY;
if (!KEY) { console.error("✘ FANART_API_KEY missing"); process.exit(1); }

// Main DB holds the `anime` table (and scrape_state). Fanarts DB holds
// `anime_fanarts`. When TURSO_FANARTS_DATABASE_URL isn't set both point
// to the same client so deployments that haven't split yet still work.
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const fanartsDb = process.env.TURSO_FANARTS_DATABASE_URL
  ? createClient({
      url: process.env.TURSO_FANARTS_DATABASE_URL,
      authToken: process.env.TURSO_FANARTS_AUTH_TOKEN,
    })
  : db;

const LAST_CHECK_KEY = "fanart_last_check";
const REQUEST_DELAY_MS = 1300;

// Same maps as bootstrap-fanarts.mjs — kept in sync manually.
const TV_TYPE_MAP = {
  showbackground: "background", tvposter: "poster", tvthumb: "thumb",
  tvbanner: "banner", hdtvlogo: "logo", hdclearart: "clearart",
  clearart: "clearart", clearlogo: "logo", characterart: "character",
  seasonposter: "seasonposter", seasonbanner: "seasonbanner", seasonthumb: "seasonthumb",
};
const MOVIE_TYPE_MAP = {
  moviebackground: "background", movieposter: "poster", moviethumb: "thumb",
  moviebanner: "banner", hdmovielogo: "logo", hdmovieclearart: "clearart",
  movieclearart: "clearart", movielogo: "logo", moviedisc: "disc",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchFanart(endpoint, attempt = 1) {
  const MAX_TRIES = 5;
  const TIMEOUT_MS = 60_000;
  let res;
  try {
    res = await fetch(endpoint, {
      headers: { "api-key": KEY },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const code = e.cause?.code || e.code || e.name || e.message;
    if (attempt >= MAX_TRIES) {
      console.warn(`  ↳ ${endpoint.split("/").slice(-2).join("/")}: gave up after ${MAX_TRIES} tries (${code})`);
      throw e;
    }
    const wait = Math.min(60_000, 5000 * attempt);
    console.warn(`  ↳ ${code} on ${endpoint.split("/").slice(-2).join("/")}, retry ${attempt}/${MAX_TRIES} in ${wait}ms`);
    await sleep(wait);
    return fetchFanart(endpoint, attempt + 1);
  }
  if (res.status === 404) return null;
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after") || 30) * 1000;
    console.warn(`  ↳ 429, sleeping ${ra}ms`);
    await sleep(ra);
    return fetchFanart(endpoint, attempt);
  }
  if (res.status >= 500) {
    if (attempt >= MAX_TRIES) throw new Error(`fanart.tv HTTP ${res.status}`);
    const wait = Math.min(60_000, 5000 * attempt);
    await sleep(wait);
    return fetchFanart(endpoint, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function parseAssets(data, isMovie) {
  if (!data) return [];
  const map = isMovie ? MOVIE_TYPE_MAP : TV_TYPE_MAP;
  const rows = [];
  for (const [cat, items] of Object.entries(data)) {
    if (!Array.isArray(items)) continue;
    const internalType = map[cat];
    if (!internalType) continue;
    for (const item of items) {
      if (!item.url) continue;
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
  await fanartsDb.batch(
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
  // Resolve the cutoff timestamp. First run: 7 days ago (so we get a
  // meaningful first delta even on a fresh DB).
  const stateRow = await db.execute({
    sql: "SELECT value FROM scrape_state WHERE key = ?",
    args: [LAST_CHECK_KEY],
  });
  const nowS = Math.floor(Date.now() / 1000);
  const since = stateRow.rows[0]
    ? Number(stateRow.rows[0].value)
    : nowS - 7 * 86400;
  console.log(`→ Last check: ${new Date(since * 1000).toISOString()}`);

  // Pull /latest for both TV and movies. If one fails, log and keep going
  // with an empty set — losing one category is better than crashing.
  let tvLatest = null;
  let latestFailed = false;
  try {
    tvLatest = await fetchFanart(`https://webservice.fanart.tv/v3/tv/latest?date=${since}`);
  } catch (e) {
    latestFailed = true;
    console.warn(`  ↳ TV /latest failed: ${e.message} — continuing without it`);
  }
  const sizeOf = (p) => p == null ? 0 : Array.isArray(p) ? p.length : Object.keys(p).length;
  console.log(`  TV /latest: ${sizeOf(tvLatest)} entries`);
  await sleep(REQUEST_DELAY_MS);

  let movieLatest = null;
  try {
    movieLatest = await fetchFanart(`https://webservice.fanart.tv/v3/movies/latest?date=${since}`);
  } catch (e) {
    latestFailed = true;
    console.warn(`  ↳ Movies /latest failed: ${e.message} — continuing without it`);
  }
  console.log(`  Movies /latest: ${sizeOf(movieLatest)} entries`);

  // fanart.tv /latest returns either:
  //   • an array of { tvdb_id|tmdb_id, name, ... }   (older docs)
  //   • an object keyed by id: { "12345": {...}, "67890": {...} }  (current)
  // Handle both. Filter out the dummy "0" key that sometimes shows up.
  function extractIds(payload) {
    if (!payload) return new Set();
    if (Array.isArray(payload)) {
      return new Set(
        payload
          .map((e) => Number(e?.tvdb_id ?? e?.tmdb_id ?? e?.id))
          .filter((n) => Number.isFinite(n) && n > 0)
      );
    }
    if (typeof payload === "object") {
      return new Set(
        Object.keys(payload)
          .map((k) => Number(k))
          .filter((n) => Number.isFinite(n) && n > 0)
      );
    }
    return new Set();
  }
  const changedTvIds = extractIds(tvLatest);
  const changedMovieIds = extractIds(movieLatest);
  console.log(`  Unique TV ids:    ${changedTvIds.size}`);
  console.log(`  Unique Movie ids: ${changedMovieIds.size}`);

  // Intersect with our DB
  const ourAnime = await db.execute(`
    SELECT id, tvdb_id, tmdb_id, format
      FROM anime
     WHERE tvdb_id IS NOT NULL OR tmdb_id IS NOT NULL
  `);

  const toRefresh = [];
  for (const row of ourAnime.rows) {
    const tvdb = row.tvdb_id ? Number(row.tvdb_id) : null;
    const tmdb = row.tmdb_id ? Number(row.tmdb_id) : null;
    const format = String(row.format || "");
    const isMovie = format === "MOVIE";

    if (isMovie && tmdb && changedMovieIds.has(tmdb)) {
      toRefresh.push({ id: Number(row.id), tmdb, isMovie: true });
    } else if (tvdb && changedTvIds.has(tvdb)) {
      toRefresh.push({ id: Number(row.id), tvdb, isMovie: false });
    } else if (tmdb && changedMovieIds.has(tmdb)) {
      toRefresh.push({ id: Number(row.id), tmdb, isMovie: true });
    }
  }

  console.log(`\n→ ${toRefresh.length} of our anime have changes — refreshing`);
  await sleep(REQUEST_DELAY_MS);

  const t0 = Date.now();
  let added = 0;
  for (let i = 0; i < toRefresh.length; i++) {
    const a = toRefresh[i];
    const endpoint = a.isMovie
      ? `https://webservice.fanart.tv/v3/movies/${a.tmdb}`
      : `https://webservice.fanart.tv/v3/tv/${a.tvdb}`;
    try {
      const data = await fetchFanart(endpoint);
      const assets = parseAssets(data, a.isMovie);
      if (assets.length > 0) {
        await upsertFanarts(a.id, assets);
        added += assets.length;
      }
    } catch (e) {
      console.error(`  ✘ ${a.id} (${endpoint.split("/").slice(-2).join("/")}): ${e.message}`);
    }
    if ((i + 1) % 25 === 0) {
      console.log(`  ✓ ${i + 1}/${toRefresh.length} processed — ${added} URL(s) added (so far)`);
    }
    if (i < toRefresh.length - 1) await sleep(REQUEST_DELAY_MS);
  }

  const dt = Math.round((Date.now() - t0) / 1000);
  console.log(`\n✓ Refresh done in ${Math.floor(dt / 60)}m${dt % 60}s — ${added} URL(s) added (INSERT OR IGNORE deduped)`);

  /*
   * THE CURSOR ONLY MOVES OVER GROUND WE ACTUALLY COVERED.
   *
   * `/latest?date=` is the only view we have of what changed, and it is a
   * WINDOW, not a queue: ask it about the wrong interval and the changes in the
   * right one are not late, they are gone. So when one of the two calls above
   * failed, the run saw nothing for that half of the catalogue — and it used to
   * write `last_check = now` all the same, which closes the window on a period
   * nobody ever looked at. A fanart.tv outage of a few days therefore punched a
   * permanent hole in the images, and left a green tick behind it.
   *
   * Leaving the cursor where it is costs one wider query on the next run —
   * `/latest` takes any date, so the missed days are simply included — and the
   * inserts are `INSERT OR IGNORE`, so re-covering ground is free.
   *
   * Still saved BEFORE the classifier: if that crashes we do not want to
   * re-pull the same images, only to re-classify them.
   */
  if (latestFailed) {
    console.error(
      `::error::/latest partly failed — last_check left at ${since} ` +
      `(${new Date(since * 1000).toISOString()}) so the next run re-covers this window`
    );
    process.exitCode = 1;
    return;
  }

  await db.execute({
    sql: `INSERT INTO scrape_state (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    args: [LAST_CHECK_KEY, String(nowS), nowS],
  });
  console.log(`  Saved last_check = ${nowS} (${new Date(nowS * 1000).toISOString()})`);
}

main().catch((e) => { console.error("\n✘ Crashed:", e); process.exit(1); });
