#!/usr/bin/env node
/**
 * Re-fetch anime that have suspiciously empty fields in DB to verify whether
 * the gap is "AniList doesn't have it" or "we cached wrong".
 *
 * Strategy: select rows where popularity > THRESHOLD AND (trailer missing
 * OR characters empty OR recommendations empty). For those, re-fetch via
 * id_in batches of 50. Less granular than per-row matching but much faster
 * over 17k rows, and it WILL converge: each pass refreshes the holes that
 * AniList does fill. Subsequent passes get cheaper (fewer holes).
 *
 * Usage:
 *   node scripts/fill-gaps.mjs                 # default threshold = 1000
 *   node scripts/fill-gaps.mjs --threshold=0   # every row with any gap
 *   node scripts/fill-gaps.mjs --restart       # ignore resume cursor
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@libsql/client";

const args = new Set(process.argv.slice(2));
const RESTART = args.has("--restart");
const tArg = [...args].find((a) => a.startsWith("--threshold="));
const POPULARITY_THRESHOLD = tArg ? Number(tArg.split("=")[1]) : 1000;

const BATCH = 50;
const REQUEST_DELAY_MS = 2100;
const STATE_KEY = "fillgaps_last_idx";

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
const ttlForStatus = (s) => ({
  RELEASING: HOUR, NOT_YET_RELEASED: DAY, FINISHED: 30 * DAY,
  CANCELLED: 7 * DAY, HIATUS: 7 * DAY,
}[s] ?? 7 * DAY);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchBatch(ids, attempt = 1) {
  const MAX = 5;
  let res;
  try {
    res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { ids } }),
    });
  } catch (e) {
    if (attempt >= MAX) throw e;
    const wait = Math.min(60000, 5000 * attempt);
    console.warn(`  ↳ network error (${e.cause?.code || e.message}), retry ${attempt}/${MAX} in ${wait}ms`);
    await sleep(wait);
    return fetchBatch(ids, attempt + 1);
  }
  if (res.status === 429) {
    const wait = (Number(res.headers.get("retry-after")) || 30) * 1000;
    console.warn(`  ↳ 429, sleeping ${wait}ms`);
    await sleep(wait);
    return fetchBatch(ids, attempt);
  }
  if (res.status >= 500) {
    if (attempt >= MAX) throw new Error(`AniList HTTP ${res.status}`);
    const wait = Math.min(60000, 5000 * attempt);
    console.warn(`  ↳ HTTP ${res.status}, retry ${attempt}/${MAX} in ${wait}ms`);
    await sleep(wait);
    return fetchBatch(ids, attempt + 1);
  }
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`AniList errors: ${JSON.stringify(json.errors)}`);
  return json.data.Page.media || [];
}

async function upsertBatch(media) {
  if (!media.length) return;
  const now = Math.floor(Date.now() / 1000);
  const ops = [];
  for (const m of media) {
    if (!m?.id) continue;
    const expires = now + ttlForStatus(m.status);
    const json = JSON.stringify(m);
    const syn = (m.synonyms || []).join(" ");
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
      args: [m.id, m.idMal ?? null, m.status ?? null, m.format ?? null, m.type ?? null,
             m.season ?? null, m.seasonYear ?? null,
             m.popularity ?? null, m.averageScore ?? null,
             m.isAdult ? 1 : 0, json,
             m.updatedAt ?? null, now, expires, now],
    });
    ops.push({ sql: "DELETE FROM anime_fts WHERE rowid = ?", args: [m.id] });
    ops.push({
      sql: `INSERT INTO anime_fts (rowid, romaji, english, native, synonyms)
              VALUES (?, ?, ?, ?, ?)`,
      args: [m.id,
             m.title?.romaji ?? "",
             m.title?.english ?? "",
             m.title?.native ?? "",
             syn],
    });
  }
  await db.batch(ops);
}

async function main() {
  console.log(`Selecting anime with gaps (popularity ≥ ${POPULARITY_THRESHOLD})…`);

  // Pick rows where AT LEAST one rich field is empty AND the anime is popular
  // enough that AniList likely has data for it.
  const r = await db.execute(`
    SELECT id FROM anime
     WHERE COALESCE(popularity, 0) >= ?
       AND (
            json_extract(data,'$.trailer.id') IS NULL
         OR json_array_length(json_extract(data,'$.characters.edges'))     = 0
         OR json_array_length(json_extract(data,'$.recommendations.nodes')) = 0
         OR json_extract(data,'$.characters') IS NULL
         OR json_extract(data,'$.recommendations') IS NULL
       )
     ORDER BY popularity DESC
  `, [POPULARITY_THRESHOLD]);

  const ids = r.rows.map(row => Number(row.id));
  console.log(`→ ${ids.length} candidate anime to refresh`);
  if (ids.length === 0) return;

  let startIdx = 0;
  if (RESTART) {
    await db.execute({ sql: "DELETE FROM scrape_state WHERE key = ?", args: [STATE_KEY] });
    console.log("→ --restart: cleared progress");
  } else {
    const s = await db.execute({ sql: "SELECT value FROM scrape_state WHERE key = ?", args: [STATE_KEY] });
    if (s.rows[0]) {
      startIdx = Number(s.rows[0].value);
      console.log(`→ Resuming at ${startIdx}/${ids.length}`);
    }
  }

  const t0 = Date.now();
  let processed = 0;

  for (let i = startIdx; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const t1 = Date.now();
    const got = await fetchBatch(batch);
    await upsertBatch(got);
    processed += batch.length;

    const now = Math.floor(Date.now() / 1000);
    await db.execute({
      sql: `INSERT INTO scrape_state (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      args: [STATE_KEY, String(i + BATCH), now],
    });

    const remaining = ids.length - (i + BATCH);
    const elapsed = (Date.now() - t0) / 1000;
    const rate = processed / elapsed;
    const eta = rate > 0 ? Math.round(remaining / rate) : null;

    console.log(`  ✓ ${i + batch.length}/${ids.length} — got ${got.length}/${batch.length} (${Date.now() - t1}ms)` +
      (eta !== null ? ` — eta ${Math.floor(eta / 60)}m${eta % 60}s` : ""));

    if (i + BATCH < ids.length) await sleep(REQUEST_DELAY_MS);
  }

  await db.execute({ sql: "DELETE FROM scrape_state WHERE key = ?", args: [STATE_KEY] });

  const dt = Math.round((Date.now() - t0) / 1000);
  console.log(`\n✓ Fill-gaps complete in ${Math.floor(dt / 60)}m${dt % 60}s — ${processed} processed`);
}

main().catch(e => { console.error("✘ Crashed:", e); process.exit(1); });
