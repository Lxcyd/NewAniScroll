/**
 * Le point de reprise ne recule pas et ne se re-date pas sans lecture
 * (lib/watch/progress.ts). Cas du 24/11/2026 : Ramparts of Ice S2 ép. 4 remis
 * à 15 s, ép. 8 re-daté par un onglet rouvert puis remis à zéro.
 *
 *   node scripts/check-progress.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(join(ROOT, "package.json"))("typescript");
const src = readFileSync(join(ROOT, "lib", "watch", "progress.ts"), "utf8").replace(
  /import \{ touchHistory \} from "\.\.\/profile\/history";/,
  "const touchHistory = () => {};",
);
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;

// Faux navigateur, horloge pilotée.
let now = Date.UTC(2026, 10, 24, 0, 0, 0);
Date.now = () => now;
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
globalThis.window = { dispatchEvent() {} };
globalThis.CustomEvent = class { constructor(t, o) { this.detail = o?.detail; } };

const load = async () => import("data:text/javascript;base64," + Buffer.from(js + `\n//${Math.random()}`).toString("base64"));
let fails = 0;
const check = (name, ok, detail) => {
  if (!ok) {
    fails++;
    console.error(`ÉCHEC ${name}`, detail ?? "");
  }
};
const entry = () => JSON.parse(store.get("aniscroll:progress") || "{}")["213805:8"];

// Point de reprise de départ : ép. 8 à 1354 s sur 1524, 1042 s vues.
const base = { time: 1354, duration: 1524, updatedAt: now, watched: 1042 };
const reset = () => store.set("aniscroll:progress", JSON.stringify({ "213805:8": { ...base } }));

{
  // 1. Onglet rouvert : la reprise replace la vidéo, rien n'est lu.
  reset();
  const p = await load();
  now += 8 * 3_600_000;
  p.saveProgress(213805, 8, 1354, 1524);
  now += 3000;
  p.saveProgress(213805, 8, 1354, 1524);
  check("onglet rouvert : pas re-daté", entry().updatedAt === base.updatedAt, entry());
}
{
  // 2. Reprise ratée : la lecture part de 0, une seconde, pause.
  reset();
  const p = await load();
  p.saveProgress(213805, 8, 0, 1524);
  now += 3000;
  p.saveProgress(213805, 8, 1, 1524);
  now += 6000;
  p.saveProgress(213805, 8, 6, 1524);
  now += 9000;
  p.saveProgress(213805, 8, 15, 1524);
  check("reprise ratée : le point de reprise tient", entry().time === 1354, entry());
}
{
  // 3. Reprise réussie, on regarde : la position avance et se date.
  reset();
  const p = await load();
  p.saveProgress(213805, 8, 1354, 1524);
  for (let t = 1357; t <= 1420; t += 3) {
    now += 3000;
    p.saveProgress(213805, 8, t, 1524);
  }
  check("lecture réelle : la position avance", entry().time >= 1417 && entry().updatedAt === now, entry());
}
{
  // 4. On revient exprès au début et on regarde plus d'une minute : ça s'écrit.
  reset();
  const p = await load();
  p.saveProgress(213805, 8, 0, 1524);
  for (let t = 3; t <= 90; t += 3) {
    now += 3000;
    p.saveProgress(213805, 8, t, 1524);
  }
  check("revoir depuis le début une minute : ça s'écrit", entry().time >= 60 && entry().time < 100, entry());
}
{
  // 5. Lien horodaté atteint : il fixe le point de reprise sans lecture.
  reset();
  const p = await load();
  p.saveProgress(213805, 8, 300, 1524, { force: true });
  check("lien horodaté : écrit", entry().time === 300, entry());
}
{
  // 6. Premier épisode jamais vu : rien avant une minute, puis ça s'écrit.
  store.set("aniscroll:progress", "{}");
  const p = await load();
  p.saveProgress(213805, 8, 0, 1524);
  for (let t = 3; t <= 30; t += 3) {
    now += 3000;
    p.saveProgress(213805, 8, t, 1524);
  }
  check("nouvel épisode : rien sous une minute", entry() === undefined, entry());
  for (let t = 33; t <= 75; t += 3) {
    now += 3000;
    p.saveProgress(213805, 8, t, 1524);
  }
  check("nouvel épisode : écrit après une minute", entry()?.time >= 70, entry());
}

if (fails) {
  console.error(`${fails} cas en échec`);
  process.exit(1);
}
console.log("7 cas passés — le point de reprise ne recule pas et ne se re-date pas sans lecture.");
