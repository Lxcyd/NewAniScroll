// Compare two full player-audit JSON files and report what the latest fix
// changed. Usage:
//   node scripts/compare-audits.mjs <before.json> <after.json>
//
// Focuses on the actionable verdicts (wrong-season, episode-count-low) and the
// new merged-panel resolution, ignoring the structural missing-player noise.
import fs from "node:fs";

const [, , beforePath, afterPath] = process.argv;
if (!beforePath || !afterPath) {
  console.error("Usage: node scripts/compare-audits.mjs <before.json> <after.json>");
  process.exit(1);
}
const before = JSON.parse(fs.readFileSync(beforePath, "utf8"));
const after = JSON.parse(fs.readFileSync(afterPath, "utf8"));

// Per-anime worst actionable verdict (wrong-season > episode-count-low > else).
const RANK = { "wrong-season": 3, "episode-count-low": 2, "missing-player": 1 };
function indexByAni(arr) {
  const m = new Map();
  for (const r of arr) {
    const types = new Set((r.issues || []).map((i) => i.type));
    const merged = (r.issues || r.details || []).some((i) => i.merged);
    m.set(r.aniId, { title: r.title, types, merged, r });
  }
  return m;
}
const B = indexByAni(before);
const A = indexByAni(after);

function tallyType(arr, type) {
  const ids = new Set();
  for (const r of arr) for (const i of r.issues || []) if (i.type === type) ids.add(r.aniId);
  return ids;
}
const wsBefore = tallyType(before, "wrong-season");
const wsAfter = tallyType(after, "wrong-season");
const eclBefore = tallyType(before, "episode-count-low");
const eclAfter = tallyType(after, "episode-count-low");

console.log("=== wrong-season (unique anime) ===");
console.log(`  before: ${wsBefore.size}   after: ${wsAfter.size}   Δ ${wsAfter.size - wsBefore.size}`);
const wsFixed = [...wsBefore].filter((id) => !wsAfter.has(id));
const wsNew = [...wsAfter].filter((id) => !wsBefore.has(id));
console.log(`  fixed (was wrong-season, now clean): ${wsFixed.length}`);
for (const id of wsFixed) {
  const a = A.get(id);
  const mergedNote = a?.merged ? " [merged-panel offset]" : "";
  console.log(`    ✓ [${id}] ${a?.title || "?"}${mergedNote}`);
}
if (wsNew.length) {
  console.log(`  NEW wrong-season (regression watch): ${wsNew.length}`);
  for (const id of wsNew) console.log(`    ✗ [${id}] ${A.get(id)?.title || "?"}`);
}

console.log("\n=== episode-count-low (unique anime) ===");
console.log(`  before: ${eclBefore.size}   after: ${eclAfter.size}   Δ ${eclAfter.size - eclBefore.size}`);
const eclFixed = [...eclBefore].filter((id) => !eclAfter.has(id));
console.log(`  resolved: ${eclFixed.length}`);

// Count merged-panel resolutions in the after set.
let mergedCount = 0;
const mergedIds = [];
for (const r of after) {
  if ((r.issues || r.details || []).some((i) => i.merged)) {
    mergedCount++;
    mergedIds.push(`[${r.aniId}] ${r.title}`);
  }
}
console.log(`\n=== merged-panel offset applied: ${mergedCount} anime ===`);
for (const m of mergedIds.slice(0, 40)) console.log(`    • ${m}`);
