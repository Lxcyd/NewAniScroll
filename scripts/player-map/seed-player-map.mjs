/**
 * Seed the player_map table from a full player-audit JSON — ZERO worker calls.
 *
 *   node --env-file=.env.local scripts/player-map/seed-player-map.mjs \
 *        --audit=scripts/out/player-audit-full.json [--dry]
 *
 * The full audit already paid the worker cost of verifying every anime ×
 * source × lang; this script turns those observations into production
 * mappings. SAFE-FIRST gating — a row is seeded as `verified` only when ALL
 * of:
 *
 *   1. The audit verdict was `ok` or `ongoing-behind` (episode count matched
 *      AniList, or was merely behind on a RELEASING show). `wrong-season`,
 *      `episode-count-low` and `merged-cours` rows are NOT seeded: they
 *      predate the merged-offset fix, so the (now-smarter) runtime should
 *      re-derive them and write fresh heuristic rows instead.
 *   2. The slug passes the slugTitleConfidence floor recomputed offline
 *      against the anime's full title set (english/romaji/native/synonyms
 *      from the local Turso cache). This excludes the ~25 wrong-anime false
 *      positives the audit had classified "ok" by episode-count coincidence
 *      (e.g. Banner of the Stars → shikkakumon-no-saikyou-kenja).
 *   3. The slug (and, for anime-sama, the chosen season dir) exist.
 *
 * `missing-player` verdicts are NOT seeded as `absent`: the audit ran before
 * the punctuation-slug fix (Re:Zero & co), so many of those now resolve.
 * Seeding them absent would hide the fix for 30 days.
 */
import fs from "node:fs";
import { createClient } from "@libsql/client";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const AUDIT = args.audit || "scripts/out/player-audit-full.json";
const DRY = !!args.dry;

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

/* ── title-confidence gating (KEEP IN SYNC with pages/api/v2/source/index.js:
      slugTitleConfidence / significantTokens / SLUG_STOPWORDS) ───────────── */
const SLUG_STOPWORDS = new Set([
  "the", "les", "des", "une", "der", "die", "das", "and", "for", "you", "her",
  "his", "day", "new", "of", "my", "no", "to", "wa", "ga", "ni", "de", "la",
  "le", "wo", "san", "kun", "chan", "season", "part", "tv", "ova", "ona", "aux",
  "sur",
]);
const normalize = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const titleToSlug = (t) => normalize(t).replace(/\s+/g, "-");
const significantTokens = (s) => [
  ...new Set(
    normalize(String(s).replace(/-/g, " "))
      .split(" ")
      .filter((t) => t.length >= 3 && !SLUG_STOPWORDS.has(t)),
  ),
];
function slugTitleConfidence(slug, titles) {
  const slugSig = significantTokens(slug);
  if (slugSig.length === 0) return 1;
  const slugLen = slugSig.reduce((a, t) => a + t.length, 0);
  let best = 0;
  for (const t of (titles || []).filter(Boolean)) {
    const ts = titleToSlug(t);
    if (ts === slug || ts.replace(/-/g, "") === slug.replace(/-/g, "")) return 1;
    const titleSig = new Set(significantTokens(t));
    if (titleSig.size === 0) continue;
    const matched = slugSig
      .filter((tok) => titleSig.has(tok))
      .reduce((a, tok) => a + tok.length, 0);
    const titleLen = significantTokens(t).reduce((a, tok) => a + tok.length, 0);
    const cov = matched / Math.min(slugLen, titleLen);
    if (cov > best) best = cov;
  }
  return best;
}

/* ── TTLs (mirror lib/db/playerMap.ts playerMapTtl) ─────────────────────── */
const DAY = 86400;
const ttlVerified = (animeStatus) =>
  animeStatus === "RELEASING" ? 7 * DAY : 90 * DAY;

/* ── load audit ─────────────────────────────────────────────────────────── */
const audit = JSON.parse(fs.readFileSync(AUDIT, "utf8"));
console.log(`[seed] ${audit.length} anime in audit ${AUDIT}`);

/* ── titles from local Turso cache, batched ─────────────────────────────── */
const ids = audit.map((r) => r.aniId);
const titlesById = new Map();
for (let i = 0; i < ids.length; i += 500) {
  const chunk = ids.slice(i, i + 500);
  const placeholders = chunk.map(() => "?").join(",");
  const r = await db.execute({
    sql: `SELECT id,
                 json_extract(data,'$.title.english')  AS en,
                 json_extract(data,'$.title.romaji')   AS ro,
                 json_extract(data,'$.title.native')   AS na,
                 json_extract(data,'$.synonyms')       AS syn
            FROM anime WHERE id IN (${placeholders})`,
    args: chunk,
  });
  for (const row of r.rows) {
    let syn = [];
    try { syn = JSON.parse(row.syn || "[]"); } catch {}
    titlesById.set(Number(row.id), [row.en, row.ro, row.na, ...syn].filter(Boolean));
  }
}
console.log(`[seed] titles loaded for ${titlesById.size} anime`);

/* ── gate + build rows ──────────────────────────────────────────────────── */
const now = Math.floor(Date.now() / 1000);
const rows = [];
const skipped = { verdict: 0, noSlug: 0, confidence: 0, noDir: 0, crossLang: 0, s1Collapse: 0 };

for (const r of audit) {
  const titles = titlesById.get(r.aniId) || [r.title].filter(Boolean);
  for (const d of r.details || []) {
    if (d.type !== "ok" && d.type !== "ongoing-behind") { skipped.verdict++; continue; }
    if (!d.slug) { skipped.noSlug++; continue; }
    if (d.source === "animesama" && !d.chosenSeasonDir) { skipped.noDir++; continue; }
    // CROSS-LANG CONSISTENCY: a slug cannot be correct in one language and
    // wrong-season/count-broken in the other for the SAME source. When the
    // sibling lang got a bad verdict on the same slug, this "ok" is almost
    // certainly an episode-count coincidence on a wrong mapping (Tokyo Ghoul
    // √A VF → tokyo-24-ku, 13ep ≈ 12). Skip — let the verifier decide.
    const sibling = (r.details || []).find(
      (s) => s.source === d.source && s.lang !== d.lang && s.slug === d.slug,
    );
    if (sibling && (sibling.type === "wrong-season" || sibling.type === "episode-count-low")) {
      skipped.crossLang++;
      continue;
    }
    // S1-COLLAPSE SHAPE: a season ≥2 sitting on the saison1 panel with no
    // offset is exactly the wrong-season failure mode, even when the episode
    // count coincides. Never seed it as verified.
    if (
      d.source === "animesama" &&
      (d.seasonNum || 1) > 1 &&
      /^saison1($|\b|hs)/.test(d.chosenSeasonDir || "") &&
      !(d.mergedOffset > 0)
    ) {
      skipped.s1Collapse++;
      continue;
    }
    const conf = slugTitleConfidence(
      d.slug.replace(/-vf$/i, ""), // voiranime VF suffix isn't part of the title
      [...titles, r.title].filter(Boolean),
    );
    if (conf <= 0) { skipped.confidence++; continue; }
    rows.push({
      aniId: r.aniId,
      source: d.source,
      lang: d.lang,
      slug: d.slug,
      seasonDir: d.source === "animesama" ? d.chosenSeasonDir : null,
      epOffset: d.mergedOffset || 0,
      episodeCount: d.episodeCount ?? null,
      confidence: Math.round(conf * 100) / 100,
      note: `seed:${d.type}`,
      animeStatus: r.status || null,
    });
  }
}
console.log(`[seed] ${rows.length} rows pass gating  (skipped: ${JSON.stringify(skipped)})`);
const bySrc = {};
for (const x of rows) bySrc[`${x.source}:${x.lang}`] = (bySrc[`${x.source}:${x.lang}`] || 0) + 1;
console.log(`[seed] by source/lang: ${JSON.stringify(bySrc)}`);

// `--dump=<path>` writes the gated rows and exits WITHOUT touching Turso. This
// is what makes a targeted repair possible: the seed's output is the reference
// set of `verified` mappings, so diffing it against the live table tells you
// exactly which verified rows have gone missing — without the collateral of
// re-running the whole upsert, which would overwrite every current value with
// the audit's (2025-06-11) snapshot.
if (args.dump) {
  fs.writeFileSync(args.dump, JSON.stringify(rows, null, 2), "utf8");
  console.log(`[seed] --dump: wrote ${rows.length} gated rows to ${args.dump} (no DB write)`);
  process.exit(0);
}

if (DRY) {
  console.log("[seed] --dry: not writing. Sample rows:");
  for (const x of rows.slice(0, 10)) console.log("  ", JSON.stringify(x));
  process.exit(0);
}

/* ── batched upsert ─────────────────────────────────────────────────────── */
let written = 0;
for (let i = 0; i < rows.length; i += 100) {
  const chunk = rows.slice(i, i + 100);
  await db.batch(
    chunk.map((x) => ({
      sql: `INSERT INTO player_map
              (ani_id, source, lang, status, slug, season_dir, ep_offset,
               episode_count, confidence, fail_count, note, checked_at, expires_at)
            VALUES (?, ?, ?, 'verified', ?, ?, ?, ?, ?, 0, ?, ?, ?)
            ON CONFLICT(ani_id, source, lang) DO UPDATE SET
              status        = 'verified',
              slug          = excluded.slug,
              season_dir    = excluded.season_dir,
              ep_offset     = excluded.ep_offset,
              episode_count = excluded.episode_count,
              confidence    = excluded.confidence,
              note          = excluded.note,
              checked_at    = excluded.checked_at,
              expires_at    = excluded.expires_at`,
      args: [
        x.aniId, x.source, x.lang, x.slug, x.seasonDir, x.epOffset,
        x.episodeCount, x.confidence, x.note, now, now + ttlVerified(x.animeStatus),
      ],
    })),
  );
  written += chunk.length;
  process.stdout.write(`\r[seed] written ${written}/${rows.length}`);
}
console.log(`\n[seed] done — ${written} verified mappings seeded`);
