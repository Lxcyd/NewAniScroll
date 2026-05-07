#!/usr/bin/env node
/**
 * Full bootstrap of the Turso anime cache from AniList.
 *
 * Pages AniList (50 per request, sort: ID_DESC) and inserts every anime into
 * the cache. Designed to be:
 *   • Resumable — progress (last completed page) is saved to scrape_state.
 *     Re-running picks up where it stopped. Use --restart to start from page 1.
 *   • Rate-limit safe — AniList allows ~30 req/min anonymous. We sleep 2.1s
 *     between requests by default, plus respect the X-RateLimit-Remaining
 *     header when AniList tells us to back off.
 *   • Idempotent — `upsertAnime` merges on conflict, so running this twice
 *     doesn't break anything.
 *
 * Approximate timings:
 *   • ~22 000 anime / 50 per page = ~440 pages
 *   • 2.1s/page × 440 = ~15 min
 *
 * Usage:
 *   node scripts/bootstrap-cache.mjs                  # resume from saved page
 *   node scripts/bootstrap-cache.mjs --restart        # start from page 1
 *   node scripts/bootstrap-cache.mjs --max-pages=10   # only fetch 10 pages
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@libsql/client";

// ─── CLI args ────────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2));
const RESTART = args.has("--restart");
const maxPagesArg = [...args].find((a) => a.startsWith("--max-pages="));
const MAX_PAGES = maxPagesArg ? parseInt(maxPagesArg.split("=")[1], 10) : Infinity;

// ─── Config ──────────────────────────────────────────────────────────────
const PER_PAGE = 50;            // AniList max
const REQUEST_DELAY_MS = 2100;  // 30 req/min ≈ 2s. Add buffer for safety.

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
  console.error("✘ TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing");
  process.exit(1);
}
const db = createClient({ url, authToken });

// ─── Tier-1 query (mirrors lib/anilist/fullMediaQuery.js) ────────────────
const FIELDS = `
  id idMal type format status description(asHtml:false)
  season seasonYear episodes duration
  startDate { year month day } endDate { year month day }
  countryOfOrigin source hashtag isAdult
  averageScore meanScore popularity favourites trending
  genres synonyms
  title { romaji english native userPreferred }
  coverImage { extraLarge large medium color }
  bannerImage
  trailer { id site thumbnail }
  tags { id name rank category isMediaSpoiler }
  studios { edges { isMain node { id name } } }
  externalLinks { id url site type language color icon }
  streamingEpisodes { title thumbnail url site }
  nextAiringEpisode { airingAt episode timeUntilAiring }
  rankings { id rank type format year season allTime context }
  relations {
    edges {
      id
      relationType(version: 2)
      node {
        id format type status(version: 2) episodes
        title { romaji english native userPreferred }
        bannerImage
        coverImage { extraLarge large color }
      }
    }
  }
  characters {
    edges {
      role
      node {
        id
        image { large medium }
        name { full userPreferred }
      }
    }
  }
  recommendations {
    nodes {
      mediaRecommendation {
        id
        title { romaji userPreferred }
        coverImage { extraLarge large }
      }
    }
  }
  updatedAt
`;

// We bucket by seasonYear because AniList's Page() caps at 5000 results
// regardless of how many actually match. 22k+ anime means we'd lose >70% on
// a single sort. Each year usually has < 1500 entries, well under the cap.
// Anime without seasonYear (rare — some movies/OVAs) are picked up at runtime
// via read-through caching when a user visits them.
const QUERY_BY_YEAR = `query($page:Int,$perPage:Int,$year:Int){
  Page(page:$page, perPage:$perPage){
    pageInfo { hasNextPage currentPage lastPage perPage total }
    media(sort:ID_DESC, type:ANIME, seasonYear:$year){${FIELDS}}
  }
}`;

// Catch-all for anime that don't have a seasonYear set on AniList. We sweep
// these once per bootstrap, also capped at 5000 (which covers it in practice
// since most undated entries are obscure).
const QUERY_NO_YEAR = `query($page:Int,$perPage:Int){
  Page(page:$page, perPage:$perPage){
    pageInfo { hasNextPage currentPage lastPage perPage total }
    media(sort:ID_DESC, type:ANIME){${FIELDS}}
  }
}`;

// Year range. AniList's earliest anime is from ~1907 but the explosion is
// post-1960. We sweep [START_YEAR, END_YEAR] inclusive.
const START_YEAR = 1940;
const END_YEAR = new Date().getFullYear() + 1; // include next-year announcements

// ─── Helpers ─────────────────────────────────────────────────────────────
const HOUR = 3600;
const DAY = 86400;
function ttlForStatus(s) {
  switch (s) {
    case "RELEASING":         return HOUR;
    case "NOT_YET_RELEASED":  return DAY;
    case "FINISHED":          return 30 * DAY;
    case "CANCELLED":
    case "HIATUS":            return 7 * DAY;
    default:                  return 7 * DAY;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(page, year) {
  const body = year
    ? { query: QUERY_BY_YEAR, variables: { page, perPage: PER_PAGE, year } }
    : { query: QUERY_NO_YEAR, variables: { page, perPage: PER_PAGE } };

  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });

  // Rate limit handling — AniList signals back-off via headers and 429.
  const remaining = res.headers.get("x-ratelimit-remaining");
  const retryAfter = res.headers.get("retry-after");

  if (res.status === 429) {
    const wait = (retryAfter ? Number(retryAfter) : 30) * 1000;
    console.warn(`  ↳ 429 from AniList, sleeping ${wait}ms`);
    await sleep(wait);
    return fetchPage(page, year); // retry
  }

  if (!res.ok) {
    throw new Error(`AniList HTTP ${res.status} on page ${page} year ${year}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`AniList errors on page ${page} year ${year}: ${JSON.stringify(json.errors)}`);
  }

  // If almost out of budget, sleep a bit extra to let it refill.
  if (remaining !== null && Number(remaining) < 5) {
    console.warn(`  ↳ rate budget low (${remaining}), sleeping +5s`);
    await sleep(5000);
  }

  return json.data.Page;
}

async function upsertBatch(mediaList) {
  if (mediaList.length === 0) return;

  const now = Math.floor(Date.now() / 1000);
  const ops = [];

  for (const m of mediaList) {
    if (!m?.id) continue;
    const expiresAt = now + ttlForStatus(m.status);
    const dataJson = JSON.stringify(m);
    const synonymsStr = (m.synonyms || []).join(" ");

    ops.push({
      sql: `INSERT INTO anime
              (id, id_mal, status, format, type, season, season_year,
               popularity, average_score, is_adult, data,
               anilist_updated_at, last_fetched_at, expires_at, last_accessed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              id_mal             = COALESCE(excluded.id_mal,             anime.id_mal),
              status             = COALESCE(excluded.status,             anime.status),
              format             = COALESCE(excluded.format,             anime.format),
              type               = COALESCE(excluded.type,               anime.type),
              season             = COALESCE(excluded.season,             anime.season),
              season_year        = COALESCE(excluded.season_year,        anime.season_year),
              popularity         = COALESCE(excluded.popularity,         anime.popularity),
              average_score      = COALESCE(excluded.average_score,      anime.average_score),
              is_adult           = excluded.is_adult,
              data               = excluded.data,
              anilist_updated_at = COALESCE(excluded.anilist_updated_at, anime.anilist_updated_at),
              last_fetched_at    = excluded.last_fetched_at,
              expires_at         = excluded.expires_at,
              last_accessed_at   = COALESCE(anime.last_accessed_at,      excluded.last_accessed_at)`,
      args: [
        m.id,
        m.idMal ?? null,
        m.status ?? null,
        m.format ?? null,
        m.type ?? null,
        m.season ?? null,
        m.seasonYear ?? null,
        m.popularity ?? null,
        m.averageScore ?? null,
        m.isAdult ? 1 : 0,
        dataJson,
        m.updatedAt ?? null,
        now,
        expiresAt,
        now,
      ],
    });

    ops.push({
      sql: "DELETE FROM anime_fts WHERE rowid = ?",
      args: [m.id],
    });
    ops.push({
      sql: `INSERT INTO anime_fts (rowid, romaji, english, native, synonyms)
              VALUES (?, ?, ?, ?, ?)`,
      args: [
        m.id,
        m.title?.romaji ?? "",
        m.title?.english ?? "",
        m.title?.native ?? "",
        synonymsStr,
      ],
    });
  }

  await db.batch(ops);
}


/** Sweep one bucket (year=null means the catch-all no-year sweep). */
async function sweepBucket(label, year, opts = {}) {
  // AniList caps Page() pagination at 100 pages × 50 = 5000 results, regardless
  // of how many actually match. Going past page 100 returns HTTP 400. We hard-
  // cap here so the no-year sweep (which can have > 5000 results) ends cleanly.
  const ANILIST_PAGE_CAP = 100;
  const { onPage, abortAfter = ANILIST_PAGE_CAP } = opts;
  let page = 1;
  let upserted = 0;
  let lastPage = null;

  while (page <= abortAfter) {
    const t1 = Date.now();
    let pageData;
    try {
      pageData = await fetchPage(page, year);
    } catch (e) {
      // Page > 100 always returns HTTP 400 — treat as natural end of bucket.
      if (e.message.includes("HTTP 400") && page > ANILIST_PAGE_CAP - 1) {
        console.warn(`  ↳ ${label} hit AniList page cap at ${page} — stopping bucket`);
        break;
      }
      console.error(`  ✘ ${label} page ${page} failed: ${e.message} — retrying after 30s`);
      await sleep(30000);
      pageData = await fetchPage(page, year); // let it throw if it fails again
    }
    if (!pageData) break;

    const media = pageData.media || [];
    lastPage = pageData.pageInfo?.lastPage ?? lastPage;

    if (media.length > 0) {
      await upsertBatch(media);
      upserted += media.length;
    }

    if (onPage) await onPage({ label, year, page, lastPage, count: media.length, ms: Date.now() - t1 });

    if (!pageData.pageInfo?.hasNextPage) break;
    page++;
    await sleep(REQUEST_DELAY_MS);
  }

  return { upserted, pages: page };
}

// ─── Main ────────────────────────────────────────────────────────────────
async function main() {
  // Build the bucket list: each year + a final catch-all without seasonYear.
  // Bucket cursor "year:N" lets us resume year-by-year.
  const buckets = [];
  for (let y = END_YEAR; y >= START_YEAR; y--) buckets.push({ label: String(y), year: y });
  buckets.push({ label: "no-year", year: null });

  // Resume support — we save "last completed bucket index"
  const STATE_KEY = "bootstrap_bucket_idx";
  let startIdx = 0;

  if (RESTART) {
    console.log("→ --restart: clearing saved progress");
    await db.execute({ sql: "DELETE FROM scrape_state WHERE key = ?", args: [STATE_KEY] });
  } else {
    const r = await db.execute({
      sql: "SELECT value FROM scrape_state WHERE key = ?",
      args: [STATE_KEY],
    });
    if (r.rows[0]) {
      startIdx = Number(r.rows[0].value) + 1;
      const last = buckets[startIdx - 1];
      console.log(`→ Resuming from bucket ${startIdx}/${buckets.length} (last done: ${last?.label ?? "?"})`);
    }
  }

  const t0 = Date.now();
  let totalUpserted = 0;
  let bucketsProcessed = 0;

  for (let i = startIdx; i < buckets.length && bucketsProcessed < MAX_PAGES; i++) {
    const b = buckets[i];
    const t1 = Date.now();

    const { upserted, pages } = await sweepBucket(b.label, b.year, {
      onPage: ({ label, page, lastPage, count, ms }) => {
        console.log(`  ✓ ${label} page ${page}/${lastPage ?? "?"} — ${count} anime (${ms}ms)`);
      },
    });

    totalUpserted += upserted;
    bucketsProcessed++;

    const now = Math.floor(Date.now() / 1000);
    await db.execute({
      sql: `INSERT INTO scrape_state (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      args: [STATE_KEY, String(i), now],
    });

    const remaining = buckets.length - 1 - i;
    const elapsed = Date.now() - t0;
    const avgPerBucket = elapsed / bucketsProcessed;
    const eta = Math.round((remaining * avgPerBucket) / 1000);
    console.log(
      `  ✓ bucket "${b.label}" done — ${upserted} anime in ${pages - 1} page(s) ` +
      `(${Math.round((Date.now() - t1) / 1000)}s) — eta ${Math.floor(eta / 60)}m${eta % 60}s\n`
    );
  }

  const totalSec = Math.round((Date.now() - t0) / 1000);
  console.log(`✓ Bootstrap session complete.`);
  console.log(`  Buckets processed: ${bucketsProcessed}/${buckets.length}`);
  console.log(`  Anime upserted:    ${totalUpserted}`);
  console.log(`  Wall time:         ${Math.floor(totalSec / 60)}m${totalSec % 60}s`);

  const r = await db.execute("SELECT COUNT(*) AS n FROM anime");
  console.log(`  Total in DB:       ${r.rows[0].n}`);
}

main().catch((e) => {
  console.error("\n✘ Bootstrap crashed:", e);
  process.exit(1);
});
