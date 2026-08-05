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
 *      "va_slug": "shingeki-no-kyojin",
 *      "seasons": [{ "season_dir": "saison1", "lang": "vostfr",
 *                    "ep_start": 1, "ep_end": 25 }] }]
 *
 * `va_slug` is voir-anime's slug for the same title (the `vidmoly-va` host);
 * it differs from anime-sama's for most anime — see the JOIN comment below.
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
// The voir-anime slug is joined in as `va_slug`: the detector's `vidmoly-va`
// host resolves against voir-anime, which uses a DIFFERENT slug from
// anime-sama's for most titles (anime-sama "anohana" vs voir-anime
// "ano-hi-mita-hana-no-namae-wo-bokutachi-wa-mada-shiranai"). Without it,
// batch_detect falls back to the anime-sama slug and vidmoly-va 404s — measured
// over player_map: of the 411 anime that HAVE a voir-anime row, 265 (64%) use a
// different slug, so the batch was silently losing that host on two thirds of
// them while the app played it fine.
//
// `heuristic` rows are accepted here, unlike the anime-sama row above. The
// asymmetry is deliberate: a wrong anime-sama slug/season sends ffmpeg at hours
// of the WRONG stream, whereas a wrong voir-anime slug simply 404s and the host
// is cleanly filtered out. These are also the very rows the app already serves
// to users, and a gross content mismatch would still be caught downstream by
// multi_host._duration_cohort.
const r = await db.execute({
  sql: `SELECT pm.ani_id       AS ani_id,
               pm.lang         AS lang,
               pm.slug         AS slug,
               pm.season_dir   AS season_dir,
               pm.episode_count AS episode_count,
               a.id_mal        AS id_mal,
               va.slug         AS va_slug
          FROM player_map pm
          JOIN anime a ON a.id = pm.ani_id
          LEFT JOIN player_map va
                 ON va.ani_id = pm.ani_id
                AND va.lang   = pm.lang
                AND va.source = 'voiranime'
                AND va.status IN ('verified', 'heuristic')
                AND va.slug IS NOT NULL
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
    // PER-LANG, not per-anime: voir-anime slugs differ BETWEEN languages, not
    // just from anime-sama's. Ashita no Joe is `ashita-no-joe` in VOSTFR and
    // `ashita-no-joe-2-vf` in VF. Hanging one va_slug off the anime meant
    // whichever lang was read first silently overwrote the other.
    ...(row.va_slug ? { va_slug: String(row.va_slug) } : {}),
  });
}

// VOIR-ANIME-ONLY LANGUAGES. The query above is anime-sama-centric, so a
// language that exists ONLY on voir-anime produced no panel at all and the
// detector never saw it. Ashita no Joe is the case that surfaced it: anime-sama
// carries only VOSTFR, while the app offers a VF through Voir-Anime Vidmoly —
// so every VF run was invisible to the batch, and the audit sheet reported one
// unlabelled "vidmoly-va" row that was in fact VOSTFR only.
//
// Such a panel borrows the anime-sama season_dir and episode range of the
// anime's other language (voir-anime rows carry no season dir). The anime-sama
// hosts will simply report "not offered by anime-sama for this season" and be
// filtered out, exactly as they already are for any host a season lacks —
// vidmoly-va is the one that can serve it, and it now can.
const vaLangs = await db.execute({
  sql: `SELECT ani_id, lang, slug FROM player_map
         WHERE source = 'voiranime' AND slug IS NOT NULL
           AND status IN ('verified', 'heuristic')`,
  args: [],
});
// ANIME-SAMA LANGUAGES THAT ARE ONLY `heuristic`. The main query demands
// `verified`, which is right for the slug/season (a wrong one sends ffmpeg at
// hours of the WRONG stream) — but it also drops languages the seed never
// covered. VF panels are mostly written at RUNTIME by the app, so they are
// `heuristic` far more often than VOSTFR: 69 heuristic VF rows against 542
// verified. Dandadan is the case Luc hit — the app offers Anime-Sama Ansembed
// in VF, the batch never tried it.
//
// Accepted ONLY when the slug AND season_dir match a row already verified for
// this anime: the risky part is then vouched for, and all that differs is the
// language sub-path (`…/saison1/vf/` instead of `…/saison1/vostfr/`), which
// resolves cleanly or 404s.
const asLangs = await db.execute({
  sql: `SELECT ani_id, lang, slug, season_dir, episode_count FROM player_map
         WHERE source = ? AND status = 'heuristic' AND slug IS NOT NULL`,
  args: [SOURCE],
});
let addedHeuristicLang = 0;
for (const row of asLangs.rows) {
  const entry = byAnime.get(Number(row.ani_id));
  if (!entry) continue;
  const lang = String(row.lang);
  if (entry.seasons.some((s) => s.lang === lang)) continue;
  const dir = row.season_dir ? String(row.season_dir) : "saison1";
  const twin = entry.seasons.find(
    (s) => s.season_dir === dir && entry.slug === String(row.slug),
  );
  if (!twin) continue;
  const count = row.episode_count == null ? twin.ep_end : Number(row.episode_count);
  entry.seasons.push({
    season_dir: dir,
    lang,
    ep_start: 1,
    ep_end: count && count >= MIN_EP ? count : twin.ep_end,
  });
  addedHeuristicLang++;
}
if (addedHeuristicLang) {
  console.log(
    `[export-oped] ${addedHeuristicLang} heuristic-language panel(s) added ` +
      `(slug+season already verified)`,
  );
}

// Voir-anime slug per (anime, language). Applied to EVERY season at the end
// rather than during the main query, so the panels added above get theirs too —
// the JOIN only ever saw the languages that query returned.
const vaByKey = new Map();
for (const row of vaLangs.rows) {
  vaByKey.set(`${row.ani_id}:${row.lang}`, String(row.slug));
}

let addedVaOnly = 0;
for (const [aniId, entry] of byAnime) {
  for (const s of entry.seasons) {
    const slug = vaByKey.get(`${aniId}:${s.lang}`);
    if (slug) s.va_slug = slug;
  }
  // …then languages voir-anime has and anime-sama does not.
  for (const [key, slug] of vaByKey) {
    const [id, lang] = key.split(":");
    if (Number(id) !== aniId) continue;
    if (entry.seasons.some((s) => s.lang === lang)) continue;
    const model = entry.seasons[0];
    if (!model) continue;
    entry.seasons.push({
      season_dir: model.season_dir,
      lang,
      ep_start: model.ep_start,
      ep_end: model.ep_end,
      va_slug: slug,
      va_only: true, // anime-sama has no panel for this language
    });
    addedVaOnly++;
  }
}
if (addedVaOnly) {
  console.log(`[export-oped] ${addedVaOnly} voir-anime-only language panel(s) added`);
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
