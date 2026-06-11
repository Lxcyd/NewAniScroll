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
// Concurrency = how many inspect requests are in flight at once. The work is
// 100% network-bound (Vercel → CF Worker → upstream), so raising this — not
// threads — is what speeds the audit up. The /api/v2/source rate-limiter allows
// 50 req/s per IP; we default high and let the token bucket below stay under it.
const CONCURRENCY = Number(args.concurrency || 32);
// Global request-rate cap (req/s), kept just under the server's 50 r/s limiter
// so a high concurrency can't trip 429s. Tune with --rate.
const RATE_PER_S = Number(args.rate || 40);
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
//
// We DON'T select the full `data` blob — there are ~13k rows and transferring
// every JSON payload in one query blows libsql's HTTP headers timeout. Instead
// we json_extract just the fields we need (episode count, title, status), which
// keeps the result set tiny.
const SELECT_FIELDS = `
  id,
  json_extract(data, '$.episodes')                  AS episodes,
  json_extract(data, '$.nextAiringEpisode.episode') AS next_ep,
  json_extract(data, '$.status')                    AS j_status,
  json_extract(data, '$.format')                    AS j_format,
  json_extract(data, '$.title.english')             AS t_en,
  json_extract(data, '$.title.romaji')              AS t_ro`;

// --ids-file=path : audit only the AniList ids listed in a file (one per line
// or comma-separated). Used to re-check a specific set after a fix.
let idsFromFile = null;
if (args["ids-file"]) {
  const raw = await import("node:fs/promises").then((fs) => fs.readFile(args["ids-file"], "utf8"));
  idsFromFile = [...new Set(raw.split(/[\s,]+/).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0))];
}

let rows;
if (ONE_ID) {
  rows = (await db.execute({ sql: `SELECT ${SELECT_FIELDS} FROM anime WHERE id = ?`, args: [ONE_ID] })).rows;
} else if (idsFromFile) {
  const placeholders = idsFromFile.map(() => "?").join(",");
  rows = (
    await db.execute({
      sql: `SELECT ${SELECT_FIELDS} FROM anime WHERE id IN (${placeholders})`,
      args: idsFromFile,
    })
  ).rows;
} else {
  rows = (
    await db.execute({
      sql: `SELECT ${SELECT_FIELDS} FROM anime
             WHERE format IN ('TV','ONA','OVA','TV_SHORT')
               AND (status IS NULL OR status != 'NOT_YET_RELEASED')
               AND (popularity IS NULL OR popularity >= ?)
             ORDER BY popularity DESC`,
      args: [MIN_POP],
    })
  ).rows;
}

/** Expected episode count for THIS AniList entry (not the whole franchise). */
function expectedEpisodes(episodes, nextEp) {
  if (typeof episodes === "number" && episodes > 0) return episodes;
  // Ongoing show: AniList reports episodes:null but exposes the next airing ep.
  if (typeof nextEp === "number" && nextEp > 1) return nextEp - 1;
  return null;
}

const animes = rows
  .map((r) => {
    const status = r.j_status || null;
    return {
      aniId: Number(r.id),
      title: r.t_en || r.t_ro || `#${r.id}`,
      format: r.j_format || null,
      status,
      aniEpisodes: expectedEpisodes(
        typeof r.episodes === "number" ? r.episodes : r.episodes != null ? Number(r.episodes) : null,
        typeof r.next_ep === "number" ? r.next_ep : r.next_ep != null ? Number(r.next_ep) : null,
      ),
      ongoing: status === "RELEASING",
    };
  })
  .filter(Boolean);

const total = Math.min(animes.length, LIMIT);
console.log(
  `[audit] ${animes.length} anime in catalogue → auditing ${total} ` +
    `(sources: ${SOURCES.join(",")}; langs: ${LANGS.join(",")}; site: ${SITE})`,
);

// ── rate limiter (token bucket) ──────────────────────────────────────────────
// Caps the GLOBAL request rate regardless of concurrency so a fat pool can't
// blow past the server's 50 r/s limiter. Refills RATE_PER_S tokens per second,
// burst capped at one second's worth.
const bucket = { tokens: RATE_PER_S, last: Date.now() };
function refill() {
  const now = Date.now();
  bucket.tokens = Math.min(RATE_PER_S, bucket.tokens + ((now - bucket.last) / 1000) * RATE_PER_S);
  bucket.last = now;
}
async function takeToken() {
  for (;;) {
    refill();
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }
    // Sleep just long enough for the next token to accrue.
    await new Promise((r) => setTimeout(r, Math.ceil(1000 / RATE_PER_S)));
  }
}

// ── inspect call ────────────────────────────────────────────────────────────
// The endpoint can be slow for big franchises (it walks seasons + episodes.js
// through the CF Worker), so we cap each request with our own AbortController —
// Node's default headers timeout would otherwise throw an uncaught rejection
// that derails the whole batch. A timeout is just recorded as found:false.
const REQUEST_TIMEOUT_MS = Number(args["request-timeout"] || 45000);

async function inspect(aniId, source, lang) {
  const u = `${SITE}/api/v2/source/inspect?aniId=${aniId}&source=${source}&lang=${lang}`;
  // Up to 3 attempts, backing off on a 429 (rate-limited) so a brief overshoot
  // doesn't drop the anime from the audit.
  for (let attempt = 0; attempt < 3; attempt++) {
    await takeToken();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(u, {
        headers: { "User-Agent": "aniscroll-audit/1.0", "X-Warmer": "1" },
        signal: ctrl.signal,
      });
      if (res.status === 429) {
        clearTimeout(timer);
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return { found: false, httpError: res.status };
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      // A timeout is worth one retry (slow upstream); other errors aren't.
      if (e?.name === "AbortError" && attempt < 2) continue;
      return {
        found: false,
        fetchError: e?.name === "AbortError" ? "timeout" : e?.message || String(e),
      };
    } finally {
      clearTimeout(timer);
    }
  }
  return { found: false, fetchError: "rate-limited" };
}

/**
 * Classify one source/lang result against the AniList episode count.
 *
 * The episode COUNT alone over-flags: anime-sama legitimately merges split-cours
 * into one panel (a 12-ep AniList cour sits inside a 24-ep "Saison N" panel —
 * the content is correct, only the count differs) and parks OVAs/specials (tiny
 * aniEp) inside multi-ep panels. So we separate the genuine bug from benign
 * count differences using the chosen panel:
 *
 *   missing-player   — source resolved nothing.
 *   wrong-season     — a LATER season (seasonNum>1) collapsed onto saison1 even
 *                      though the chosen panel can't be that season (the real
 *                      "S2 served S1" bug). This is the actionable one.
 *   merged-cours     — landed on a sensible season panel but the count is bigger
 *                      than the AniList cour (cours merged / OVA in a panel).
 *                      Content is right; info-only, NOT flagged as a bug.
 *   episode-count-low— fewer eps than AniList on a finished show (missing eps).
 *   ongoing-behind   — ongoing show, source a bit behind (info-only).
 *   ok               — counts line up.
 *   unknown          — no AniList count to compare against.
 */
function classify(anime, r) {
  if (!r || !r.found) return { type: "missing-player" };
  const aniEp = anime.aniEpisodes;
  const dir = r.chosenSeasonDir || "";
  const sn = r.seasonNum || 1;

  // MERGED PANEL: the season landed on a franchise panel that concatenates every
  // season's episodes, and the resolver computed a valid offset into it (Gintama,
  // Fairy Tail, DBZ Kai…). The player will index at offset+ep, so this is the
  // CORRECT content — not a wrong-season collapse. Compare AniList's count to the
  // per-season window the offset exposes, not the whole merged length.
  if (r.merged && r.mergedOffset > 0) {
    const eff = Number(r.effectiveEpisodes) || (r.episodeCount - r.mergedOffset);
    if (!aniEp) return { type: "ok", aniEp, srcEp: eff, merged: true };
    const d = eff - aniEp;
    if (d < -COUNT_TOLERANCE) {
      return anime.ongoing
        ? { type: "ongoing-behind", aniEp, srcEp: eff, merged: true }
        : { type: "episode-count-low", aniEp, srcEp: eff, merged: true };
    }
    // Within tolerance or a few extra (recap/OVA) → merged but correct.
    return { type: "ok", aniEp, srcEp: eff, merged: true };
  }

  const srcEp = r.episodeCount || 0;
  // Did we collapse a later season onto saison1? That's the real, actionable
  // wrong-season bug (the chosen panel is the first one, not season N).
  const collapsedToS1 = sn > 1 && /^saison1(\b|$|hs)/.test(dir);
  if (!aniEp) {
    // No AniList count: still flag the collapse, it's content-wrong regardless.
    return collapsedToS1 ? { type: "wrong-season", aniEp, srcEp } : { type: "unknown", srcEp };
  }

  const diff = srcEp - aniEp;
  if (diff > COUNT_TOLERANCE) {
    // More eps than the AniList cour. Only a BUG when it collapsed to saison1
    // for a later season; otherwise it's anime-sama merging cours into one
    // panel (right content, bigger count) → benign, info-only.
    return collapsedToS1
      ? { type: "wrong-season", aniEp, srcEp }
      : { type: "merged-cours", aniEp, srcEp };
  }
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
  const combos = [];
  for (const source of SOURCES) for (const lang of LANGS) combos.push({ source, lang });

  // The server caches the season/slug per aniId after the first resolve, so the
  // 4 combos share work. We do the FIRST combo alone (warms that cache), then
  // fire the rest in parallel — avoids a 4-way cold-resolve stampede on the same
  // anime while still overlapping the bulk of the latency.
  const results = [];
  results.push({ ...combos[0], r: await inspect(anime.aniId, combos[0].source, combos[0].lang) });
  if (combos.length > 1) {
    const rest = await Promise.all(
      combos.slice(1).map(async (c) => ({ ...c, r: await inspect(anime.aniId, c.source, c.lang) })),
    );
    results.push(...rest);
  }

  const issues = [];
  const details = [];
  for (const { source, lang, r } of results) {
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
      merged: r.merged ?? false,
      mergedOffset: r.mergedOffset ?? 0,
      effectiveEpisodes: r.effectiveEpisodes ?? null,
    };
    details.push(entry);
    // Only the actionable verdicts go in `issues`; ok/ongoing-behind/unknown
    // are kept in `details` for context but don't flag the anime.
    if (verdict.type === "missing-player" || verdict.type === "wrong-season" || verdict.type === "episode-count-low") {
      issues.push(entry);
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
    const elapsed = (Date.now() - t0) / 1000;
    const rate = done / elapsed;
    const eta = rate > 0 ? Math.round((total - done) / rate) : 0;
    process.stdout.write(
      `\r[audit] ${done}/${total}  flagged=${report.length}  ${rate.toFixed(1)}/s  ${elapsed.toFixed(0)}s  ETA ${eta}s   `,
    );
  }
}

const queue = animes.slice(0, total);
async function worker() {
  while (queue.length) {
    const a = queue.shift();
    if (!a) return;
    try {
      await auditOne(a);
    } catch (e) {
      // A single anime must never kill the batch — record and move on.
      console.error(`\n[audit] error on ${a.aniId} (${a.title}): ${e?.message || e}`);
      done++;
    }
  }
}

// Belt-and-braces: an unhandled rejection should be logged, not fatal.
process.on("unhandledRejection", (e) => {
  console.error(`\n[audit] unhandledRejection: ${e?.message || e}`);
});
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
