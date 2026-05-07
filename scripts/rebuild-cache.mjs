#!/usr/bin/env node
/**
 * Re-fetch every anime currently in the DB to migrate it to the latest
 * Tier-1 query shape. Use this after editing FULL_MEDIA_FIELDS.
 *
 * Strategy: read every existing id, batch them 50 at a time into
 * `media(id_in:[...])`, upsert. Much faster than re-running the full
 * bootstrap by year because:
 *   • no missed buckets
 *   • no AniList page cap to dance around
 *   • ~50× faster (one query per 50 anime instead of one per page of 50)
 *
 * Resumable via scrape_state['rebuild_last_idx'].
 *
 * Usage:
 *   node scripts/rebuild-cache.mjs           # resume
 *   node scripts/rebuild-cache.mjs --restart # start over
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@libsql/client";

const RESTART = process.argv.includes("--restart");
const BATCH = 50;
const REQUEST_DELAY_MS = 2100;
const STATE_KEY = "rebuild_last_idx";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
  console.error("✘ TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing");
  process.exit(1);
}
const db = createClient({ url, authToken });

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

const QUERY = `query($ids:[Int]){
  Page(page:1, perPage:50){
    media(id_in:$ids, type:ANIME){${FIELDS}}
  }
}`;

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

async function fetchBatch(ids, attempt = 1) {
  const MAX_ATTEMPTS = 5;
  let res;
  try {
    res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { ids } }),
    });
  } catch (e) {
    // Network errors (ETIMEDOUT, ECONNRESET, DNS hiccups) — back off and retry.
    // Long-running scripts always hit at least one of these eventually.
    if (attempt >= MAX_ATTEMPTS) throw e;
    const wait = Math.min(60_000, 5000 * attempt);
    console.warn(`  ↳ network error (${e.cause?.code || e.message}), retry ${attempt}/${MAX_ATTEMPTS} in ${wait}ms`);
    await sleep(wait);
    return fetchBatch(ids, attempt + 1);
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    const wait = (retryAfter ? Number(retryAfter) : 30) * 1000;
    console.warn(`  ↳ 429, sleeping ${wait}ms`);
    await sleep(wait);
    return fetchBatch(ids, attempt);
  }
  if (res.status >= 500) {
    if (attempt >= MAX_ATTEMPTS) throw new Error(`AniList HTTP ${res.status} after ${MAX_ATTEMPTS} attempts`);
    const wait = Math.min(60_000, 5000 * attempt);
    console.warn(`  ↳ HTTP ${res.status}, retry ${attempt}/${MAX_ATTEMPTS} in ${wait}ms`);
    await sleep(wait);
    return fetchBatch(ids, attempt + 1);
  }
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`AniList errors: ${JSON.stringify(json.errors)}`);
  return json.data.Page.media || [];
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

async function main() {
  // Get all known ids ordered by popularity desc — we want the popular ones
  // refreshed first so users feel it.
  const r = await db.execute(
    "SELECT id FROM anime ORDER BY popularity DESC NULLS LAST"
  );
  const allIds = r.rows.map((row) => Number(row.id));
  console.log(`→ ${allIds.length} anime in DB to rebuild`);

  let startIdx = 0;
  if (RESTART) {
    await db.execute({ sql: "DELETE FROM scrape_state WHERE key = ?", args: [STATE_KEY] });
    console.log("→ --restart: cleared progress");
  } else {
    const s = await db.execute({
      sql: "SELECT value FROM scrape_state WHERE key = ?",
      args: [STATE_KEY],
    });
    if (s.rows[0]) {
      startIdx = Number(s.rows[0].value);
      console.log(`→ Resuming at ${startIdx}/${allIds.length}`);
    }
  }

  const t0 = Date.now();
  let processed = 0;
  let upserted = 0;

  for (let i = startIdx; i < allIds.length; i += BATCH) {
    const batch = allIds.slice(i, i + BATCH);
    const t1 = Date.now();
    const got = await fetchBatch(batch);
    await upsertBatch(got);
    processed += batch.length;
    upserted += got.length;

    const now = Math.floor(Date.now() / 1000);
    await db.execute({
      sql: `INSERT INTO scrape_state (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      args: [STATE_KEY, String(i + BATCH), now],
    });

    const remaining = allIds.length - (i + BATCH);
    const elapsed = (Date.now() - t0) / 1000;
    const rate = processed / elapsed;
    const eta = rate > 0 ? Math.round(remaining / rate) : null;

    console.log(
      `  ✓ ${i + batch.length}/${allIds.length} — got ${got.length}/${batch.length} (${Date.now() - t1}ms)` +
        (eta !== null ? ` — eta ${Math.floor(eta / 60)}m${eta % 60}s` : "")
    );

    if (i + BATCH < allIds.length) await sleep(REQUEST_DELAY_MS);
  }

  // Done — clear the marker
  await db.execute({ sql: "DELETE FROM scrape_state WHERE key = ?", args: [STATE_KEY] });

  const totalSec = Math.round((Date.now() - t0) / 1000);
  console.log(`\n✓ Rebuild complete.`);
  console.log(`  Processed:  ${processed}`);
  console.log(`  Upserted:   ${upserted}`);
  console.log(`  Wall time:  ${Math.floor(totalSec / 60)}m${totalSec % 60}s`);
}

main().catch((e) => {
  console.error("\n✘ Rebuild crashed:", e);
  process.exit(1);
});
