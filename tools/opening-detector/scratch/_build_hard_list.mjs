/**
 * Build an ADVERSARIAL anime list for the OP/ED detector.
 *
 * The point is not coverage, it is breakage: every bucket below is a shape that
 * has already broken this pipeline at least once, or that structurally can.
 * Episodes start at 1 on purpose — a premiere is the single most irregular
 * episode there is (cold open before the OP, double length, no OP at all, an
 * ED that is really the OP) and every previous lot started at 2, so episode 1
 * has never been under test.
 *
 * Usage: node --env-file=.env.local tools/opening-detector/scratch/_build_hard_list.mjs
 */
import fs from "node:fs";
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const SRC = "tools/opening-detector/datasets/anime.gated.json";
const OUT = "tools/opening-detector/datasets/anime.hard.json";
// Episodes 1, 2, 3 and the FINALE. The two ends of a season are the irregular
// ones — a premiere can run double length or delay the OP behind a cold open,
// a finale often drops the ED, swaps it for the OP, or rolls credits over the
// closing scene — and every earlier lot sampled 2-4, i.e. neither end.
const HEAD_EPS = [1, 2, 3];

const list = JSON.parse(fs.readFileSync(SRC, "utf8"));
const byAni = new Map(list.map((a) => [a.anilist_id, a]));

// Metadata the export does not carry: year, episode count, popularity, format.
const meta = new Map();
const rows = await db.execute("SELECT id, data, popularity, season_year, format FROM anime");
for (const r of rows.rows) {
  let d = {};
  try { d = JSON.parse(String(r.data)); } catch { /* keep defaults */ }
  meta.set(Number(r.id), {
    title: d?.title?.romaji || d?.title?.english || "?",
    episodes: Number(d?.episodes || 0),
    year: Number(r.season_year || d?.seasonYear || 0),
    pop: Number(r.popularity || 0),
    format: String(r.format || d?.format || ""),
  });
}

const buckets = new Map();
const tag = (a, why) => {
  if (!buckets.has(why)) buckets.set(why, []);
  if (!buckets.get(why).some((x) => x.anilist_id === a.anilist_id)) buckets.get(why).push(a);
};

for (const a of list) {
  const m = meta.get(a.anilist_id) || {};
  const dirs = a.seasons.map((s) => s.season_dir);
  const langs = new Set(a.seasons.map((s) => s.lang));

  // 1. MERGED / ODD PANELS — "saison2-1", "saison1-2": anime-sama concatenated
  //    or split a season. resolveMergedOffset lives here; a wrong offset serves
  //    the wrong episode entirely.
  if (dirs.some((d) => /^saison\d+-\d+$/.test(d))) tag(a, "panneau fusionne/scinde");
  // 2. FILMS — a movie has no OP/ED in the TV sense; the detector must not
  //    invent one. Also the dual-format path.
  if (dirs.includes("film") || m.format === "MOVIE") tag(a, "film");
  // 3. HORS-SERIE — the bungou-stray-dogs case: hosts served DIFFERENT works
  //    under one panel (700s vs 1451s), median duration belonged to nobody.
  if (dirs.some((d) => /hs$/i.test(d))) tag(a, "hors-serie");
  // 4. LONG-RUNNERS — hundreds of episodes, multiple OP/ED per season, and the
  //    season-offset logic under maximum stress.
  if (m.episodes >= 100) tag(a, "long-runner (>=100 ep)");
  // 5. PRE-1995 — 4:3 masters, different theme lengths, mono audio; Ashita no
  //    Joe already showed old titles behave differently.
  if (m.year && m.year < 1995) tag(a, "ancien (<1995)");
  // 6. VERY RECENT — AnimeThemes may not have the references yet; this is where
  //    the self-reference fallback (F1) has to carry the detection alone.
  if (m.year >= 2025) tag(a, "recent (>=2025)");
  // 7. VF PANELS — the dub is a different audio master; and it is the half of
  //    the catalogue the earlier lots barely touched.
  if (langs.has("vf")) tag(a, "panneau VF");
  // 8. VA-ONLY — voir-anime is the ONLY host, so nothing can contradict a bad
  //    result: no cross-host cohort, no consensus. Highest blast radius.
  if (a.seasons.some((s) => s.va_only)) tag(a, "va-only (1 seul hote)");
  // 9. SHORTS — a 12-minute episode where a 90s OP is 12% of the runtime; the
  //    ED window heuristics assume a ~24 min episode.
  if (m.episodes && m.format === "TV_SHORT") tag(a, "format court");
}

// 10. Re:Zero S1 — the one registered split episode (VF ep1 = 01a + 01b, 49 min).
//     This is THE episode 1 that the multipart path exists for.
const rezero = byAni.get(21355);
if (rezero) tag(rezero, "episode 1 scinde (multipart)");

// 11. A popularity-ranked spine so the lot is not only exotica — the titles
//     users actually watch must stay green.
const popular = [...list]
  .filter((a) => (meta.get(a.anilist_id)?.pop || 0) > 0)
  .sort((a, b) => (meta.get(b.anilist_id).pop) - (meta.get(a.anilist_id).pop))
  .slice(0, 60);
for (const a of popular) tag(a, "tres populaire");

// Cap each bucket so no single shape floods the lot, then merge.
const CAP = 22;
const chosen = new Map();
const why = new Map();
for (const [label, arr] of [...buckets].sort((a, b) => a[1].length - b[1].length)) {
  for (const a of arr.slice(0, CAP)) {
    if (!chosen.has(a.anilist_id)) chosen.set(a.anilist_id, a);
    why.set(a.anilist_id, [...(why.get(a.anilist_id) || []), label]);
  }
}

// The panel's own ep_end IS the finale (the exporter sets it from player_map's
// episode_count). Panels of 4 episodes or fewer keep every episode — there is
// no "in between" to skip.
const out = [...chosen.values()].map((a) => ({
  ...a,
  seasons: a.seasons.map((s) => {
    const last = Number(s.ep_end) || 1;
    const eps = [...new Set([...HEAD_EPS.filter((e) => e <= last), last])].sort((x, y) => x - y);
    const { ep_start, ep_end, ...rest } = s;
    return { ...rest, episodes: eps };
  }),
}));

fs.writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");

console.log("BUCKETS (taille reelle / retenu)");
for (const [label, arr] of [...buckets].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${label.padEnd(30)} ${String(arr.length).padStart(4)} / ${Math.min(arr.length, CAP)}`);
}
const panels = out.reduce((n, a) => n + a.seasons.length, 0);
console.log(`\n${out.length} anime, ${panels} panneaux`);
const eplangs = out.reduce((n, a) => n + a.seasons.reduce((m, s) => m + s.episodes.length, 0), 0);
console.log(`= ${eplangs} episode-langues (1,2,3,dernier) -> ${OUT}`);
