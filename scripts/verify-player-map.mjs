/**
 * Incremental player_map verifier — the maintenance loop of the player
 * infrastructure. Re-derives due mappings with the CURRENT resolver code and
 * promotes/demotes them:
 *
 *   node --env-file=.env.local scripts/verify-player-map.mjs \
 *        [--site=http://localhost:3000] [--limit=200] [--concurrency=6] \
 *        [--ids=123,456]  [--dry]
 *
 * What gets picked up (oldest deadline first, capped by --limit so a run has a
 * BOUNDED worker budget):
 *   • status='heuristic'      — runtime write-backs awaiting their first check
 *   • expires_at < now        — verified RELEASING rows (weekly), broken rows
 *                               (retry), absent rows (catalogues grow)
 *   • --ids                   — explicit re-checks (e.g. after a user report)
 *
 * Verdicts (same safety gates as the seed — KEEP IN SYNC):
 *   verified — inspect found slug(+dir), episode count consistent with
 *              AniList (±1, behind-ok for RELEASING, or merged with offset),
 *              title confidence > 0, no S1-collapse shape, langs consistent.
 *   broken   — found but failing a gate (would serve wrong content).
 *   absent   — inspect found nothing. Trustworthy here (unlike the historic
 *              audit) because we run with the current, fixed resolver.
 */
import { createClient } from "@libsql/client";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const SITE = (args.site || process.env.SITE_URL || "http://localhost:3000").replace(/\/$/, "");
const LIMIT = Number(args.limit || 200);
const CONCURRENCY = Number(args.concurrency || 6);
const DRY = !!args.dry;
const ONLY_IDS = args.ids
  ? new Set(String(args.ids).split(",").map(Number).filter(Boolean))
  : null;

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

/* ── gating helpers (KEEP IN SYNC with seed-player-map.mjs + source/index.js) ── */
const SLUG_STOPWORDS = new Set([
  "the", "les", "des", "une", "der", "die", "das", "and", "for", "you", "her",
  "his", "day", "new", "of", "my", "no", "to", "wa", "ga", "ni", "de", "la",
  "le", "wo", "san", "kun", "chan", "season", "part", "tv", "ova", "ona", "aux",
  "sur",
]);
const normalize = (s) =>
  (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const titleToSlug = (t) => normalize(t).replace(/\s+/g, "-");
const significantTokens = (s) => [
  ...new Set(normalize(String(s).replace(/-/g, " ")).split(" ").filter((t) => t.length >= 3 && !SLUG_STOPWORDS.has(t))),
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
    const matched = slugSig.filter((tok) => titleSig.has(tok)).reduce((a, tok) => a + tok.length, 0);
    const titleLen = significantTokens(t).reduce((a, tok) => a + tok.length, 0);
    const cov = matched / Math.min(slugLen, titleLen);
    if (cov > best) best = cov;
  }
  return best;
}
const DAY = 86400;
const ttl = (status, animeStatus) => {
  switch (status) {
    case "verified":  return animeStatus === "RELEASING" ? 7 * DAY : 90 * DAY;
    case "broken":    return 7 * DAY;
    case "absent":    return 30 * DAY;
    default:          return 14 * DAY;
  }
};

/* ── pick work ──────────────────────────────────────────────────────────── */
const now = Math.floor(Date.now() / 1000);
let rows;
if (ONLY_IDS) {
  const ids = [...ONLY_IDS];
  const ph = ids.map(() => "?").join(",");
  rows = (await db.execute({
    sql: `SELECT * FROM player_map WHERE ani_id IN (${ph})`,
    args: ids,
  })).rows;
} else {
  rows = (await db.execute({
    sql: `SELECT * FROM player_map
           WHERE expires_at < ? OR status = 'heuristic'
           ORDER BY expires_at ASC LIMIT ?`,
    args: [now, LIMIT],
  })).rows;
}
// Group by (aniId, source) so we verify both langs together (cross-lang gate).
const groups = new Map();
for (const r of rows) {
  const k = `${r.ani_id}:${r.source}`;
  if (!groups.has(k)) groups.set(k, { aniId: Number(r.ani_id), source: String(r.source), langs: new Set() });
  groups.get(k).langs.add(String(r.lang));
}
console.log(`[verify] ${rows.length} rows due → ${groups.size} (anime,source) groups  site=${SITE}`);
if (groups.size === 0) process.exit(0);

/* ── anime meta (episodes, status, titles) from local cache ─────────────── */
const aniIds = [...new Set([...groups.values()].map((g) => g.aniId))];
const metaById = new Map();
for (let i = 0; i < aniIds.length; i += 500) {
  const chunk = aniIds.slice(i, i + 500);
  const ph = chunk.map(() => "?").join(",");
  const r = await db.execute({
    sql: `SELECT id, status,
                 json_extract(data,'$.episodes')       AS eps,
                 json_extract(data,'$.title.english')  AS en,
                 json_extract(data,'$.title.romaji')   AS ro,
                 json_extract(data,'$.title.native')   AS na,
                 json_extract(data,'$.synonyms')       AS syn
            FROM anime WHERE id IN (${ph})`,
    args: chunk,
  });
  for (const row of r.rows) {
    let syn = []; try { syn = JSON.parse(row.syn || "[]"); } catch {}
    metaById.set(Number(row.id), {
      status: row.status,
      episodes: row.eps == null ? null : Number(row.eps),
      titles: [row.en, row.ro, row.na, ...syn].filter(Boolean),
    });
  }
}

/* ── verification ───────────────────────────────────────────────────────── */
async function inspect(aniId, source, lang) {
  const u = `${SITE}/api/v2/source/inspect?aniId=${aniId}&source=${source}&lang=${lang}`;
  try {
    const res = await fetch(u, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function judge(aniId, source, lang, insp, sibling, meta) {
  if (!insp) return null; // transient — leave the row alone
  if (!insp.found || !insp.slug) return { status: "absent", note: "verify:not-found" };
  if (source === "animesama" && !insp.chosenSeasonDir) return { status: "absent", note: "verify:no-panel" };

  const conf = slugTitleConfidence(insp.slug.replace(/-vf$/i, ""), meta?.titles || []);
  if (conf <= 0) return { status: "broken", note: "verify:zero-title-confidence" };

  // S1-collapse shape: a later season on saison1 with no merged offset.
  if (
    source === "animesama" &&
    (insp.seasonNum || 1) > 1 &&
    /^saison1($|\b|hs)/.test(insp.chosenSeasonDir || "") &&
    !(insp.mergedOffset > 0)
  ) {
    return { status: "broken", note: "verify:s1-collapse" };
  }

  // Cross-lang: the sibling lang resolving the SAME slug to a broken shape
  // poisons this one too (count coincidences can't be trusted).
  if (sibling && sibling.judged?.status === "broken" && sibling.insp?.slug === insp.slug) {
    return { status: "broken", note: "verify:sibling-broken" };
  }

  // Episode count consistency. effectiveEpisodes (merged panels) wins.
  const got = insp.merged && insp.effectiveEpisodes != null ? insp.effectiveEpisodes : insp.episodeCount;
  const ani = meta?.episodes ?? null;
  if (ani && got) {
    const diff = got - ani;
    const releasing = meta?.status === "RELEASING";
    const countOk =
      Math.abs(diff) <= 1 ||
      (diff > 1 && !insp.merged) ||      // bigger panel (cours merged) — content right
      (diff < 0 && releasing);           // source behind on an airing show
    if (!countOk) return { status: "broken", note: `verify:count ${got}/${ani}` };
  }

  return {
    status: "verified",
    note: "verify:ok",
    slug: insp.slug,
    seasonDir: source === "animesama" ? insp.chosenSeasonDir : null,
    epOffset: insp.mergedOffset || 0,
    episodeCount: insp.episodeCount ?? null,
    confidence: Math.round(conf * 100) / 100,
  };
}

const tally = {};
const queue = [...groups.values()];
let active = 0, done = 0;

async function worker() {
  for (;;) {
    const g = queue.shift();
    if (!g) return;
    const langs = [...g.langs];
    const inspections = {};
    for (const lang of langs) inspections[lang] = { insp: await inspect(g.aniId, g.source, lang) };
    // two passes so the cross-lang gate sees the sibling's verdict
    for (const lang of langs) {
      const sib = langs.find((l) => l !== lang);
      inspections[lang].judged = judge(g.aniId, g.source, lang, inspections[lang].insp, sib ? inspections[sib] : null, metaById.get(g.aniId));
    }
    for (const lang of langs) {
      const v = inspections[lang].judged;
      if (!v) { tally["skipped:transient"] = (tally["skipped:transient"] || 0) + 1; continue; }
      tally[v.status] = (tally[v.status] || 0) + 1;
      if (!DRY) {
        const meta = metaById.get(g.aniId);
        await db.execute({
          sql: `INSERT INTO player_map
                  (ani_id, source, lang, status, slug, season_dir, ep_offset,
                   episode_count, confidence, fail_count, note, checked_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
                ON CONFLICT(ani_id, source, lang) DO UPDATE SET
                  status        = excluded.status,
                  slug          = excluded.slug,
                  season_dir    = excluded.season_dir,
                  ep_offset     = excluded.ep_offset,
                  episode_count = excluded.episode_count,
                  confidence    = excluded.confidence,
                  fail_count    = 0,
                  note          = excluded.note,
                  checked_at    = excluded.checked_at,
                  expires_at    = excluded.expires_at`,
          args: [
            g.aniId, g.source, lang, v.status,
            v.slug ?? null, v.seasonDir ?? null, v.epOffset ?? 0,
            v.episodeCount ?? null, v.confidence ?? null, v.note,
            now, now + ttl(v.status, meta?.status),
          ],
        });
      }
    }
    done++;
    if (done % 20 === 0) process.stdout.write(`\r[verify] ${done}/${groups.size} groups`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`\n[verify] done — ${JSON.stringify(tally)}`);
