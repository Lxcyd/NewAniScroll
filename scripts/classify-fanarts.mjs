#!/usr/bin/env node
/**
 * Classify every row in `anime_fanarts` using the WD14 SwinV2 v3 tagger.
 *
 * Optimizations vs the previous version:
 *
 *  1. URL DEDUPLICATION
 *     ~52% of rows in our DB share a URL with another row (same fanart.tv
 *     image attached to several anime IDs — Danmachi has 8 sequels that
 *     point to the same TVDB id). We classify each unique URL ONCE and
 *     fan-out the result to every row sharing that URL.
 *
 *  2. SKIP TYPE
 *     `logo` and `disc` are pure typography / disc art. We mark them
 *     'safe-skipped' without inference. Saves ~22% of work.
 *
 *  3. CONCURRENCY
 *     N independent ONNX sessions run in parallel. WD14 SwinV2 is ~470 MB
 *     per session; on a 16 GB box with FP32 ViT model loaded, 8 sessions
 *     fit comfortably (~3.7 GB).
 *
 *  4. PIPELINED FETCH
 *     Each worker fetches the next image while running inference on the
 *     current one — the network and the CPU stop waiting for each other.
 *
 *  5. SIGINT graceful shutdown — finish in-flight batches, persist, exit.
 *
 *  6. TRANSIENT vs PERMANENT errors — same as before, retry up to 3x.
 *
 *  Threshold logic lives in lib/nsfw/wd14-classifier.mjs (already validated
 *  on a reference set: SnK→safe, Akame fanservice→suggestive, Danmachi
 *  nudity→nsfw).
 */

import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { readFile } from "fs/promises";
import os from "os";

// Bump our process priority right at startup. The classifier is CPU-bound
// for hours; without this it competes equally with browser tabs / IDE /
// background services and ends up ~10-20% slower than it could be.
//
// We use HIGH, never HIGHEST/REALTIME — those starve the OS and freeze the
// machine. On Windows this maps to "High" in Task Manager. On Linux/macOS
// it lowers `nice` to about -10 (still well above "real-time" range).
//
// Wrapped in try/catch because some platforms / sandboxes refuse the call.
try {
  os.setPriority(0, os.constants.priority.PRIORITY_HIGH);
  console.log(`→ Process priority set to HIGH (was ${os.getPriority()})`);
} catch (e) {
  console.warn(`⚠ Could not set priority HIGH: ${e.message}`);
}

const args = new Set(process.argv.slice(2));
const fetchArg = [...args].find((a) => a.startsWith("--fetch-concurrency="));
const inferArg = [...args].find((a) => a.startsWith("--infer-concurrency="));
const maxArg = [...args].find((a) => a.startsWith("--max="));
const RESET = args.has("--reset");

// Two distinct concurrency knobs:
//   • fetch concurrency: how many simultaneous HTTP requests to fanart.tv.
//     Empirically validated at 4 — going higher triggers their rate-limit
//     and tanks the throughput to 4 URL/s with timeouts.
//   • infer concurrency: how many ONNX sessions run in parallel. CPU-bound
//     so this is just "as many cores as we have". 4 sessions cover 4 cores
//     of the i7-1065G7 + leave headroom.
const FETCH_CONCURRENCY = fetchArg ? Number(fetchArg.split("=")[1]) : 4;
const INFER_CONCURRENCY = inferArg ? Number(inferArg.split("=")[1]) : 4;
const MAX = maxArg ? Number(maxArg.split("=")[1]) : Infinity;

const MODEL_PATH = "./.cache/models/wd-swinv2-v3.onnx";
const TAGS_CSV_PATH = "./.cache/models/wd-swinv2-v3-tags.csv";
const IMG_SIZE = 448;

const FETCH_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
// Larger batches reduce DB round-trips. Each batch does one SELECT (with
// the new composite index this is cheap) + one batched UPDATE. Bigger
// batch = fewer queries = fewer Turso reads. 500 is a sweet spot — small
// enough that a SIGINT doesn't lose much, big enough to amortize the
// index lookup.
const BATCH_SIZE = 500;

const SKIP_TYPES = new Set(["logo", "disc"]);

// ─── Tag rule lists (mirror lib/nsfw/wd14-classifier.mjs) ──────────────────
const HARD_BLACKLIST = [
  "nude", "nipples", "pussy", "penis", "anus",
  "cum", "cum_on_body", "cum_on_face",
  "sex", "vaginal", "anal", "oral", "fellatio", "cunnilingus",
  "yaoi", "yuri",
  "rape", "bdsm", "bondage",
  "futanari", "spread_legs",
  "ejaculation", "masturbation",
];
const HARD_BLACKLIST_THRESHOLD = 0.3;

const FEMALE_NSFW = ["topless", "bottomless", "partially_nude", "see_through", "wet_clothes"];
const FEMALE_NSFW_THRESHOLD = 0.4;

const FEMALE_SUGGESTIVE = [
  "bikini", "swimsuit", "lingerie", "underwear",
  "bra", "panties", "thong",
  "cleavage", "large_breasts",
  "ass_focus", "ass_visible_through_thighs",
  "revealing_clothes", "midriff",
  "underboob", "sideboob", "downblouse", "downpants",
  "skindentation", "thigh_gap",
  "pelvic_curtain", "groin",
];
const FEMALE_SUGGESTIVE_THRESHOLD = 0.4;

const FEMALE_GENERIC_BODY = ["breasts", "huge_breasts", "medium_breasts"];
const FEMALE_GENERIC_BODY_THRESHOLD = 0.75;

const FEMALE_PRESENCE_TAGS = ["1girl", "multiple_girls", "2girls", "female_focus"];
const FEMALE_PRESENCE_THRESHOLD = 0.4;

const RATING_TAGS = ["general", "sensitive", "questionable", "explicit"];

const PERMANENT_HTTP_CODES = new Set([404, 410]);
function isPermanentError(err) {
  if (err?.permanent) return true;
  if (err?.httpStatus && PERMANENT_HTTP_CODES.has(err.httpStatus)) return true;
  const msg = String(err?.message || "");
  if (/decoder|VipsJpeg|VipsPng|Input image|unsupported image|truncated/i.test(msg)) return true;
  return false;
}

const rawDb = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Wrapper around the libsql client that retries any operation if the
// network drops or DNS hiccups (e.g. user's connection blinks at 3am).
// Without this, ENOTFOUND or ECONNRESET kills the whole run after many
// hours of work — and we'd lose nothing data-wise (the script is
// resumable) but it'd waste hours of progress next time we relaunch.
//
// Errors that look transient (network / 5xx / timeout) are retried with
// exponential backoff. Anything else (programming errors, bad SQL, etc.)
// is rethrown immediately so we don't loop on a real bug.
function isTransientDbError(err) {
  const msg = String(err?.message || "");
  const causeMsg = String(err?.cause?.message || err?.cause?.code || "");
  const both = msg + " " + causeMsg;
  return /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EHOSTUNREACH|fetch failed|socket hang up|HTTP 5\d\d|timeout/i.test(both);
}

async function withRetry(fn, label) {
  const MAX_ATTEMPTS = 8; // 1 + 7 retries — covers ~5min of network outage
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await fn();
    } catch (e) {
      if (!isTransientDbError(e) || attempt >= MAX_ATTEMPTS) throw e;
      const wait = Math.min(60_000, 2000 * Math.pow(2, attempt - 1)); // 2s, 4s, 8s, 16s, 32s, 60s, 60s
      console.warn(`⚠ DB ${label} failed (${e.cause?.code || e.message?.slice(0, 60)}), retry ${attempt}/${MAX_ATTEMPTS} in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// Drop-in replacements that add retry to every DB call.
const db = {
  execute: (q) => withRetry(() => rawDb.execute(q), "execute"),
  batch:   (ops) => withRetry(() => rawDb.batch(ops), "batch"),
};

// ─── SIGINT ────────────────────────────────────────────────────────────────
let shuttingDown = false;
process.on("SIGINT", () => {
  if (shuttingDown) return console.log("\n→ Already shutting down");
  shuttingDown = true;
  console.log("\n→ SIGINT — finishing in-flight batch then exiting…");
});

// Catch unhandled rejections so a stray promise error doesn't silently kill
// the whole process (which is what happened on the 8-session run).
process.on("unhandledRejection", (reason) => {
  console.error("⚠ Unhandled rejection:", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("⚠ Uncaught exception:", err?.message || err);
  // Don't exit — let the in-flight batch finish if possible.
});

// ─── Sessions + tags ───────────────────────────────────────────────────────
// On Windows + i7-1065G7, multi-session scaling was broken: 8 sessions ran
// at the same speed as 1. The bottleneck is intra-op parallelism inside a
// single session. Empirically validated config:
//   • 1 ONNX session
//   • intraOpNumThreads = 4  (use all 4 physical cores for the matmul)
//   • interOpNumThreads = 1
// → 0.59 inf/s vs 0.31 with 8 separate sessions.
async function buildSessions(n) {
  console.log(`→ Loading 1 ONNX session with 4 intra-op threads…`);
  const buf = await readFile(MODEL_PATH);
  const s = await ort.InferenceSession.create(buf, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
    intraOpNumThreads: 4,
    interOpNumThreads: 1,
  });
  console.log(`  ✓ ready`);
  // Caller still expects an array — return one session repeated `n` times.
  // All "infer workers" share the same session object, but ONNX serializes
  // calls on a single session anyway, so no contention.
  return [s];
}

async function loadTagNames() {
  const text = await readFile(TAGS_CSV_PATH, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const names = [];
  for (let i = 1; i < lines.length; i++) {
    names.push(lines[i].split(",")[1]);
  }
  return names;
}

// ─── Preprocess ────────────────────────────────────────────────────────────
async function preprocess(buf) {
  const { data, info } = await sharp(buf)
    .resize(IMG_SIZE, IMG_SIZE, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`channels=${info.channels}`);
  const np = IMG_SIZE * IMG_SIZE;
  const out = new Float32Array(np * 3);
  for (let i = 0; i < np; i++) {
    out[i * 3]     = data[i * 3 + 2]; // B
    out[i * 3 + 1] = data[i * 3 + 1]; // G
    out[i * 3 + 2] = data[i * 3];     // R
  }
  return new ort.Tensor("float32", out, [1, IMG_SIZE, IMG_SIZE, 3]);
}

// ─── Decision ──────────────────────────────────────────────────────────────
function tagScore(s, n) { return s.get(n) ?? 0; }
function anyAbove(s, names, t) {
  for (const n of names) if (tagScore(s, n) >= t) return n;
  return null;
}

function decide(scoresByName) {
  const blackHit = anyAbove(scoresByName, HARD_BLACKLIST, HARD_BLACKLIST_THRESHOLD);
  if (blackHit) {
    return { label: "nsfw", score: tagScore(scoresByName, blackHit), reason: `hard:${blackHit}` };
  }

  let topRating = { tag: "general", score: 0 };
  for (const r of RATING_TAGS) {
    const s = tagScore(scoresByName, r);
    if (s > topRating.score) topRating = { tag: r, score: s };
  }

  const femalePresent = anyAbove(scoresByName, FEMALE_PRESENCE_TAGS, FEMALE_PRESENCE_THRESHOLD);

  if (femalePresent) {
    const fNsfw = anyAbove(scoresByName, FEMALE_NSFW, FEMALE_NSFW_THRESHOLD);
    if (fNsfw) return { label: "nsfw", score: tagScore(scoresByName, fNsfw), reason: `female-nsfw:${fNsfw}` };

    const fSugg = anyAbove(scoresByName, FEMALE_SUGGESTIVE, FEMALE_SUGGESTIVE_THRESHOLD);
    if (fSugg) return { label: "suggestive", score: tagScore(scoresByName, fSugg), reason: `female-sugg:${fSugg}` };

    const fBody = anyAbove(scoresByName, FEMALE_GENERIC_BODY, FEMALE_GENERIC_BODY_THRESHOLD);
    if (fBody) return { label: "suggestive", score: tagScore(scoresByName, fBody), reason: `female-body:${fBody}` };
  }

  if (topRating.tag === "explicit" && topRating.score >= 0.4) {
    return { label: "nsfw", score: topRating.score, reason: "rating:explicit" };
  }
  if (topRating.tag === "questionable" && topRating.score >= 0.4) {
    return { label: "nsfw", score: topRating.score, reason: "rating:questionable" };
  }
  return { label: "safe", score: topRating.score, reason: "default" };
}

// ─── Pipeline stages ───────────────────────────────────────────────────────
// We split fetch and inference into independent worker pools. Fetch workers
// fill a bounded queue with decoded tensors; inference workers consume them.
// This way the CPU never idles during HTTP latency, and we cap fetch
// concurrency at 4 (sweet spot for fanart.tv).

async function fetchAndPreprocess(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status}`);
      e.httpStatus = res.status;
      throw e;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return await preprocess(buf);
  } finally {
    clearTimeout(timer);
  }
}

async function runInference(session, tagNames, tensor) {
  const inputName = session.inputNames[0];
  const result = await session.run({ [inputName]: tensor });
  const probs = result[session.outputNames[0]].data;

  const scoresByName = new Map();
  for (let i = 0; i < tagNames.length; i++) {
    if (probs[i] >= 0.1) scoresByName.set(tagNames[i], probs[i]);
  }
  const verdict = decide(scoresByName);
  return {
    label: verdict.label,
    score: verdict.score,
    safe: 1 - verdict.score,
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  if (RESET) {
    console.log("→ --reset: clearing IA classification (manual-* preserved)");
    const r = await db.execute(`
      UPDATE anime_fanarts SET
        classified_at = NULL,
        classification_attempts = 0,
        nsfw_safe = NULL,
        nsfw_score = NULL,
        nsfw_label = NULL
      WHERE nsfw_label IS NULL OR nsfw_label NOT LIKE 'manual-%'
    `);
    console.log(`  ✓ cleared ${r.rowsAffected} row(s)`);
  }

  // Mark logo/disc rows as safe-skipped in one shot
  const skipNow = Math.floor(Date.now() / 1000);
  const skip = await db.execute({
    sql: `UPDATE anime_fanarts SET nsfw_label = 'safe-skipped', classified_at = ?
           WHERE nsfw_label IS NULL AND type IN ('logo', 'disc')`,
    args: [skipNow],
  });
  if (skip.rowsAffected > 0) {
    console.log(`→ Marked ${skip.rowsAffected} logo/disc rows as 'safe-skipped'`);
  }

  const sessions = await buildSessions(INFER_CONCURRENCY);
  const tagNames = await loadTagNames();
  console.log(`  ✓ ${tagNames.length} tags loaded`);
  const INFER_WORKERS = 1;
  console.log(`  ✓ pipeline: ${FETCH_CONCURRENCY} fetch × ${INFER_WORKERS} infer (4 threads)`);

  // Compute the TOTAL number of unique URLs to classify ONCE, up front.
  // This was previously re-queried after every batch — that single SELECT
  // alone was scanning 122k rows × hundreds of batches = millions of
  // wasted Turso reads. Now we just decrement the local counter.
  console.log("→ Counting unique URLs to classify…");
  const totalRow = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM (
            SELECT url FROM anime_fanarts
             WHERE nsfw_label IS NULL
               AND classification_attempts < ?
               AND type NOT IN ('logo','disc')
             GROUP BY url
          )`,
    args: [MAX_ATTEMPTS],
  });
  const TOTAL_URLS = Number(totalRow.rows[0].n);
  console.log(`  ✓ ${TOTAL_URLS} unique URLs to classify`);

  const t0 = Date.now();
  let urlsProcessed = 0, rowsAffected = 0;
  let safeN = 0, suggN = 0, nsfwN = 0, permErrN = 0, transErrN = 0;

  while (urlsProcessed < MAX && !shuttingDown) {
    const r = await db.execute({
      sql: `SELECT url, MIN(id) AS rep_id, COUNT(*) AS n_rows
              FROM anime_fanarts
             WHERE nsfw_label IS NULL
               AND classification_attempts < ?
               AND type NOT IN ('logo', 'disc')
             GROUP BY url
             ORDER BY MIN(id)
             LIMIT ?`,
      args: [MAX_ATTEMPTS, BATCH_SIZE],
    });
    if (r.rows.length === 0) {
      console.log("→ Nothing left to classify");
      break;
    }

    // ── Pipeline ──
    // Fetch workers pull URLs from urlQueue, fetch+decode, push the result
    // (success: tensor; failure: error) onto inferQueue. Infer workers pull
    // from inferQueue and run the model. When urlQueue is empty AND all
    // fetches are done, we close the channel by pushing N sentinels.
    const urlQueue = [...r.rows];
    const inferQueue = [];   // [{ url, tensor? , error? , permanent? }]
    const results = [];
    let inferWaiters = []; // resolvers waiting for next inferQueue item

    function pushInfer(item) {
      inferQueue.push(item);
      const w = inferWaiters.shift();
      if (w) w();
    }
    async function nextInfer() {
      if (inferQueue.length > 0) return inferQueue.shift();
      await new Promise((res) => inferWaiters.push(res));
      return inferQueue.shift();
    }

    let activeFetchers = FETCH_CONCURRENCY;

    async function fetchWorker() {
      while (urlQueue.length > 0 && !shuttingDown) {
        const row = urlQueue.shift();
        if (!row) break;
        const url = String(row.url);
        try {
          const tensor = await fetchAndPreprocess(url);
          pushInfer({ url, tensor });
        } catch (e) {
          pushInfer({ url, error: e, permanent: isPermanentError(e) });
        }
      }
      // Last fetcher to leave wakes up the inference workers with sentinels
      activeFetchers--;
      if (activeFetchers === 0) {
        for (let i = 0; i < INFER_WORKERS; i++) pushInfer(null);
      }
    }

    async function inferWorker(idx) {
      while (!shuttingDown) {
        const item = await nextInfer();
        if (item == null) return; // sentinel
        const { url, tensor, error, permanent } = item;
        if (error) {
          results.push({ url, ok: false, error, permanent });
          continue;
        }
        try {
          const out = await runInference(sessions[idx], tagNames, tensor);
          results.push({ url, ok: true, ...out });
        } catch (e) {
          results.push({ url, ok: false, error: e, permanent: isPermanentError(e) });
        }
      }
    }

    await Promise.all([
      ...Array.from({ length: FETCH_CONCURRENCY }, () => fetchWorker()),
      ...Array.from({ length: INFER_WORKERS }, () => inferWorker(0)),
    ]);

    // Persist results — each URL update fans out to every row sharing it.
    const now = Math.floor(Date.now() / 1000);
    const ops = [];
    for (const res of results) {
      if (res.ok) {
        if (res.label === "safe") safeN++;
        else if (res.label === "suggestive") suggN++;
        else nsfwN++;
        ops.push({
          sql: `UPDATE anime_fanarts SET
                  nsfw_safe = ?, nsfw_score = ?,
                  nsfw_label = ?, classified_at = ?,
                  classification_attempts = classification_attempts + 1
                WHERE url = ? AND (nsfw_label IS NULL OR nsfw_label NOT LIKE 'manual-%')`,
          args: [res.safe, res.score, res.label, now, res.url],
        });
      } else if (res.permanent) {
        permErrN++;
        ops.push({
          sql: `UPDATE anime_fanarts SET
                  nsfw_label = 'error-perm',
                  classified_at = ?,
                  classification_attempts = classification_attempts + 1
                WHERE url = ? AND (nsfw_label IS NULL OR nsfw_label NOT LIKE 'manual-%')`,
          args: [now, res.url],
        });
      } else {
        transErrN++;
        ops.push({
          sql: `UPDATE anime_fanarts SET
                  classification_attempts = classification_attempts + 1,
                  nsfw_label = CASE
                    WHEN classification_attempts + 1 >= ? THEN 'error-perm'
                    ELSE nsfw_label
                  END,
                  classified_at = CASE
                    WHEN classification_attempts + 1 >= ? THEN ?
                    ELSE classified_at
                  END
                WHERE url = ? AND (nsfw_label IS NULL OR nsfw_label NOT LIKE 'manual-%')`,
          args: [MAX_ATTEMPTS, MAX_ATTEMPTS, now, res.url],
        });
      }
    }
    if (ops.length > 0) {
      const batchResults = await db.batch(ops);
      for (const br of batchResults) rowsAffected += br.rowsAffected || 0;
    }

    urlsProcessed += results.length;
    const elapsed = (Date.now() - t0) / 1000;
    const rate = urlsProcessed / elapsed;
    const remaining = Math.max(0, TOTAL_URLS - urlsProcessed);
    const pct = TOTAL_URLS > 0 ? ((urlsProcessed / TOTAL_URLS) * 100).toFixed(1) : "0.0";
    const eta = rate > 0 ? Math.round(remaining / rate) : null;

    console.log(
      `  ✓ ${urlsProcessed}/${TOTAL_URLS} (${pct}%) | ` +
      `safe=${safeN} sugg=${suggN} nsfw=${nsfwN} perm=${permErrN} trans=${transErrN} | ` +
      `${rate.toFixed(2)} URL/s` +
      (eta !== null ? ` | eta ${Math.floor(eta / 3600)}h${Math.floor((eta % 3600) / 60)}m` : "")
    );
  }

  const dt = Math.round((Date.now() - t0) / 1000);
  console.log(`\n${shuttingDown ? "⚠ Stopped" : "✓ Done"} — ${Math.floor(dt / 60)}m${dt % 60}s`);
  console.log(`  Unique URLs processed: ${urlsProcessed}`);
  console.log(`  Rows updated:          ${rowsAffected}`);
  console.log(`  Safe:        ${safeN}`);
  console.log(`  Suggestive:  ${suggN}`);
  console.log(`  NSFW:        ${nsfwN}`);
  console.log(`  Perm errs:   ${permErrN}`);
  console.log(`  Trans:       ${transErrN}`);
  process.exit(shuttingDown ? 130 : 0);
}

main().catch((e) => {
  console.error("\n✘ Crashed:", e);
  process.exit(1);
});
