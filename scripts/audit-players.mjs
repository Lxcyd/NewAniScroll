#!/usr/bin/env node
/**
 * Player audit for AniScroll — anime-sama + voir-anime.
 *
 * Walks every anime in the `anime` Turso cache and, for each, asks the live
 * /api/v2/source/inspect endpoint what anime-sama and voir-anime resolve to
 * (slug, chosen season, episode count) for VOSTFR and VF. It then does a STRONG
 * check: the episode count the source exposes for the chosen season must line
 * up with the AniList episode count for that exact entry. A mismatch reveals a
 * wrong-season / wrong-slug mapping (e.g. Kaiju No. 8 S2 falling back to the
 * S1 panel, which has a different episode count), or a missing player.
 *
 * It writes a JSON report you can use to fix the matching logic site-wide —
 * the per-anime slug/season/count breakdown surfaces the FAILURE PATTERNS
 * (all S2+ falling to saison1, voir-anime slug conventions missed, …) so the
 * fix hardens every anime, present and future.
 *
 * NO database writes. Read-only audit.
 *
 * Usage:
 *   node scripts/audit-players.mjs                       # full, dev site
 *   node scripts/audit-players.mjs --limit=50
 *   node scripts/audit-players.mjs --id=178025           # one anime
 *   node scripts/audit-players.mjs --only=animesama      # one source
 *   node scripts/audit-players.mjs --lang=vostfr         # one language
 *   node scripts/audit-players.mjs --concurrency=4
 *   node scripts/audit-players.mjs --min-popularity=5000 # only popular titles
 *   node scripts/audit-players.mjs --site=https://aniscroll.com
 *   node scripts/audit-players.mjs --out=scripts/out/player-audit.json
 *
 * Env:
 *   SITE_URL  (default: https://dev.aniscroll.com) — overridden by --site
 *   TURSO_DATABASE_URL + TURSO_AUTH_TOKEN  (required — the anime catalogue)
 */
import { createClient } from "@libsql/client";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// ── args ──────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const SITE = (args.site || process.env.SITE_URL || "https://dev.aniscroll.com").replace(/\/$/, "");
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const CONCURRENCY = Number(args.concurrency || 4);
const ONE_ID = args.id ? Number(args.id) : null;
const ONLY = args.only ? String(args.only).toLowerCase() : null; // animesama|voiranime
const LANG = args.lang ? String(args.lang).toLowerCase() : null; // vostfr|vf
const MIN_POP = args["min-popularity"] ? Number(args["min-popularity"]) : 0;
const OUT = args.out || "scripts/out/player-audit.json";

// Episode-count tolerance: cours/recaps/specials shift counts by a little, so
// a difference of ±1 isn't treated as "wrong season". A source count that is
// WAY over the AniList count (≥ +3 and ≥ 1.5×) is the strong wrong-season tell.
const COUNT_TOLERANCE = 1;

const SOURCES = ["animesama", "voiranime"].filter((s) => !ONLY || s === ONLY);
const LANGS = ["vostfr", "vf"].filter((l) => !LANG || l === LANG);

// ── db ────────────────────────────────────────────────────────────────────
const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error("Missing TURSO_DATABASE_URL (and probably TURSO_AUTH_TOKEN).");
  process.exit(1);
}
const db = createClient({ url, authToken });

// Pull the catalogue. Only TV-like formats have seasons/episodes worth auditing;
// drop movies/music and not-yet-released entries (nothing to serve yet).
let rows;
if (ONE_ID) {
  rows = (await db.execute({ sql: "SELECT id, data FROM anime WHERE id = ?", args: [ONE_ID] })).rows;
} else {
  rows = (
    await db.execute({
      sql: `SELECT id, data FROM anime
             WHERE format IN ('TV','ONA','OVA','TV_SHORT')
               AND (status IS NULL OR status != 'NOT_YET_RELEASED')
               AND (popularity IS NULL OR popularity >= ?)
             ORDER BY popularity DESC`,
      args: [MIN_POP],
    })
  ).rows;
}

/** Expected episode count for THIS AniList entry (not the whole franchise). */
function expectedEpisodes(media) {
  if (!media) return null;
  if (typeof media.episodes === "number" && media.episodes > 0) return media.episodes;
  // Ongoing show: AniList reports episodes:null but exposes the next airing ep.
  const next = media.nextAiringEpisode?.episode;
  if (typeof next === "number" && next > 1) return next - 1;
  return null;
}

const animes = rows
  .map((r) => {
    let media = null;
    try {
      media = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
    } catch {
      /* skip rows with corrupt blobs */
    }
    if (!media) return null;
    return {
      aniId: Number(r.id),
      title: media.title?.english || media.title?.romaji || `#${r.id}`,
      format: media.format || null,
      status: media.status || null,
      aniEpisodes: expectedEpisodes(media),
      ongoing: media.status === "RELEASING",
    };
  })
  .filter(Boolean);

const total = Math.min(animes.length, LIMIT);
console.log(
  `[audit] ${animes.length} anime in catalogue → auditing ${total} ` +
    `(sources: ${SOURCES.join(",")}; langs: ${LANGS.join(",")}; site: ${SITE})`,
);

// ── inspect call ────────────────────────────────────────────────────────────
async function inspect(aniId, source, lang) {
  const u = `${SITE}/api/v2/source/inspect?aniId=${aniId}&source=${source}&lang=${lang}`;
  try {
    const res = await fetch(u, {
      headers: { "User-Agent": "aniscroll-audit/1.0", "X-Warmer": "1" },
    });
    if (!res.ok) return { found: false, httpError: res.status };
    return await res.json();
  } catch (e) {
    return { found: false, fetchError: e?.message || String(e) };
  }
}

/**
 * Classify one source/lang result against the AniList episode count.
 *   missing-player        — source resolved nothing
 *   wrong-season          — source count is WAY over AniList (fell to wrong panel)
 *   episode-count-low     — source has notably FEWER eps than AniList (missing eps)
 *   ongoing-behind        — ongoing show, source a bit behind (info only)
 *   ok                    — counts line up
 *   unknown               — no AniList count to compare against
 */
function classify(anime, r) {
  if (!r || !r.found) return { type: "missing-player" };
  const aniEp = anime.aniEpisodes;
  const srcEp = r.episodeCount || 0;
  if (!aniEp) return { type: "unknown", srcEp };

  const diff = srcEp - aniEp;
  // Strong wrong-season tell: source carries many more episodes than this
  // entry should have → it's pointing at a bigger/earlier panel.
  if (diff >= 3 && srcEp >= aniEp * 1.5) return { type: "wrong-season", aniEp, srcEp };
  if (diff > COUNT_TOLERANCE) return { type: "wrong-season", aniEp, srcEp };
  if (diff < -COUNT_TOLERANCE) {
    if (anime.ongoing) return { type: "ongoing-behind", aniEp, srcEp };
    return { type: "episode-count-low", aniEp, srcEp };
  }
  return { type: "ok", aniEp, srcEp };
}

// ── run ──────────────────────────────────────────────────────────────────
const report = [];
const tally = {}; // `${source}:${lang}:${type}` → count
const bump = (k) => (tally[k] = (tally[k] || 0) + 1);

let done = 0;
const t0 = Date.now();

async function auditOne(anime) {
  const issues = [];
  const details = [];
  for (const source of SOURCES) {
    for (const lang of LANGS) {
      const r = await inspect(anime.aniId, source, lang);
      const verdict = classify(anime, r);
      bump(`${source}:${lang}:${verdict.type}`);
      const entry = {
        source,
        lang,
        type: verdict.type,
        slug: r.slug ?? null,
        seasonNum: r.seasonNum ?? null,
        chosenSeasonDir: r.chosenSeasonDir ?? null,
        chosenSeasonLabel: r.chosenSeasonLabel ?? null,
        episodeCount: r.episodeCount ?? 0,
      };
      details.push(entry);
      // Only the actionable verdicts go in `issues`; ok/ongoing-behind/unknown
      // are kept in `details` for context but don't flag the anime.
      if (verdict.type === "missing-player" || verdict.type === "wrong-season" || verdict.type === "episode-count-low") {
        issues.push(entry);
      }
    }
  }
  if (issues.length > 0 || details.some((d) => d.type !== "ok")) {
    report.push({
      aniId: anime.aniId,
      title: anime.title,
      format: anime.format,
      status: anime.status,
      aniEpisodes: anime.aniEpisodes,
      issues,
      details,
    });
  }
  done++;
  if (done % 10 === 0 || done === total) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write(
      `\r[audit] ${done}/${total}  flagged=${report.length}  ${elapsed}s`,
    );
  }
}

const queue = animes.slice(0, total);
async function worker() {
  while (queue.length) {
    const a = queue.shift();
    if (!a) return;
    await auditOne(a);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// ── output ─────────────────────────────────────────────────────────────────
// Sort the report worst-first: most issues, then wrong-season before missing.
const sev = { "wrong-season": 0, "episode-count-low": 1, "missing-player": 2 };
report.sort((a, b) => {
  if (b.issues.length !== a.issues.length) return b.issues.length - a.issues.length;
  const as = Math.min(...a.issues.map((i) => sev[i.type] ?? 9), 9);
  const bs = Math.min(...b.issues.map((i) => sev[i.type] ?? 9), 9);
  return as - bs;
});

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(report, null, 2), "utf8");

console.log(`\n\n[audit] done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`[audit] ${total} audited, ${report.length} flagged → ${OUT}\n`);
console.log("Breakdown (source:lang:verdict → count):");
for (const k of Object.keys(tally).sort()) {
  console.log(`  ${k.padEnd(34)} ${tally[k]}`);
}

// A few concrete worst cases so you see them without opening the JSON.
const worst = report.filter((r) => r.issues.some((i) => i.type === "wrong-season")).slice(0, 15);
if (worst.length) {
  console.log("\nTop wrong-season suspects:");
  for (const r of worst) {
    const w = r.issues.find((i) => i.type === "wrong-season");
    console.log(
      `  ${String(r.aniId).padEnd(8)} ${(r.title || "").slice(0, 42).padEnd(42)} ` +
        `aniEp=${r.aniEpisodes} ${w.source}/${w.lang} → ${w.slug}/${w.chosenSeasonDir || "?"} (${w.episodeCount} ep)`,
    );
  }
}

process.exit(0);
