#!/usr/bin/env node
/**
 * Refresh the Fribb/anime-lists mapping into the `fribb_map` Turso table.
 *
 * Fribb (github.com/Fribb/anime-lists) publishes near-daily "automated list
 * update" commits, so we re-ingest periodically. Weekly is plenty — the file
 * moves daily but season NUMBERS rarely change. We store the upstream ETag /
 * Last-Modified in `scrape_state` and short-circuit when nothing changed, so a
 * frequent cron is cheap.
 *
 * Idempotent, no state shipped between runs — designed for GitHub Actions.
 *
 * Usage:
 *   node scripts/cache/refresh-fribb.mjs
 *   node scripts/cache/refresh-fribb.mjs --force     # ignore ETag, always re-ingest
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@libsql/client";

const FORCE = new Set(process.argv.slice(2)).has("--force");

const FRIBB_URL =
  "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json";
const STATE_KEY = "fribb:etag";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error("✘ TURSO_DATABASE_URL missing");
  process.exit(1);
}
const db = createClient({ url, authToken });

const CREATE_FRIBB_SQL = `
CREATE TABLE IF NOT EXISTS fribb_map (
  anilist_id     INTEGER PRIMARY KEY,
  mal_id         INTEGER,
  tmdb_tv_id     INTEGER,
  tmdb_movie_id  INTEGER,
  tvdb_id        INTEGER,
  simkl_id       INTEGER,
  tmdb_season    INTEGER,
  tvdb_season    INTEGER,
  type           TEXT,
  updated_at     INTEGER NOT NULL
)`;

function tvId(tmdb) {
  if (!tmdb || typeof tmdb === "number") return null;
  return typeof tmdb.tv === "number" ? tmdb.tv : null;
}
function movieId(tmdb) {
  if (!tmdb || typeof tmdb === "number") return null;
  const m = tmdb.movie;
  if (Array.isArray(m)) return m.length ? Number(m[0]) : null;
  return typeof m === "number" ? m : null;
}

async function getState() {
  try {
    const r = await db.execute({
      sql: "SELECT value FROM scrape_state WHERE key = ?",
      args: [STATE_KEY],
    });
    return r.rows.length ? r.rows[0].value : null;
  } catch {
    return null;
  }
}
async function setState(value) {
  const now = Math.floor(Date.now() / 1000);
  await db.execute({
    sql: `INSERT INTO scrape_state (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    args: [STATE_KEY, value, now],
  });
}

async function main() {
  await db.execute(CREATE_FRIBB_SQL);
  // simkl_id landed after the table shipped: CREATE TABLE IF NOT EXISTS won't
  // add it to an existing DB, and SQLite has no ALTER ... IF NOT EXISTS. The
  // "duplicate column" error IS the success case on later runs.
  try {
    await db.execute("ALTER TABLE fribb_map ADD COLUMN simkl_id INTEGER");
    console.log("• added simkl_id column");
  } catch (e) {
    if (!/duplicate column/i.test(String(e?.message))) throw e;
  }
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_fribb_tmdb_tv ON fribb_map(tmdb_tv_id)"
  );

  // Conditional request: skip the download entirely if unchanged.
  const prevEtag = FORCE ? null : await getState();
  const headers = {};
  if (prevEtag) headers["If-None-Match"] = prevEtag;

  const res = await fetch(FRIBB_URL, { headers });
  if (res.status === 304) {
    console.log("• Fribb unchanged (304) — nothing to do.");
    return;
  }
  if (!res.ok) {
    console.error(`✘ Fribb fetch failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const etag = res.headers.get("etag");
  const raw = await res.json();
  const now = Math.floor(Date.now() / 1000);

  const entries = raw
    .filter((r) => typeof r.anilist_id === "number")
    .map((r) => ({
      anilistId: r.anilist_id,
      malId: typeof r.mal_id === "number" ? r.mal_id : null,
      tmdbTvId: tvId(r.themoviedb_id),
      tmdbMovieId: movieId(r.themoviedb_id),
      tvdbId: typeof r.tvdb_id === "number" ? r.tvdb_id : null,
      // Per-ENTRY id (not franchise) — powers per-episode stills, see
      // Plus lu depuis le retrait de Simkl — voir lib/fribb/fribbMap.ts.
      simklId: typeof r.simkl_id === "number" ? r.simkl_id : null,
      tmdbSeason:
        r.season && typeof r.season.tmdb === "number" ? r.season.tmdb : null,
      tvdbSeason:
        r.season && typeof r.season.tvdb === "number" ? r.season.tvdb : null,
      type: r.type ?? null,
    }));

  /* SEULES LES LIGNES QUI CHANGENT SONT ECRITES (17/11/2026). Fribb publie
     presque chaque jour, donc l'ETag change a chaque passage et les ~40 000
     lignes etaient reecrites chaque semaine pour quelques dizaines de vraies
     modifications — sur un quota Turso de 10 M d'ecritures par mois partage
     par tout le projet. Une lecture de la table coute ~40 000 lignes LUES,
     sur un quota cinquante fois plus large. */
  const sig = (e) =>
    [e.malId, e.tmdbTvId, e.tmdbMovieId, e.tvdbId, e.simklId, e.tmdbSeason, e.tvdbSeason, e.type].join("|");
  const have = new Map();
  for (const r of (await db.execute(
    "SELECT anilist_id, mal_id, tmdb_tv_id, tmdb_movie_id, tvdb_id, simkl_id, tmdb_season, tvdb_season, type FROM fribb_map",
  )).rows) {
    have.set(
      Number(r.anilist_id),
      [r.mal_id, r.tmdb_tv_id, r.tmdb_movie_id, r.tvdb_id, r.simkl_id, r.tmdb_season, r.tvdb_season, r.type]
        .map((v) => (v == null ? "" : String(v)))
        .join("|"),
    );
  }
  const changed = entries.filter((e) => have.get(e.anilistId) !== sig(e));

  const BATCH = 500;
  let written = 0;
  for (let i = 0; i < changed.length; i += BATCH) {
    const slice = changed.slice(i, i + BATCH);
    await db.batch(
      slice.map((e) => ({
        sql: `INSERT INTO fribb_map
          (anilist_id, mal_id, tmdb_tv_id, tmdb_movie_id, tvdb_id, simkl_id,
           tmdb_season, tvdb_season, type, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(anilist_id) DO UPDATE SET
            mal_id=excluded.mal_id, tmdb_tv_id=excluded.tmdb_tv_id,
            tmdb_movie_id=excluded.tmdb_movie_id, tvdb_id=excluded.tvdb_id,
            simkl_id=excluded.simkl_id,
            tmdb_season=excluded.tmdb_season, tvdb_season=excluded.tvdb_season,
            type=excluded.type, updated_at=excluded.updated_at`,
        args: [
          e.anilistId, e.malId, e.tmdbTvId, e.tmdbMovieId, e.tvdbId, e.simklId,
          e.tmdbSeason, e.tvdbSeason, e.type, now,
        ],
      })),
      "write"
    );
    written += slice.length;
  }

  /* LES IDENTIFIANTS TVDB / TMDB DE LA TABLE `anime` (17/11/2026). Le script
     qui les posait a disparu en mai 2026 : depuis, aucun anime entre au
     catalogue n'en avait — et refresh-fanarts ne lit que ces colonnes. Ni
     Shingeki no Kyojin (mapping perdu), ni Mushoku Tensei III, ni Cyberpunk:
     Edgerunners 2 n'allaient chercher leurs images fanart.tv. On COMBLE les
     trous depuis fribb_map ; on n'ecrase jamais un identifiant deja pose (23
     desaccords au 17/11, sans moyen de savoir qui a raison). */
  const filled = await db.execute(`
    UPDATE anime SET
      tvdb_id = (SELECT f.tvdb_id FROM fribb_map f WHERE f.anilist_id = anime.id),
      tmdb_id = (SELECT CASE WHEN f.type = 'MOVIE' THEN COALESCE(f.tmdb_movie_id, f.tmdb_tv_id)
                             ELSE COALESCE(f.tmdb_tv_id, f.tmdb_movie_id) END
                   FROM fribb_map f WHERE f.anilist_id = anime.id)
    WHERE tvdb_id IS NULL AND tmdb_id IS NULL
      AND EXISTS (SELECT 1 FROM fribb_map f WHERE f.anilist_id = anime.id
                  AND (f.tvdb_id IS NOT NULL OR f.tmdb_tv_id IS NOT NULL OR f.tmdb_movie_id IS NOT NULL))`);

  if (etag) await setState(etag);
  console.log(
    `✓ Fribb ingested: ${written} changed rows of ${entries.length} (skipped ${raw.length - entries.length} without anilist_id); ` +
      `${filled.rowsAffected} anime gained a TVDB/TMDB id`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("✘ refresh-fribb failed:", e);
    process.exit(1);
  });
