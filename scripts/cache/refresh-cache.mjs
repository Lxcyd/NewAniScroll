#!/usr/bin/env node
/**
 * Daily refresh of the Turso anime cache.
 *
 * Runs three jobs in order, each non-fatal — a partial run is better than no run.
 *
 *   1. RELEASING refresh
 *      Re-fetch every RELEASING anime in the DB. Episode counts, scores, and
 *      airing schedule shift fast for these (TTL=1h), so we want the freshest
 *      data possible.
 *
 *   2. UPDATED_AT delta sweep
 *      Walk Page(sort:UPDATED_AT_DESC) until we hit anime whose
 *      anilist_updated_at <= our highest-known anilist_updated_at. Anything
 *      above is a recent edit on AniList — we re-fetch each one. This catches
 *      description rewrites, cover changes, status flips, new relations, etc.
 *
 *   3. New-ID discovery
 *      Sweep Page(sort:ID_DESC) for AniList IDs higher than what we have in
 *      DB. Catches brand-new entries the bootstrap missed.
 *
 * Designed for GitHub Actions: short, idempotent, no state to ship between
 * runs. Errors in one job don't block the others.
 *
 * Usage:
 *   node scripts/cache/refresh-cache.mjs
 *   node scripts/cache/refresh-cache.mjs --skip-releasing
 *   node scripts/cache/refresh-cache.mjs --skip-delta
 *   node scripts/cache/refresh-cache.mjs --skip-discovery
 *   node scripts/cache/refresh-cache.mjs --max-delta-pages=20
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@libsql/client";

// ─── CLI ─────────────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2));
const SKIP_RELEASING = args.has("--skip-releasing");
const SKIP_DELTA = args.has("--skip-delta");
const SKIP_DISCOVERY = args.has("--skip-discovery");
const maxDeltaArg = [...args].find((a) => a.startsWith("--max-delta-pages="));
const MAX_DELTA_PAGES = maxDeltaArg ? parseInt(maxDeltaArg.split("=")[1], 10) : 50;

// ─── Config ──────────────────────────────────────────────────────────────
const PER_PAGE = 50;
const REQUEST_DELAY_MS = 2100;

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
  console.error("✘ TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing");
  process.exit(1);
}
const db = createClient({ url, authToken });

// ─── Tier-1 fields (kept in sync with bootstrap-cache.mjs) ───────────────
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

const QUERY_BY_IDS = `query($ids:[Int]){
  Page(page:1, perPage:50){
    media(id_in:$ids, type:ANIME){${FIELDS}}
  }
}`;

const QUERY_RECENT = `query($page:Int){
  Page(page:$page, perPage:50){
    pageInfo { hasNextPage currentPage }
    media(sort:UPDATED_AT_DESC, type:ANIME){${FIELDS}}
  }
}`;

const QUERY_NEW = `query($page:Int){
  Page(page:$page, perPage:50){
    pageInfo { hasNextPage currentPage }
    media(sort:ID_DESC, type:ANIME){${FIELDS}}
  }
}`;

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

async function aniRequest(query, variables) {
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    const wait = (retryAfter ? Number(retryAfter) : 30) * 1000;
    console.warn(`  ↳ 429, sleeping ${wait}ms`);
    await sleep(wait);
    return aniRequest(query, variables);
  }
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`AniList errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function upsertBatch(mediaList) {
  if (!mediaList.length) return;
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
        m.id, m.idMal ?? null, m.status ?? null, m.format ?? null, m.type ?? null,
        m.season ?? null, m.seasonYear ?? null,
        m.popularity ?? null, m.averageScore ?? null,
        m.isAdult ? 1 : 0,
        dataJson,
        m.updatedAt ?? null, now, expiresAt, now,
      ],
    });
    ops.push({ sql: "DELETE FROM anime_fts WHERE rowid = ?", args: [m.id] });
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

// ─── Job 1: refresh RELEASING ────────────────────────────────────────────
async function refreshReleasing() {
  console.log("\n┌─ Job 1: RELEASING refresh ─");

  const r = await db.execute("SELECT id FROM anime WHERE status = 'RELEASING' ORDER BY popularity DESC NULLS LAST");
  const ids = r.rows.map((row) => Number(row.id));
  console.log(`│  ${ids.length} RELEASING anime to refresh`);

  if (ids.length === 0) {
    console.log("└─ nothing to do");
    return { refreshed: 0 };
  }

  let refreshed = 0;
  // batches of 50 — id_in caps at the same Page.perPage limit
  for (let i = 0; i < ids.length; i += PER_PAGE) {
    const batch = ids.slice(i, i + PER_PAGE);
    const data = await aniRequest(QUERY_BY_IDS, { ids: batch });
    const got = data?.Page?.media || [];
    await upsertBatch(got);
    refreshed += got.length;
    console.log(`│  ↳ batch ${Math.floor(i / PER_PAGE) + 1}: ${got.length}/${batch.length}`);
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`└─ ${refreshed} refreshed`);
  return { refreshed };
}

// ─── Job 2: UPDATED_AT delta sweep ───────────────────────────────────────
async function deltaSweep() {
  console.log("\n┌─ Job 2: UPDATED_AT delta sweep ─");

  // Highest anilist_updated_at we currently know about. Anything above this on
  // AniList is something we should pull.
  const r = await db.execute(
    "SELECT MAX(anilist_updated_at) AS max_at FROM anime WHERE anilist_updated_at IS NOT NULL"
  );
  const knownMax = Number(r.rows[0]?.max_at ?? 0);
  console.log(`│  Highest known anilist_updated_at: ${knownMax} (${knownMax ? new Date(knownMax * 1000).toISOString() : "never"})`);

  if (!knownMax) {
    console.log("└─ no baseline, skipping (run bootstrap first)");
    return { refreshed: 0 };
  }

  let refreshed = 0;
  // AniList caps Page() at 100 pages — going past returns HTTP 400.
  const cap = Math.min(MAX_DELTA_PAGES, 100);
  for (let page = 1; page <= cap; page++) {
    let data;
    try {
      data = await aniRequest(QUERY_RECENT, { page });
    } catch (e) {
      if (e.message.includes("HTTP 400")) {
        console.warn(`│  ↳ hit AniList page cap at ${page} — stopping`);
        break;
      }
      throw e;
    }
    const media = data?.Page?.media || [];
    if (media.length === 0) break;

    // Anything with updatedAt > knownMax is "new edit", everything from this
    // point on in the sorted page is older than what we have → we can stop.
    const newer = media.filter((m) => Number(m.updatedAt ?? 0) > knownMax);
    if (newer.length > 0) {
      await upsertBatch(newer);
      refreshed += newer.length;
    }

    console.log(`│  ↳ page ${page}: ${newer.length}/${media.length} newer than baseline`);

    // First page where every entry is older than baseline → done.
    if (newer.length < media.length) break;
    if (!data.Page.pageInfo?.hasNextPage) break;

    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`└─ ${refreshed} edited anime refreshed`);
  return { refreshed };
}

// ─── Job 3: new-ID discovery ─────────────────────────────────────────────
async function discoverNew() {
  console.log("\n┌─ Job 3: new-ID discovery ─");

  const r = await db.execute("SELECT MAX(id) AS max_id FROM anime");
  const knownMaxId = Number(r.rows[0]?.max_id ?? 0);
  console.log(`│  Highest known AniList id: ${knownMaxId}`);

  if (!knownMaxId) {
    console.log("└─ no baseline, skipping");
    return { added: 0 };
  }

  let added = 0;
  for (let page = 1; page <= 5; page++) {
    const data = await aniRequest(QUERY_NEW, { page });
    const media = data?.Page?.media || [];
    if (media.length === 0) break;

    const fresh = media.filter((m) => Number(m.id) > knownMaxId);
    if (fresh.length > 0) {
      await upsertBatch(fresh);
      added += fresh.length;
    }
    console.log(`│  ↳ page ${page}: ${fresh.length} new ids`);

    if (fresh.length < media.length) break;
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`└─ ${added} new anime discovered`);
  return { added };
}

// ─── Main ────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  let r1 = { refreshed: 0 }, r2 = { refreshed: 0 }, r3 = { added: 0 };

  if (!SKIP_RELEASING) {
    try { r1 = await refreshReleasing(); }
    catch (e) { console.error("✘ Job 1 failed:", e.message); }
  }
  if (!SKIP_DELTA) {
    try { r2 = await deltaSweep(); }
    catch (e) { console.error("✘ Job 2 failed:", e.message); }
  }
  if (!SKIP_DISCOVERY) {
    try { r3 = await discoverNew(); }
    catch (e) { console.error("✘ Job 3 failed:", e.message); }
  }

  const dt = Math.round((Date.now() - t0) / 1000);
  console.log(`\n✓ Refresh complete in ${Math.floor(dt / 60)}m${dt % 60}s`);
  console.log(`  RELEASING refreshed: ${r1.refreshed}`);
  console.log(`  Edits picked up:     ${r2.refreshed}`);
  console.log(`  New IDs discovered:  ${r3.added}`);

  const total = await db.execute("SELECT COUNT(*) AS n FROM anime");
  console.log(`  Total in DB:         ${total.rows[0].n}`);
}

main().catch((e) => {
  console.error("\n✘ Refresh crashed:", e);
  process.exit(1);
});
