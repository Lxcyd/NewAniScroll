/**
 * Cross-check our empty OP/ED cells against the two crowdsourced providers.
 *
 * The question: our `expected_absent` field calls a cell "absence attendue"
 * when AnimeThemes maps no theme of that kind onto the episode — i.e. it says
 * finding nothing is CORRECT. Luc's objection is that AnimeThemes is
 * incomplete, so that verdict can absolve a real miss. Erased episode 1 has an
 * ending the catalogue does not list.
 *
 * This asks a source that does not depend on AnimeThemes at all. Every
 * "attendue" cell for which AniSkip or Anime-Skip HAS a timing is a theme the
 * catalogue ignores and our field would have whitewashed.
 *
 * READ-ONLY: no database write, no change to what the player is served.
 *
 * Both providers are crowdsourced, so a miss on their side proves NOTHING —
 * their coverage follows popularity and old titles are simply unsubmitted.
 * The result is a LOWER BOUND on the gap, never a ground truth.
 *
 * Usage: node tools/opening-detector/scratch/_crosscheck_skip.mjs [--limit=N]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(HERE, "../..");
const CACHE = join(HERE, "cache/skip-crosscheck");
const OUT = join(HERE, "out/crosscheck.jsonl");
const CONCURRENCY = 3;

const argLimit = Number(
  (process.argv.find((a) => a.startsWith("--limit=")) || "").split("=")[1] || 0,
);

// ── Load the providers ───────────────────────────────────────────────────────
// lib/skip/providers.ts is TypeScript and this is plain Node, so compile it
// once with the TypeScript already in the project. Importing a second, hand
// written copy of the calls is exactly what the extraction was meant to avoid:
// the copies drift, and the offline measurement stops describing what the
// player actually receives.
const BUILD = join(CACHE, "build");
const SRC = join(ROOT, "lib/skip/providers.ts");
const COMPILED = join(BUILD, "providers.js");
mkdirSync(BUILD, { recursive: true });
if (!existsSync(COMPILED) || statSync(COMPILED).mtimeMs < statSync(SRC).mtimeMs) {
  // Call the local tsc entry point with node directly. Spawning `npx.cmd`
  // needs a shell on Windows and fails with ENOENT from execFileSync.
  execFileSync(
    process.execPath,
    [join(ROOT, "node_modules/typescript/lib/tsc.js"),
     SRC, "--outDir", BUILD, "--module", "esnext", "--target", "es2020",
     "--moduleResolution", "bundler", "--skipLibCheck"],
    { cwd: ROOT, stdio: "inherit" },
  );
  // tsc emits .js; Node needs the ESM extension to honour `export`.
  const js = readFileSync(join(BUILD, "providers.js"), "utf8");
  writeFileSync(join(BUILD, "providers.mjs"), js, "utf8");
}
const { fetchFromAniSkip, fetchFromAnimeSkip } = await import(
  pathToFileURL(join(BUILD, "providers.mjs")).href
);

// ── Input ────────────────────────────────────────────────────────────────────
const cells = JSON.parse(readFileSync(join(HERE, "out/empty_cells.json"), "utf8"));

// One request per (anime, episode): neither provider knows about language, so
// the vostfr and vf rows of the same episode are the same question asked twice.
const pairs = new Map();
for (const c of cells) {
  const key = `${c.mal_id}:${c.episode}`;
  if (!pairs.has(key)) {
    pairs.set(key, {
      mal_id: c.mal_id, anilist_id: c.anilist_id, slug: c.slug,
      episode: c.episode, episode_length: c.episode_length, cells: [],
    });
  }
  const p = pairs.get(key);
  p.cells.push(c);
  // Keep the longest duration seen — AniSkip rejects a 0 and a VF panel
  // sometimes probes shorter than its VOSTFR twin.
  p.episode_length = Math.max(p.episode_length, c.episode_length || 0);
}
let work = [...pairs.values()];
if (argLimit > 0) work = work.slice(0, argLimit);

// ── Fetch, cached on disk ────────────────────────────────────────────────────
mkdirSync(CACHE, { recursive: true });

async function lookup(p) {
  const cacheFile = join(CACHE, `${p.mal_id}_${p.episode}.json`);
  if (existsSync(cacheFile)) {
    try { return JSON.parse(readFileSync(cacheFile, "utf8")); } catch { /* refetch */ }
  }
  const [aniskip, animeskip] = await Promise.all([
    fetchFromAniSkip(p.mal_id, p.episode, p.episode_length)
      .catch((e) => ({ error: String(e?.message || e) })),
    p.anilist_id
      ? fetchFromAnimeSkip(p.anilist_id, p.episode)
          .catch((e) => ({ error: String(e?.message || e) }))
      : Promise.resolve([]),
  ]);
  const rec = {
    aniskip: Array.isArray(aniskip) ? aniskip : [],
    animeskip: Array.isArray(animeskip) ? animeskip : [],
    errors: [aniskip, animeskip].filter((x) => x && x.error).map((x) => x.error),
  };
  writeFileSync(cacheFile, JSON.stringify(rec), "utf8");
  return rec;
}

const results = new Map();
let done = 0;
async function worker(queue) {
  for (;;) {
    const p = queue.shift();
    if (!p) return;
    results.set(`${p.mal_id}:${p.episode}`, await lookup(p));
    if (++done % 25 === 0) process.stderr.write(`  ${done}/${work.length}\n`);
  }
}
const queue = [...work];
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

// ── Control case, printed first ──────────────────────────────────────────────
const erased = results.get("31043:1");
console.log("=== CAS TEMOIN — Erased (mal 31043) episode 1 ===");
if (!erased) {
  console.log("  pas dans le lot des cellules vides");
} else {
  console.log(`  AniSkip    : ${JSON.stringify(erased.aniskip)}`);
  console.log(`  Anime-Skip : ${JSON.stringify(erased.animeskip)}`);
  const hasEd = [...erased.aniskip, ...erased.animeskip].some((s) => s.type === "ed");
  console.log(hasEd
    ? "  -> un tiers CONFIRME un ED sur l'episode 1 : AnimeThemes est incomplet"
    : "  -> aucun tiers n'a d'ED ici (silence, pas un desaccord : sources crowdsourcees)");
}

// ── Cross-tab ────────────────────────────────────────────────────────────────
const tab = new Map();
const lines = [];
for (const c of cells) {
  const r = results.get(`${c.mal_id}:${c.episode}`);
  if (!r) continue;
  const third = [...r.aniskip, ...r.animeskip].filter((s) => s.type === c.kind);
  const found = third.length > 0;
  const key = `${c.verdict}|${found}`;
  tab.set(key, (tab.get(key) || 0) + 1);
  lines.push(JSON.stringify({ ...c, third_party: third, third_party_found: found }));
}
writeFileSync(OUT, lines.join("\n") + "\n", "utf8");

console.log("\n=== NOS CELLULES VIDES x SOURCES TIERCES ===");
console.log(`${"notre verdict".padEnd(14)}${"tiers A un timing".padStart(19)}${"tiers muet".padStart(13)}`);
for (const v of ["attendue", "lacune", "indecidable"]) {
  const yes = tab.get(`${v}|true`) || 0;
  const no = tab.get(`${v}|false`) || 0;
  const flag = v === "attendue" && yes > 0 ? "   <-- absences fabriquees" : "";
  console.log(`${v.padEnd(14)}${String(yes).padStart(19)}${String(no).padStart(13)}${flag}`);
}
const contaminated = tab.get("attendue|true") || 0;
const totalAttendue = contaminated + (tab.get("attendue|false") || 0);
if (totalAttendue) {
  console.log(
    `\n=> ${contaminated}/${totalAttendue} des "absences attendues" `
    + `(${Math.round((100 * contaminated) / totalAttendue)}%) sont contredites par un tiers.`,
  );
  console.log("   BORNE INFERIEURE : ces sources sont crowdsourcees, leur silence ne prouve rien.");
}
const nErr = [...results.values()].filter((r) => r.errors?.length).length;
if (nErr) console.log(`\n${nErr} paire(s) avec au moins une erreur de fournisseur.`);
console.log(`\n-> ${OUT}`);
