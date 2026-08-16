// Restore `verified` player_map rows that exist in the seed reference but are
// MISSING from the live table.
//
//   node scripts/player-map/seed-player-map.mjs --dump=scripts/out/_seed-reference.json
//   node scripts/player-map/repair-purged-player-map.mjs             # report only
//   node scripts/player-map/repair-purged-player-map.mjs --apply     # restore them
//
// WHY THIS EXISTS. `audit-animesama-lang-panels.mjs` decided a language panel
// was dead from a single hand-built URL — `catalogue/<slug>/<seasonDir>/<lang>/
// episodes.js` — and deleted the row when it 404'd. That criterion is unsound:
// anime-sama serves some language panels by a path that template does not
// generate, so a 404 there proves nothing about the panel's existence. Measured
// on Vinland Saga: the constructed VF URL 404s while the app resolves and plays
// a genuine French track for the same anime.
//
// `heuristic` rows survive that mistake — the runtime rewrites them on the next
// resolution. `verified` rows do NOT: they come from the seed and nothing
// regenerates them, so a wrong delete is permanent until restored from here.
//
// The repair is deliberately one-directional. A key present in the live table
// but absent from the seed is left ALONE (it may be a legitimate later
// addition); only seed-known keys that have vanished are re-inserted.

import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const apply = process.argv.includes("--apply");
const REF = "scripts/out/_seed-reference.json";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const reference = JSON.parse(readFileSync(REF, "utf8"));
const live = (
  await db.execute("SELECT ani_id, source, lang, status FROM player_map")
).rows;

const liveKeys = new Map();
for (const r of live) liveKeys.set(`${r.ani_id}:${r.source}:${r.lang}`, String(r.status));

// A `saison…hs` panel is a hors-série / recap panneau. Those rows WERE deleted
// on purpose, by a separate and correct pass (scan-player-map-sidestory.mjs):
// they made the app serve recap episodes as if they were the main season. They
// are absent from the live table by design and must never be restored here —
// which is why this predicate exists rather than a blanket "missing => restore".
const isSideStory = (dir) => /hs$/i.test(dir || "");

const missing = [];
const sideStory = [];
const downgraded = [];
for (const x of reference) {
  const key = `${x.aniId}:${x.source}:${x.lang}`;
  const status = liveKeys.get(key);
  if (status === undefined) {
    (isSideStory(x.seasonDir) ? sideStory : missing).push(x);
  } else if (status !== "verified") {
    // Reported, never rewritten. Two different things land here and BOTH are
    // wrong to overwrite: `broken` rows were marked so by the runtime after a
    // real failure, and `heuristic` rows are runtime re-resolutions that are
    // newer than the audit snapshot this reference was built from.
    downgraded.push({ ...x, liveStatus: status });
  }
}

console.log(`reference: ${reference.length} seeded rows`);
console.log(`live:      ${live.length} rows`);
console.log(`\nTO RESTORE (verified row gone, not a side-story panel): ${missing.length}`);
for (const x of missing) {
  console.log(`  ani=${x.aniId} ${x.source}/${x.lang} ${x.slug}/${x.seasonDir ?? "-"}`);
}
console.log(`\nLEFT DELETED (side-story panels, purged on purpose): ${sideStory.length}`);
console.log(`LEFT ALONE   (now heuristic/broken, runtime owns them): ${downgraded.length}`);

if (!missing.length) {
  console.log("\nnothing to restore");
  process.exit(0);
}
if (!apply) {
  console.log("\n(report only — re-run with --apply to restore)");
  process.exit(0);
}

// Same TTL policy as the seed: a finished show's mapping is stable, a releasing
// one is re-checked sooner.
const now = Math.floor(Date.now() / 1000);
const ttl = (s) => (s === "RELEASING" ? 7 : 30) * 86400;

const toWrite = missing;
let written = 0;
for (let i = 0; i < toWrite.length; i += 100) {
  const chunk = toWrite.slice(i, i + 100);
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
              fail_count    = 0,
              note          = excluded.note,
              checked_at    = excluded.checked_at,
              expires_at    = excluded.expires_at`,
      args: [
        x.aniId, x.source, x.lang, x.slug, x.seasonDir, x.epOffset,
        x.episodeCount, x.confidence, "seed:restored-after-bad-purge",
        now, now + ttl(x.animeStatus),
      ],
    })),
  );
  written += chunk.length;
}
console.log(`\nrestored ${written} row(s)`);
