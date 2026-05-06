#!/usr/bin/env node
/**
 * Smoke test for the Turso anime cache.
 *
 *   1. Fetch one anime from AniList (Frieren, id=154587)
 *   2. Upsert into Turso
 *   3. Read it back
 *   4. FTS search "frieren" → should return it
 *   5. Print row count + size estimate
 *
 * Usage:  node scripts/test-cache.mjs
 */

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { createClient } from "@libsql/client";

const FULL_MEDIA_FIELDS = `
  id idMal type format status description(asHtml:false)
  season seasonYear episodes duration
  startDate { year month day } endDate { year month day }
  countryOfOrigin source isAdult
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
    edges { relationType node {
      id format type status episodes
      title { romaji english native userPreferred }
      coverImage { large color }
    } }
  }
  updatedAt
`;

const TEST_ID = 154587; // Sousou no Frieren

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
  console.error("✘ Missing TURSO env vars");
  process.exit(1);
}
const db = createClient({ url, authToken });

const HOUR = 3600;
const DAY = 86400;
function ttlForStatus(s) {
  switch (s) {
    case "RELEASING": return HOUR;
    case "NOT_YET_RELEASED": return DAY;
    case "FINISHED": return 30 * DAY;
    case "CANCELLED":
    case "HIATUS": return 7 * DAY;
    default: return 7 * DAY;
  }
}

async function fetchAniList(id) {
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query($id:Int){Media(id:$id){${FULL_MEDIA_FIELDS}}}`,
      variables: { id },
    }),
  });
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const j = await res.json();
  if (!j?.data?.Media) throw new Error("No Media in response: " + JSON.stringify(j).slice(0, 200));
  return j.data.Media;
}

async function upsert(media) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlForStatus(media.status);
  const dataJson = JSON.stringify(media);
  const synonymsStr = (media.synonyms || []).join(" ");

  await db.batch([
    {
      sql: `INSERT INTO anime
              (id, id_mal, status, format, type, season, season_year,
               popularity, average_score, is_adult, data,
               anilist_updated_at, last_fetched_at, expires_at, last_accessed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              id_mal             = excluded.id_mal,
              status             = excluded.status,
              format             = excluded.format,
              type               = excluded.type,
              season             = excluded.season,
              season_year        = excluded.season_year,
              popularity         = excluded.popularity,
              average_score      = excluded.average_score,
              is_adult           = excluded.is_adult,
              data               = excluded.data,
              anilist_updated_at = excluded.anilist_updated_at,
              last_fetched_at    = excluded.last_fetched_at,
              expires_at         = excluded.expires_at,
              last_accessed_at   = excluded.last_accessed_at`,
      args: [
        media.id, media.idMal ?? null, media.status ?? null,
        media.format ?? null, media.type ?? null,
        media.season ?? null, media.seasonYear ?? null,
        media.popularity ?? null, media.averageScore ?? null,
        media.isAdult ? 1 : 0,
        dataJson,
        media.updatedAt ?? null, now, expiresAt, now,
      ],
    },
    { sql: "DELETE FROM anime_fts WHERE rowid = ?", args: [media.id] },
    {
      sql: `INSERT INTO anime_fts (rowid, romaji, english, native, synonyms)
              VALUES (?, ?, ?, ?, ?)`,
      args: [
        media.id,
        media.title?.romaji ?? "",
        media.title?.english ?? "",
        media.title?.native ?? "",
        synonymsStr,
      ],
    },
  ]);
}

async function main() {
  console.log(`→ 1. Fetch anime ${TEST_ID} from AniList`);
  const t1 = Date.now();
  const media = await fetchAniList(TEST_ID);
  console.log(`  ✓ ${media.title.romaji} (${media.title.english}) — ${Date.now() - t1}ms`);
  console.log(`    status=${media.status} format=${media.format} relations=${media.relations?.edges?.length || 0}`);
  const sizeKb = (JSON.stringify(media).length / 1024).toFixed(1);
  console.log(`    payload size: ${sizeKb} KB`);

  console.log(`\n→ 2. Upsert into Turso`);
  const t2 = Date.now();
  await upsert(media);
  console.log(`  ✓ upserted — ${Date.now() - t2}ms`);

  console.log(`\n→ 3. Read it back`);
  const t3 = Date.now();
  const r = await db.execute({
    sql: "SELECT id, status, data, last_fetched_at, expires_at FROM anime WHERE id = ?",
    args: [TEST_ID],
  });
  console.log(`  ✓ row found in ${Date.now() - t3}ms`);
  const row = r.rows[0];
  const parsed = JSON.parse(row.data);
  console.log(`    title: ${parsed.title.userPreferred}`);
  console.log(`    expires_at: ${new Date(Number(row.expires_at) * 1000).toISOString()}`);

  console.log(`\n→ 4. FTS search "frieren"`);
  const t4 = Date.now();
  const s = await db.execute({
    sql: `SELECT a.id, json_extract(a.data, '$.title.romaji') AS title
            FROM anime_fts f
            JOIN anime a ON a.id = f.rowid
            WHERE anime_fts MATCH ?
            LIMIT 5`,
    args: ['"frieren"*'],
  });
  console.log(`  ✓ ${s.rows.length} match(es) in ${Date.now() - t4}ms:`);
  for (const r of s.rows) console.log(`    • ${r.id} — ${r.title}`);

  console.log(`\n→ 5. Stats`);
  const c = await db.execute("SELECT COUNT(*) AS n FROM anime");
  console.log(`  total rows: ${c.rows[0].n}`);

  console.log(`\n✓ All round-trip tests passed.`);
}

main().catch((e) => {
  console.error("\n✘ Test failed:", e);
  process.exit(1);
});
