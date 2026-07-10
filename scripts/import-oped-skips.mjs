/**
 * Import the offline OP/ED detector's JSONL into the oped_skips Turso table,
 * which /api/v2/skip serves. ZERO worker calls, ZERO Upstash — one batched
 * write to Turso.
 *
 *   node --env-file=.env.local scripts/import-oped-skips.mjs \
 *        --in=tools/opening-detector/results.jsonl [--dry]
 *
 * Input: the JSONL emitted by tools/opening-detector/batch_detect.py (multi-host
 * path). One line per (anime, episode, lang):
 *
 *   { "mal_id": 16498, "episode": 3, "lang": "vostfr",
 *     "op": { "start", "end", "from_end_start", "from_end_end",
 *             "canonical_duration", "hosts_agree", "n_video_confirm",
 *             "source", "serve", ... } | null,
 *     "ed": { ... } | null }
 *
 * Precision-first: we STORE every produced row (serve 0 and 1 alike, for
 * inspection), but the `serve` flag the detector computed offline is what the
 * API filters on — a doubtful timing is stored-but-held, never served.
 *
 * Single-host lines (no `serve`/`hosts_agree`) are tolerated: `serve` then
 * derives from `confirmed_by_video` (audio+video agreed on one host). Lines
 * without a `lang` default to "vostfr".
 */
import fs from "node:fs";
import readline from "node:readline";
import { createClient } from "@libsql/client";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const IN = args.in || "tools/opening-detector/results.jsonl";
const DRY = !!args.dry;

if (!fs.existsSync(IN)) {
  console.error(`[import-oped] input not found: ${IN}`);
  process.exit(1);
}

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS oped_skips (
  mal_id             INTEGER NOT NULL,
  episode            INTEGER NOT NULL,
  lang               TEXT    NOT NULL,
  kind               TEXT    NOT NULL,
  start              REAL    NOT NULL,
  end                REAL    NOT NULL,
  from_end_start     REAL,
  from_end_end       REAL,
  canonical_duration REAL,
  n_hosts_agree      INTEGER NOT NULL DEFAULT 0,
  n_video_confirm    INTEGER NOT NULL DEFAULT 0,
  source             TEXT    NOT NULL DEFAULT 'audio',
  serve              INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (mal_id, episode, lang, kind)
)`;

/** Turn one { start, end, ... } theme object into a table row, or null when the
 *  interval is missing/degenerate. `serve` mirrors the detector's own gate. */
function toRow(malId, episode, lang, kind, h, now) {
  if (!h || typeof h.start !== "number" || typeof h.end !== "number") return null;
  if (h.end <= h.start) return null;
  // Prefer the detector's explicit serve flag (multi-host). Fall back to the
  // single-host signal (video confirmed the audio) when it's absent.
  const serve =
    h.serve === true ||
    (h.serve === undefined && h.confirmed_by_video === true) ||
    (h.serve === undefined && (h.hosts_agree ?? 0) >= 2);
  return {
    malId,
    episode,
    lang,
    kind,
    start: h.start,
    end: h.end,
    fromEndStart: h.from_end_start ?? null,
    fromEndEnd: h.from_end_end ?? null,
    canonicalDuration: h.canonical_duration ?? null,
    nHostsAgree: h.hosts_agree ?? 0,
    nVideoConfirm: h.n_video_confirm ?? 0,
    source: h.source ?? "audio",
    serve: serve ? 1 : 0,
    updatedAt: now,
  };
}

const now = Math.floor(Date.now() / 1000);
const rows = [];
let lines = 0;
let bad = 0;

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
  const malId = Number(rec.mal_id);
  const episode = Number(rec.episode);
  const lang = rec.lang || "vostfr";
  if (!malId || !episode) {
    bad++;
    continue;
  }
  for (const kind of ["op", "ed"]) {
    const row = toRow(malId, episode, lang, kind, rec[kind], now);
    if (row) rows.push(row);
  }
}

const nServe = rows.filter((r) => r.serve === 1).length;
console.log(
  `[import-oped] ${lines} lines, ${bad} unparseable → ${rows.length} intervals ` +
    `(${nServe} servable, ${rows.length - nServe} held)`,
);

if (DRY) {
  console.log("[import-oped] --dry: not writing. Sample rows:");
  for (const r of rows.slice(0, 8)) console.log("  ", JSON.stringify(r));
  process.exit(0);
}

// Create the client only when we actually write, so --dry runs with no DB env.
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
      sql: `INSERT INTO oped_skips
              (mal_id, episode, lang, kind, start, end, from_end_start,
               from_end_end, canonical_duration, n_hosts_agree, n_video_confirm,
               source, serve, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(mal_id, episode, lang, kind) DO UPDATE SET
              start = excluded.start,
              end = excluded.end,
              from_end_start = excluded.from_end_start,
              from_end_end = excluded.from_end_end,
              canonical_duration = excluded.canonical_duration,
              n_hosts_agree = excluded.n_hosts_agree,
              n_video_confirm = excluded.n_video_confirm,
              source = excluded.source,
              serve = excluded.serve,
              updated_at = excluded.updated_at`,
      args: [
        r.malId, r.episode, r.lang, r.kind, r.start, r.end, r.fromEndStart,
        r.fromEndEnd, r.canonicalDuration, r.nHostsAgree, r.nVideoConfirm,
        r.source, r.serve, r.updatedAt,
      ],
    })),
    "write",
  );
  written += chunk.length;
  process.stdout.write(`\r[import-oped] written ${written}/${rows.length}`);
}
console.log(`\n[import-oped] done — ${written} intervals upserted into oped_skips`);
