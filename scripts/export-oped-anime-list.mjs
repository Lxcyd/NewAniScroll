/**
 * Export the anime.json contract that the offline OP/ED detector
 * (tools/opening-detector/batch_detect.py) consumes. ZERO worker calls, ZERO
 * Upstash — one read of the Turso tables the app ALREADY populated.
 *
 *   node --env-file=.env.local scripts/export-oped-anime-list.mjs \
 *        --out=tools/opening-detector/anime.json [--source=animesama] \
 *        [--limit=50] [--min-episodes=1]
 *
 * The detector does NOT derive the AniList/MAL id ↔ anime-sama slug ↔ season
 * mapping — that's the app's season resolver, whose VERIFIED output already
 * lives in `player_map`. So this just reshapes verified player_map rows (joined
 * with `anime` for the MAL id AnimeThemes needs) into:
 *
 *   [{ "mal_id": 16498, "anilist_id": 16498,
 *      "slug": "shingeki-no-kyojin",
 *      "seasons": [{ "season_dir": "saison1", "lang": "vostfr",
 *                    "ep_start": 1, "ep_end": 25 }] }]
 *
 * We emit anime-sama rows by default: the detector's multi-host resolver bridge
 * is anime-sama-centric (sibnet/vidmoly/megaplay come from that slug). A row is
 * exported only when it has the slug + a MAL id (AnimeThemes lookup key) + a
 * usable episode count.
 */
import fs from "node:fs";
import { createClient } from "@libsql/client";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const OUT = args.out || "tools/opening-detector/anime.json";
const SOURCE = args.source || "animesama";
const LIMIT = args.limit ? Number(args.limit) : 0;
const MIN_EP = args["min-episodes"] ? Number(args["min-episodes"]) : 1;

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Verified mappings only — we never feed the batch a guessed (heuristic) or
// broken slug/season (it would waste hours of ffmpeg on the wrong stream).
const r = await db.execute({
  sql: `SELECT pm.ani_id       AS ani_id,
               pm.lang         AS lang,
               pm.slug         AS slug,
               pm.season_dir   AS season_dir,
               pm.episode_count AS episode_count,
               a.id_mal        AS id_mal
          FROM player_map pm
          JOIN anime a ON a.id = pm.ani_id
         WHERE pm.source = ?
           AND pm.status = 'verified'
           AND pm.slug IS NOT NULL
           AND a.id_mal IS NOT NULL`,
  args: [SOURCE],
});

console.log(`[export-oped] ${r.rows.length} verified ${SOURCE} rows`);

// Group rows into one entry per anime, each carrying all its (season_dir, lang)
// panels. The detector wants a per-season episode range; player_map gives a
// per-panel episode_count, and anime-sama panels are 1-based per season, so
// ep_start = 1 and ep_end = count. (A merged-offset panel would need the offset
// applied, but verified anime-sama season panels are already per-season.)
const byAnime = new Map();
let skippedNoEp = 0;
for (const row of r.rows) {
  const aniId = Number(row.ani_id);
  const malId = Number(row.id_mal);
  const slug = String(row.slug);
  const seasonDir = row.season_dir ? String(row.season_dir) : "saison1";
  const lang = String(row.lang);
  const count = row.episode_count == null ? null : Number(row.episode_count);
  if (!count || count < MIN_EP) {
    skippedNoEp++;
    continue;
  }
  if (!byAnime.has(aniId)) {
    byAnime.set(aniId, {
      mal_id: malId,
      anilist_id: aniId,
      slug,
      seasons: [],
    });
  }
  byAnime.get(aniId).seasons.push({
    season_dir: seasonDir,
    lang,
    ep_start: 1,
    ep_end: count,
  });
}

let list = [...byAnime.values()].filter((a) => a.seasons.length > 0);
if (LIMIT > 0) list = list.slice(0, LIMIT);

const totalSeasons = list.reduce((n, a) => n + a.seasons.length, 0);
console.log(
  `[export-oped] ${list.length} anime, ${totalSeasons} season/lang panels ` +
    `(skipped ${skippedNoEp} rows with no usable episode count)`,
);

fs.mkdirSync(OUT.replace(/[/\\][^/\\]*$/, "") || ".", { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(list, null, 2), "utf8");
console.log(`[export-oped] wrote ${OUT}`);
