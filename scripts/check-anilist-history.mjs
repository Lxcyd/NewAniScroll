/**
 * Une écriture automatique vers AniList ne réécrit jamais l'histoire
 * (lib/list/protectHistory.ts). Cas tirés du compte de Luc, abîmé par le site
 * avant le 24/11/2026.
 *
 *   node scripts/check-anilist-history.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(join(ROOT, "package.json"))("typescript");
const src = readFileSync(join(ROOT, "lib", "list", "protectHistory.ts"), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const { protectHistory } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

const d = (day, month, year) => ({ year, month, day });
let fails = 0;
const check = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) {
    fails++;
    console.error(`ÉCHEC ${name}\n  obtenu ${a}\n  voulu  ${b}`);
  }
};

// Promised Neverland : terminé le 29/04/2025, revu le 20/10/2026.
check(
  "un revisionnage ne remplace pas la date de début",
  protectHistory(
    { mediaId: 101759, progress: 1, status: "CURRENT", startedAt: d(20, 10, 2026) },
    { status: "COMPLETED", startedAt: d(29, 4, 2025), completedAt: d(29, 4, 2025) },
  ),
  { mediaId: 101759, progress: 1 },
);
// Frieren : commencé le 03/05/2024, test du 03/10/2026.
check(
  "une date de début existante reste",
  protectHistory({ mediaId: 154587, status: "CURRENT", startedAt: d(3, 10, 2026) }, { status: "PAUSED", startedAt: d(3, 5, 2024), completedAt: null }),
  { mediaId: 154587, status: "CURRENT" },
);
// Bleach : en pause, une date de fin le 21/06/2026.
check(
  "pas de date de fin sur un anime en pause",
  protectHistory({ mediaId: 269, completedAt: d(21, 6, 2026) }, { status: "PAUSED", startedAt: d(10, 11, 2024), completedAt: null }),
  { mediaId: 269 },
);
check(
  "pas de date de fin sur un anime en cours",
  protectHistory({ mediaId: 208044, progress: 9, completedAt: d(22, 8, 2026) }, { status: "CURRENT", startedAt: null, completedAt: null }),
  { mediaId: 208044, progress: 9 },
);
// Attack on Titan : terminé, revu en octobre.
check(
  "un Terminé n'est jamais rétrogradé",
  protectHistory({ mediaId: 16498, status: "CURRENT", progress: 3 }, { status: "COMPLETED", startedAt: d(29, 3, 2025), completedAt: d(7, 4, 2025) }),
  { mediaId: 16498, progress: 3 },
);
check(
  "la fin d'un revisionnage ne change pas la date de fin",
  protectHistory({ mediaId: 16498, status: "COMPLETED", completedAt: d(23, 10, 2026) }, { status: "REPEATING", startedAt: d(29, 3, 2025), completedAt: d(7, 4, 2025) }),
  { mediaId: 16498, status: "COMPLETED" },
);
// Black Torch : début le 02/09 après une fin le 22/07.
check(
  "une date de début après la date de fin n'est pas envoyée",
  protectHistory({ mediaId: 187538, startedAt: d(2, 9, 2026) }, { status: "COMPLETED", startedAt: null, completedAt: d(22, 7, 2026) }),
  { mediaId: 187538 },
);

// Ce qui doit continuer de marcher.
check(
  "premier épisode : En cours + date de début du jour",
  protectHistory({ mediaId: 1, status: "CURRENT", startedAt: d(24, 11, 2026), progress: 1 }, { status: "PLANNING", startedAt: null, completedAt: null }),
  { mediaId: 1, status: "CURRENT", startedAt: d(24, 11, 2026), progress: 1 },
);
check(
  "dernier épisode : Terminé + date de fin",
  protectHistory({ mediaId: 1, status: "COMPLETED", completedAt: d(24, 11, 2026), progress: 12 }, { status: "CURRENT", startedAt: d(1, 11, 2026), completedAt: null }),
  { mediaId: 1, status: "COMPLETED", completedAt: d(24, 11, 2026), progress: 12 },
);
check(
  "anime absent d'AniList : tout passe",
  protectHistory({ mediaId: 1, status: "CURRENT", startedAt: d(24, 11, 2026) }, null),
  { mediaId: 1, status: "CURRENT", startedAt: d(24, 11, 2026) },
);
check(
  "AniList illisible : aucune date envoyée",
  protectHistory({ mediaId: 1, status: "CURRENT", startedAt: d(24, 11, 2026), progress: 2 }, undefined),
  { mediaId: 1, status: "CURRENT", progress: 2 },
);
check(
  "mise en pause automatique d'un anime en cours",
  protectHistory({ mediaId: 1, status: "PAUSED" }, { status: "CURRENT", startedAt: d(1, 1, 2026), completedAt: null }),
  { mediaId: 1, status: "PAUSED" },
);

if (fails) {
  console.error(`${fails} cas en échec`);
  process.exit(1);
}
console.log("12 cas passés — les écritures automatiques ne réécrivent pas l'historique AniList.");
