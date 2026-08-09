// Compare the original full audit against the targeted voir-anime punctuation
// recheck, to see how many former voir-anime missing-player anime now resolve
// after the slug fix (titleToSlugVariants + season ordering).
//
//   node scripts/audit/compare-punct-recheck.mjs scripts/out/player-audit-full.json scripts/out/punct-recheck.json
import fs from "node:fs";

const [, , beforePath, afterPath] = process.argv;
const before = JSON.parse(fs.readFileSync(beforePath, "utf8"));
const after = JSON.parse(fs.readFileSync(afterPath, "utf8"));

// In the BEFORE audit, which (id) had voir-anime missing-player on a given lang?
function voirMissingByLang(arr) {
  const m = new Map(); // id → Set(lang)
  for (const r of arr) {
    const langs = new Set();
    for (const i of r.issues || []) {
      if (i.source === "voiranime" && i.type === "missing-player") langs.add(i.lang);
    }
    if (langs.size) m.set(r.aniId, { title: r.title, langs });
  }
  return m;
}

// In the AFTER recheck, did voir-anime resolve (found, i.e. NOT in missing issues)?
function voirResolvedByLang(arr) {
  const m = new Map(); // id → { title, resolved:Set(lang), still:Set(lang) }
  for (const r of arr) {
    const resolved = new Set();
    const still = new Set();
    for (const d of r.details || r.issues || []) {
      if (d.source !== "voiranime") continue;
      if (d.type === "missing-player") still.add(d.lang);
      else resolved.add(d.lang); // ok / merged-cours / episode-count-low → a player WAS found
    }
    m.set(r.aniId, { title: r.title, resolved, still });
  }
  return m;
}

const B = voirMissingByLang(before);
const A = voirResolvedByLang(after);

let fixedLangs = 0;
let fixedAnime = 0;
let stillMissing = 0;
const fixedSamples = [];

for (const [id, b] of B) {
  const a = A.get(id);
  if (!a) continue; // not in recheck
  let anyFixed = false;
  for (const lang of b.langs) {
    if (a.resolved.has(lang)) {
      fixedLangs++;
      anyFixed = true;
    } else {
      stillMissing++;
    }
  }
  if (anyFixed) {
    fixedAnime++;
    if (fixedSamples.length < 40) {
      fixedSamples.push(`[${id}] ${a.title}  (now: ${[...a.resolved].join("+") || "—"})`);
    }
  }
}

console.log("=== voir-anime punctuation recheck ===");
console.log(`candidates re-checked: ${B.size}`);
console.log(`anime with ≥1 lang now FIXED: ${fixedAnime}`);
console.log(`  (lang-level fixes: ${fixedLangs}, still missing: ${stillMissing})`);
console.log(`\nfixed samples:`);
for (const s of fixedSamples) console.log(`  ✓ ${s}`);
