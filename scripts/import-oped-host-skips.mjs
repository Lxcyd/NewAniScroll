/**
 * Import the detector's PER-HOST JSONL into the oped_host_skips Turso table
 * (served by /api/v2/skip?server=…). ZERO worker calls, ZERO Upstash — batched
 * writes to Turso.
 *
 *   node --env-file=.env.local scripts/import-oped-host-skips.mjs \
 *        --in=tools/opening-detector/results.jsonl [--dry]
 *
 * Input: one line per (anime, episode, lang) with a `per_host` map — the
 * multi-host output of tools/opening-detector/batch_detect.py:
 *
 *   { "mal_id": 16498, "episode": 1, "lang": "vostfr",
 *     "per_host": {
 *       "sibnet":   { "duration": 1542, "algo_version": 1,
 *                     "op": { "start","end","votes","source","confirmed_by_video" },
 *                     "ed": { "start","end","from_end_start","from_end_end","votes" } },
 *       "megaplay": { "duration": 1555, "algo_version": 2, "op": { … } },
 *       "vidmoly-va": { "duration": 1542, "algo_version": 1 }   // processed, no hit
 *     } }
 *
 * We expand `per_host` into ONE DB row per host. A host present with no op/ed
 * still upserts a row (op/ed null): it records the host WAS processed at this
 * algo_version, which the batch's version-based resume needs so it doesn't
 * re-run it forever. Only servable intervals are stored (a held/low-confidence
 * one is dropped to null — precision-first).
 *
 * Displayed-hosts-only guarantee (the whole point of this table):
 *   - Any line whose `host` is not in lib/hostRegistry.js DISPLAYED_HOSTS is
 *     REJECTED (never written).
 *   - After writing, every row whose host is no longer displayed is PURGED —
 *     so dropping a server from lib/servers.js cleans up its rows next import.
 */
import fs from "node:fs";
import readline from "node:readline";
import { createClient } from "@libsql/client";
import { DISPLAYED_HOSTS } from "../lib/hostRegistry.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const IN = args.in || "tools/opening-detector/results.jsonl";
const DRY = !!args.dry;

if (!fs.existsSync(IN)) {
  console.error(`[import-host] input not found: ${IN}`);
  process.exit(1);
}

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS oped_host_skips (
  mal_id             INTEGER NOT NULL,
  episode            INTEGER NOT NULL,
  lang               TEXT    NOT NULL,
  host               TEXT    NOT NULL,
  op_start           REAL,
  op_end             REAL,
  op_votes           INTEGER,
  ed_start           REAL,
  ed_end             REAL,
  ed_from_end_start  REAL,
  ed_from_end_end    REAL,
  ed_votes           INTEGER,
  duration           REAL,
  source             TEXT    NOT NULL DEFAULT 'audio',
  confirmed_by_video INTEGER NOT NULL DEFAULT 0,
  algo_version       INTEGER NOT NULL DEFAULT 1,
  serve              INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (mal_id, episode, lang, host)
)`;

const allowed = new Set(DISPLAYED_HOSTS);
const now = Math.floor(Date.now() / 1000);

const servableIv = (h) =>
  h &&
  typeof h.start === "number" &&
  typeof h.end === "number" &&
  h.end > h.start &&
  h.serve !== false // a held / low-confidence interval is dropped (precision-first)
    ? h
    : null;

/** Expand one per-episode record into per-host rows. Returns { rows, rejected }. */
function rowsFromRecord(rec) {
  const malId = Number(rec.mal_id);
  const episode = Number(rec.episode);
  const lang = rec.lang || "vostfr";
  const perHost = rec.per_host;
  if (!malId || !episode || !perHost || typeof perHost !== "object") {
    return { rows: [], rejected: 0 };
  }
  const out = [];
  let rejected = 0;
  for (const [host, hd] of Object.entries(perHost)) {
    if (!allowed.has(host)) {
      rejected++;
      continue;
    }
    const op = servableIv(hd.op);
    const ed = servableIv(hd.ed);
    const serve = !!(op || ed);
    const confirmed =
      (op && op.confirmed_by_video === true) ||
      (ed && ed.confirmed_by_video === true);
    out.push({
      malId,
      episode,
      lang,
      host,
      opStart: op ? op.start : null,
      opEnd: op ? op.end : null,
      opVotes: op ? op.votes ?? null : null,
      edStart: ed ? ed.start : null,
      edEnd: ed ? ed.end : null,
      edFromEndStart: ed ? ed.from_end_start ?? null : null,
      edFromEndEnd: ed ? ed.from_end_end ?? null : null,
      edVotes: ed ? ed.votes ?? null : null,
      duration: hd.duration ?? null,
      source: (op || ed)?.source ?? "audio",
      confirmedByVideo: confirmed ? 1 : 0,
      algoVersion: Number(hd.algo_version ?? 1),
      serve: serve ? 1 : 0,
      updatedAt: now,
    });
  }
  return { rows: out, rejected };
}

const rows = [];
let lines = 0;
let bad = 0;
let rejected = 0;

const rl = readline.createInterface({
  input: fs.createReadStream(IN, "utf8"),
  crlfDelay: Infinity,
});
for await (const line of rl) {
  const s = line.trim();
  if (!s) continue;
  lines++;
  let rec;
  try {
    rec = JSON.parse(s);
  } catch {
    bad++;
    continue;
  }
  const r = rowsFromRecord(rec);
  rejected += r.rejected;
  if (r.rows.length === 0 && r.rejected === 0) bad++;
  rows.push(...r.rows);
}

const nServe = rows.filter((r) => r.serve === 1).length;
console.log(
  `[import-host] ${lines} lines, ${bad} unparseable, ${rejected} rejected ` +
    `(undisplayed host) → ${rows.length} rows (${nServe} servable, ` +
    `${rows.length - nServe} processed-empty). Allowlist: ${[...allowed].join(", ")}`,
);

if (DRY) {
  console.log("[import-host] --dry: not writing. Sample rows:");
  for (const r of rows.slice(0, 8)) console.log("  ", JSON.stringify(r));
  process.exit(0);
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

await db.execute(CREATE_SQL);

let written = 0;
for (let i = 0; i < rows.length; i += 100) {
  const chunk = rows.slice(i, i + 100);
  await db.batch(
    chunk.map((r) => ({
      sql: `INSERT INTO oped_host_skips
              (mal_id, episode, lang, host, op_start, op_end, op_votes,
               ed_start, ed_end, ed_from_end_start, ed_from_end_end, ed_votes,
               duration, source, confirmed_by_video, algo_version, serve, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(mal_id, episode, lang, host) DO UPDATE SET
              op_start = excluded.op_start,
              op_end = excluded.op_end,
              op_votes = excluded.op_votes,
              ed_start = excluded.ed_start,
              ed_end = excluded.ed_end,
              ed_from_end_start = excluded.ed_from_end_start,
              ed_from_end_end = excluded.ed_from_end_end,
              ed_votes = excluded.ed_votes,
              duration = excluded.duration,
              source = excluded.source,
              confirmed_by_video = excluded.confirmed_by_video,
              algo_version = excluded.algo_version,
              serve = excluded.serve,
              updated_at = excluded.updated_at`,
      args: [
        r.malId, r.episode, r.lang, r.host, r.opStart, r.opEnd, r.opVotes,
        r.edStart, r.edEnd, r.edFromEndStart, r.edFromEndEnd, r.edVotes,
        r.duration, r.source, r.confirmedByVideo, r.algoVersion, r.serve,
        r.updatedAt,
      ],
    })),
    "write",
  );
  written += chunk.length;
  process.stdout.write(`\r[import-host] written ${written}/${rows.length}`);
}
console.log(`\n[import-host] done — ${written} rows upserted into oped_host_skips`);

// Purge any host no longer displayed (server removed from lib/servers.js). The
// allowlist is small, so an explicit NOT IN (…) is fine.
const placeholders = DISPLAYED_HOSTS.map(() => "?").join(", ");
const del = await db.execute({
  sql: `DELETE FROM oped_host_skips WHERE host NOT IN (${placeholders})`,
  args: DISPLAYED_HOSTS,
});
console.log(
  `[import-host] purged ${Number(del.rowsAffected ?? 0)} row(s) for undisplayed hosts`,
);
