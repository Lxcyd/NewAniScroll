/**
 * Second adversarial lot: everything the first one did NOT cover.
 *
 * Lot 1 capped each shape at 22 titles to keep the mix balanced; that left the
 * long tail untested. This takes the REMAINDER — every odd-shaped panel still
 * unseen, plus a deep popularity spine — so the night ends with the widest
 * corpus we can measure rather than the most balanced one.
 */
import fs from "node:fs";
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const list = JSON.parse(fs.readFileSync("tools/opening-detector/datasets/anime.gated.json", "utf8"));
const done = new Set(
  JSON.parse(fs.readFileSync("tools/opening-detector/datasets/anime.hard.json", "utf8"))
    .map((a) => a.anilist_id),
);
const TARGET = Number(process.env.LOT2_SIZE || 260);
const HEAD_EPS = [1, 2, 3];

// Scalar columns ONLY. Selecting `data` too returns the whole AniList payload
// per row and Turso answers "Resource exhausted" on a 1581-row read — the
// episode count is already in the export (ep_end = player_map episode_count),
// so the blob buys nothing here.
const meta = new Map();
for (const r of (await db.execute(
  "SELECT id, popularity, season_year, format FROM anime")).rows) {
  meta.set(Number(r.id), {
    year: Number(r.season_year || 0),
    pop: Number(r.popularity || 0),
    format: String(r.format || ""),
  });
}
const epCount = (a) => Math.max(...a.seasons.map((s) => Number(s.ep_end) || 0));

const rest = list.filter((a) => !done.has(a.anilist_id));

// Odd shapes first — they are rarer and worth more per title than one more
// mainstream TV season.
const odd = rest.filter((a) => {
  const m = meta.get(a.anilist_id) || {};
  const dirs = a.seasons.map((s) => s.season_dir);
  return dirs.some((d) => /^saison\d+-\d+$/.test(d) || /hs$/i.test(d) || d === "film")
    || epCount(a) >= 100 || (m.year && m.year < 1995) || m.format === "TV_SHORT"
    || m.format === "MOVIE" || a.seasons.some((s) => s.va_only);
});
const oddIds = new Set(odd.map((a) => a.anilist_id));
const bulk = rest
  .filter((a) => !oddIds.has(a.anilist_id))
  .sort((a, b) => (meta.get(b.anilist_id)?.pop || 0) - (meta.get(a.anilist_id)?.pop || 0));

const chosen = [...odd, ...bulk].slice(0, TARGET);

const out = chosen.map((a) => ({
  ...a,
  seasons: a.seasons.map((s) => {
    const last = Number(s.ep_end) || 1;
    const eps = [...new Set([...HEAD_EPS.filter((e) => e <= last), last])].sort((x, y) => x - y);
    const { ep_start, ep_end, ...rest2 } = s;
    return { ...rest2, episodes: eps };
  }),
}));

fs.writeFileSync("tools/opening-detector/datasets/anime.hard2.json", JSON.stringify(out, null, 2), "utf8");
const panels = out.reduce((n, a) => n + a.seasons.length, 0);
const eplangs = out.reduce((n, a) => n + a.seasons.reduce((m, s) => m + s.episodes.length, 0), 0);
console.log(`restants non testes : ${rest.length}  (formes atypiques : ${odd.length})`);
console.log(`lot 2 : ${out.length} anime, ${panels} panneaux, ${eplangs} episode-langues`);
