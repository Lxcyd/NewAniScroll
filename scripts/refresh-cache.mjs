#!/usr/bin/env node
/**
 * Daily refresh of the Turso anime cache.
 *
 * Runs three jobs in order, each non-fatal — a partial run is better than no
 * run — but a run in which anything failed EXITS NON-ZERO. See main().
 *
 *   1. Airing-window refresh
 *      Re-fetch every RELEASING and NOT_YET_RELEASED anime in the DB. Episode
 *      counts, scores and airing dates shift fast for these, and the flip from
 *      one status to the other is the single most time-sensitive fact we hold.
 *
 *   2. TTL refresh
 *      Re-fetch rows whose `expires_at` has passed, most-recently-viewed
 *      first, up to a per-run budget. This is the job that actually keeps the
 *      catalogue current.
 *
 *   3. New-ID discovery
 *      Sweep Page(sort:ID_DESC) for AniList IDs higher than what we have in
 *      DB. Catches brand-new entries the bootstrap missed.
 *
 * WHY JOB 2 IS A TTL SWEEP AND NOT AN `updatedAt` DELTA, since that is what it
 * was for a year and the old design is the more obvious one.
 *
 * It walked Page(sort:UPDATED_AT_DESC) and stopped at the first entry not newer
 * than MAX(anilist_updated_at) in our table. Two things were wrong with it, one
 * fatal by itself:
 *
 *  - THE BASELINE WAS NOT A CURSOR. `MAX(anilist_updated_at)` is written by Job
 *    1 (which runs first, on the very anime AniList edits most often) and by
 *    every visitor's page view through `upsertAnime`. It therefore always read
 *    "a few minutes ago" instead of "where the last sweep stopped". Measured on
 *    every scheduled run from 2026-08-08 to 2026-08-16, without exception:
 *    `page 1: 0/50 newer than baseline`, `0 edited anime refreshed`. The job had
 *    never picked up a single edit. Under a multi-day AniList outage it was also
 *    the loss the whole design was supposed to prevent: on recovery Job 1 pushes
 *    the baseline to now and the outage window is skipped for good.
 *
 *  - AND A REAL CURSOR WOULD NOT HAVE SAVED IT. AniList bumps `updatedAt` in
 *    bulk: probed 2026-08-16, pages 4 through 20 of UPDATED_AT_DESC all carried
 *    the SAME second (15:07:57) — hundreds of media touched by one batch job of
 *    theirs — and 55 of 345 ids came back twice across eight pages, which is
 *    what unstable pagination over tied sort keys does. (What it does to the
 *    entries it silently skips instead is the same thing, unobserved.) So the
 *    stream is mostly noise, a day of it does not fit in the 100-page ceiling
 *    the API enforces, and no amount of it can be trusted to be complete.
 *
 * `expires_at` has neither problem. It is not a cursor — the queue IS the state
 * of the table — so a run that never happened costs a day of freshness and
 * nothing else, and there is no window that can be skipped past. That is the
 * outage answer this script was missing.
 *
 * Usage:
 *   node scripts/refresh-cache.mjs
 *   node scripts/refresh-cache.mjs --skip-airing
 *   node scripts/refresh-cache.mjs --skip-ttl
 *   node scripts/refresh-cache.mjs --skip-discovery
 *   node scripts/refresh-cache.mjs --max-ttl-rows=2000
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@libsql/client";

// ─── CLI ─────────────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2));
// `--skip-releasing` is still accepted: it is what the workflow passed before
// the job grew to cover NOT_YET_RELEASED too, and a flag rename should not
// silently start running a job somebody asked to skip.
const SKIP_AIRING = args.has("--skip-airing") || args.has("--skip-releasing");
const SKIP_TTL = args.has("--skip-ttl") || args.has("--skip-delta");
const SKIP_DISCOVERY = args.has("--skip-discovery");
/**
 * How many expired rows one run may re-fetch.
 *
 * 50 ids per request and 2.1 s between them, so 6000 rows is 120 requests and
 * about 4.5 minutes — comfortable inside the workflow's 30-minute ceiling, and
 * enough to clear the backlog that a year without a working TTL sweep left
 * (8965 expired rows on 2026-08-16) in under two runs, then keep up with ease.
 */
const maxTtlArg = [...args].find((a) => a.startsWith("--max-ttl-rows="));
const MAX_TTL_ROWS = maxTtlArg ? parseInt(maxTtlArg.split("=")[1], 10) : 6000;
/**
 * And a wall clock over the row budget, because the row budget is a guess.
 *
 * A batch of 50 costs ~4 s on a runner and ~15 s from a French desktop, so
 * 6000 rows is 12 minutes there and 35 here — past the workflow's own ceiling,
 * where the process is killed mid-batch and the run goes red for no fault.
 *
 * Stopping early is free in this job and in no other: there is no cursor to
 * leave inconsistent, and the rows not reached are still expired, so they are
 * simply the head of the next run's queue. So the budget that matters is time.
 */
const maxMinutesArg = [...args].find((a) => a.startsWith("--max-minutes="));
const MAX_TTL_MINUTES = maxMinutesArg ? parseFloat(maxMinutesArg.split("=")[1]) : 20;

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

/**
 * One request, with the two failures that are worth surviving.
 *
 * 429 was already handled and is not a failure at all — it is AniList pacing us.
 * A 5xx or a dropped connection is: those are the shape an AniList wobble
 * actually takes, and one of them used to abort the whole job, throwing away
 * however many batches were still queued behind it. Three tries at 5 s and 15 s
 * turns a blip into a pause. A run that is still failing after that is a real
 * outage, and it is now reported as one (see main).
 */
async function aniRequest(query, variables, attempt = 1) {
  const MAX_ATTEMPTS = 3;
  const retry = async (why) => {
    if (attempt >= MAX_ATTEMPTS) throw new Error(`${why} (after ${attempt} attempts)`);
    const wait = attempt * 5000;
    console.warn(`  ↳ ${why} — retrying in ${wait / 1000}s (${attempt}/${MAX_ATTEMPTS - 1})`);
    await sleep(wait);
    return aniRequest(query, variables, attempt + 1);
  };

  let res;
  try {
    res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  } catch (e) {
    return retry(`AniList unreachable: ${e.message}`);
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    const wait = (retryAfter ? Number(retryAfter) : 30) * 1000;
    console.warn(`  ↳ 429, sleeping ${wait}ms`);
    await sleep(wait);
    // Not counted as an attempt: being throttled is not a failure.
    return aniRequest(query, variables, attempt);
  }
  if (res.status >= 500) return retry(`AniList HTTP ${res.status}`);
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

// ─── Job 1: refresh the airing window ────────────────────────────────────
/**
 * RELEASING **and** NOT_YET_RELEASED, and the second half is a repair.
 *
 * Only RELEASING was refreshed here, on the reading that it is the status whose
 * numbers move. But a NOT_YET_RELEASED anime that starts airing only becomes
 * RELEASING if somebody re-fetches it, and this job's own query is what decides
 * who gets re-fetched — so an anime that had not aired yet on the day it was
 * ingested could never enter the list. Nothing else reached it either: the
 * delta sweep picked up nothing (see the header) and its 24-hour TTL fed a job
 * that did not exist.
 *
 * Measured on 2026-08-16, before this changed: 718 of 737 NOT_YET_RELEASED rows
 * past their TTL, and 24 anime still listed as upcoming whose start date was up
 * to three months in the past — "Kimi to Hanabi to Yakusoku to" (206819, due
 * 2026-07-17) among them.
 *
 * The cost of the fix is 15 extra requests, about 30 seconds.
 */
async function refreshAiring() {
  console.log("\n┌─ Job 1: airing-window refresh (RELEASING + NOT_YET_RELEASED) ─");

  const r = await db.execute(
    `SELECT id FROM anime
      WHERE status IN ('RELEASING', 'NOT_YET_RELEASED')
      ORDER BY popularity DESC NULLS LAST`
  );
  const ids = r.rows.map((row) => Number(row.id));
  console.log(`│  ${ids.length} anime in the airing window`);

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

// ─── Job 2: TTL refresh ──────────────────────────────────────────────────
/**
 * Re-fetch what has expired, most-recently-viewed first.
 *
 * NO CURSOR, and that is the whole point of it — see the header. The work queue
 * is `expires_at < now`, which is a fact about the table rather than a memory of
 * previous runs, so a run that failed, was skipped, or died halfway leaves the
 * rows it did not reach exactly where they were: still expired, still queued,
 * picked up by the next run. Days of AniList downtime cost freshness and cannot
 * cost data.
 *
 * `last_accessed_at DESC` is what makes a partial run the right partial run:
 * whatever the budget covers is the part of the catalogue people are actually
 * looking at.
 */
async function ttlRefresh() {
  console.log("\n┌─ Job 2: TTL refresh ─");

  const now = Math.floor(Date.now() / 1000);
  const backlog = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM anime WHERE expires_at < ?",
    args: [now],
  });
  const total = Number(backlog.rows[0]?.n ?? 0);
  console.log(`│  ${total} expired rows, budget ${MAX_TTL_ROWS} this run`);

  if (total === 0) {
    console.log("└─ nothing to do");
    return { refreshed: 0, remaining: 0 };
  }

  const r = await db.execute({
    sql: `SELECT id FROM anime
           WHERE expires_at < ?
           ORDER BY last_accessed_at DESC
           LIMIT ?`,
    args: [now, MAX_TTL_ROWS],
  });
  const ids = r.rows.map((row) => Number(row.id));

  let refreshed = 0;
  let missing = 0;
  let ranOut = false;
  const deadline = Date.now() + MAX_TTL_MINUTES * 60_000;
  for (let i = 0; i < ids.length; i += PER_PAGE) {
    if (Date.now() > deadline) {
      ranOut = true;
      console.log(`│  ↳ ${MAX_TTL_MINUTES} min budget spent — stopping here`);
      break;
    }
    const batch = ids.slice(i, i + PER_PAGE);
    const data = await aniRequest(QUERY_BY_IDS, { ids: batch });
    const got = data?.Page?.media || [];
    await upsertBatch(got);
    refreshed += got.length;

    /*
     * Ids AniList did not return — deleted or merged entries.
     *
     * Their row is untouched by the upsert, so `expires_at` stays in the past
     * and they come back at the head of this very queue on every future run,
     * for ever, spending the budget on the only rows in the table that can
     * never be refreshed. Pushing their deadline out parks them without
     * throwing away the copy we hold, which is the last one anybody has.
     */
    const returned = new Set(got.map((m) => Number(m.id)));
    const gone = batch.filter((id) => !returned.has(id));
    if (gone.length > 0) {
      missing += gone.length;
      await db.execute({
        sql: `UPDATE anime SET expires_at = ?
               WHERE id IN (${gone.map(() => "?").join(",")})`,
        args: [now + 7 * DAY, ...gone],
      });
    }

    if ((i / PER_PAGE) % 10 === 0 || i + PER_PAGE >= ids.length) {
      console.log(`│  ↳ ${Math.min(i + PER_PAGE, ids.length)}/${ids.length} — ${refreshed} refreshed`);
    }
    if (i + PER_PAGE < ids.length) await sleep(REQUEST_DELAY_MS);
  }

  const remaining = Math.max(0, total - refreshed - missing);
  if (missing > 0) console.log(`│  ${missing} id(s) unknown to AniList — parked for 7 days`);
  console.log(
    `└─ ${refreshed} refreshed, ${remaining} still expired (next run takes them)` +
    (ranOut ? " — budget-limited" : "")
  );
  return { refreshed, remaining };
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
  let r1 = { refreshed: 0 }, r2 = { refreshed: 0, remaining: 0 }, r3 = { added: 0 };

  /*
   * A FAILED JOB FAILS THE RUN, and its absence is how a multi-day outage could
   * have gone unnoticed.
   *
   * Each job stays wrapped — one of them falling over should not deprive us of
   * the other two — but the process used to exit 0 regardless, so AniList being
   * down for three days would have shown three green ticks in the Actions tab
   * and nothing else. The whole point of catching data loss early is being told.
   */
  const failures = [];
  const run = async (label, fn) => {
    try { return await fn(); }
    catch (e) {
      failures.push(`${label}: ${e.message}`);
      console.error(`::error::${label} failed: ${e.message}`);
      return null;
    }
  };

  if (!SKIP_AIRING) r1 = (await run("Job 1 (airing window)", refreshAiring)) ?? r1;
  if (!SKIP_TTL) r2 = (await run("Job 2 (TTL refresh)", ttlRefresh)) ?? r2;
  if (!SKIP_DISCOVERY) r3 = (await run("Job 3 (discovery)", discoverNew)) ?? r3;

  const dt = Math.round((Date.now() - t0) / 1000);
  console.log(`\n✓ Refresh complete in ${Math.floor(dt / 60)}m${dt % 60}s`);
  console.log(`  Airing window refreshed: ${r1.refreshed}`);
  console.log(`  Expired rows refreshed:  ${r2.refreshed} (${r2.remaining} left for next run)`);
  console.log(`  New IDs discovered:      ${r3.added}`);

  const total = await db.execute("SELECT COUNT(*) AS n FROM anime");
  console.log(`  Total in DB:             ${total.rows[0].n}`);

  if (failures.length > 0) {
    console.error(`\n✘ ${failures.length} job(s) failed:\n  - ${failures.join("\n  - ")}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("\n✘ Refresh crashed:", e);
  process.exit(1);
});
