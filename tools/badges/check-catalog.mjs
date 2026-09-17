/**
 * Le test du système de badges. `node tools/badges/check-catalog.mjs`
 *
 * Le projet n'a pas de runner de tests ; la convention locale est le script
 * auto-vérifiant — une table de cas, un verdict — sur le modèle de
 * tools/quota-guard/test-boucles.mjs. On la suit.
 *
 * Sans réseau. Deux moitiés :
 *   1. L'INTÉGRITÉ du catalogue : ids uniques, libellés présents dans les deux
 *      langues, icônes connues, échelles croissantes.
 *   2. LE COMPORTEMENT, sur des instantanés FABRIQUÉS. C'est là que se prouvent
 *      les cas d'heure locale de lib/badges/localtime.ts — minuit, la fenêtre
 *      nocturne qui traverse minuit, le changement d'heure, l'horloge fausse,
 *      la liste importée sans horodatage — parce qu'aucun d'eux n'est
 *      atteignable sur un profil de test réel.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/* Les modules à tester sont en TypeScript. Plutôt que d'ajouter un transpileur
   au projet, on les passe par le compilateur déjà présent (`typescript` est une
   devDependency, tsc sert à `npm run type-check`).

   Le résultat est écrit dans node_modules/.cache : il FAUT des vrais fichiers
   sur disque, et sous la racine du projet. Une data: URL ne sait pas résoudre
   un import relatif, et un dossier hors du dépôt ne trouverait pas `react` —
   Node remonte l'arborescence depuis le fichier pour chercher node_modules. */
const ts = (await import(pathToFileURL(join(ROOT, "node_modules", "typescript", "lib", "typescript.js")).href)).default;
const CACHE = join(ROOT, "node_modules", ".cache", "badges-check");

/** Les imports relatifs sans extension deviennent des `.mjs` du cache. */
function rewrite(src) {
  return src.replace(
    /(\bfrom\s*|\bimport\s*\(\s*)(["'])(\.\.?\/[^"']+)\2/g,
    (_, head, q, spec) => `${head}${q}${spec}.mjs${q}`,
  );
}

/** Le chemin sans son extension : la sortie du cache est toujours un .mjs. */
const bare = (rel) => rel.replace(/\.(tsx?|m?js)$/, "");

const compiled = new Set();
function compile(rel) {
  if (compiled.has(rel)) return;
  compiled.add(rel);
  const src = readFileSync(join(ROOT, rel), "utf8");
  const js = rel.endsWith(".ts")
    ? ts.transpileModule(src, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText
    : src;
  const out = join(CACHE, bare(rel)) + ".mjs";
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, rewrite(js));

  /* Et ses dépendances relatives, récursivement : l'extension d'origine est
     retrouvée sur disque (.ts ou .js — lib/hostRegistry.js en est un). */
  for (const m of js.matchAll(/\bfrom\s*["'](\.\.?\/[^"']+)["']/g)) {
    const base = resolve(dirname(join(ROOT, rel)), m[1]);
    for (const ext of [".ts", ".tsx", ".js", ".mjs"]) {
      if (existsSync(base + ext)) {
        compile(base.slice(ROOT.length + 1).replace(/\\/g, "/") + ext);
        break;
      }
    }
  }
}

const loaded = new Map();
async function load(rel) {
  if (loaded.has(rel)) return loaded.get(rel);
  compile(rel);
  const mod = await import(pathToFileURL(join(CACHE, bare(rel)) + ".mjs").href);
  loaded.set(rel, mod);
  return mod;
}

/* ── Le harnais ───────────────────────────────────────────────────────────── */

let pass = 0;
const failures = [];
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass += 1;
  else failures.push(`${label}\n      attendu ${JSON.stringify(want)}, obtenu ${JSON.stringify(got)}`);
}
function ok(label, cond) {
  check(label, !!cond, true);
}

/* ══ 1. Intégrité du catalogue ═════════════════════════════════════════════ */

const { CATALOG, LADDERS, FAMILIES } = await import("./catalog.data.mjs");
const fr = JSON.parse(readFileSync(join(ROOT, "locales", "fr.json"), "utf8"));
const en = JSON.parse(readFileSync(join(ROOT, "locales", "en.json"), "utf8"));

const all = Object.entries(CATALOG).flatMap(([family, rows]) =>
  rows.map((r) => ({ family, id: r[0], rarity: r[1], icon: r[2], tag: r[3], metric: r[4] })),
);

ok("ids uniques", new Set(all.map((b) => b.id)).size === all.length);
ok("101 badges principaux", all.filter((b) => b.family !== "secret").length === 101);
ok("familles connues", all.every((b) => FAMILIES.includes(b.family)));

for (const b of all) {
  ok(`fr.badges.${b.id}.name`, typeof fr.badges?.[b.id]?.name === "string" && fr.badges[b.id].name);
  ok(`fr.badges.${b.id}.cond`, typeof fr.badges?.[b.id]?.cond === "string" && fr.badges[b.id].cond);
  ok(`en.badges.${b.id}.name`, typeof en.badges?.[b.id]?.name === "string" && en.badges[b.id].name);
  ok(`en.badges.${b.id}.cond`, typeof en.badges?.[b.id]?.cond === "string" && en.badges[b.id].cond);
}
ok(
  "aucun libellé orphelin",
  Object.keys(fr.badges ?? {}).filter((k) => k !== "ui").every((k) => all.some((b) => b.id === k)),
);

const iconSrc = readFileSync(join(ROOT, "lib", "badges", "icons.ts"), "utf8");
const iconKeys = new Set(
  [...iconSrc.slice(iconSrc.indexOf("BADGE_ICONS")).matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]),
);
for (const b of all) ok(`icône ${b.icon} (${b.id})`, iconKeys.has(b.icon));

for (const [name, ids] of Object.entries(LADDERS)) {
  let prev = -Infinity;
  for (const id of ids) {
    const b = all.find((x) => x.id === id);
    ok(`échelle ${name} contient ${id}`, !!b);
    if (b) {
      ok(`échelle ${name} : ${id} > ${prev}`, b.metric.n > prev);
      prev = b.metric.n;
    }
  }
}

/* ══ 1 bis. Chaque geste a-t-il un point d'accroche ? ══════════════════════
   Un badge dont la metrique est un drapeau ou un compteur ne se debloque que si
   QUELQU'UN l'enregistre. Rien dans le catalogue ne le garantit, et un badge
   inerte ressemble exactement a un badge difficile — on ne s'en apercoit
   jamais. Cette passe balaie le code a la recherche de l'appel correspondant.

   Les lignes de COMMENTAIRE sont ecartees : un exemple dans une docstring a
   deja fait passer un compteur pour branche alors qu'il ne l'etait pas. Les
   exceptions connues sont listees, nommement, avec leur raison. */
{
  const { readdirSync, statSync } = await import("node:fs");
  const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(tsx?|jsx?|mjs)$/.test(name)) out.push(full);
    }
    return out;
  };

  let code = "";
  for (const dir of ["lib", "components", "pages"]) {
    for (const f of walk(join(ROOT, dir))) {
      /* Seul `facts.ts` est ecarte, et pas tout lib/badges : c'est lui qui
         DEFINIT `recordFlag`/`bumpCounter`, et ses exemples de documentation
         ont deja fait passer un compteur pour branche alors qu'il ne l'etait
         pas. `gestures.ts`, lui, est un appelant legitime — la sequence de
         touches et la console y sont enregistrees. */
      if (f.endsWith(join("lib", "badges", "facts.ts"))) continue;
      code += readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/)/.test(l))
        .join("\n");
    }
  }
  const called = new Set(
    [...code.matchAll(/(?:recordFlag|bumpCounter|bumpDistinct|dwell)\(\s*["']([A-Za-z0-9]+)["']/g)]
      .map((m) => m[1]),
  );
  if (/recordNoPause\(/.test(code)) called.add("noPause");
  if (/noteLang\(/.test(code)) called.add("bothLangs");

  /* Les badges qui attendent une fonctionnalite qui n'existe pas encore. Les
     laisser ici plutot que de faire echouer la passe est un choix : ils sont
     au catalogue, on sait qu'ils sont inertes, et le jour ou la
     fonctionnalite arrive c'est cette liste qu'on vient raccourcir. */
  const PENDING = new Map([
    ["random", "le site n'a pas de bouton « anime au hasard »"],
    ["pinMythic", "on ne peut pas encore epingler un badge sur son profil"],
  ]);

  for (const b of all) {
    const k = b.metric.k;
    if (k !== "flag" && k !== "counter") continue;
    const name = b.metric.name;
    if (PENDING.has(name)) continue;
    ok(`geste « ${name} » enregistre quelque part (${b.id})`, called.has(name));
  }
  const stale = [...PENDING.keys()].filter((n) => called.has(n));
  ok(
    `aucun geste en attente n'est en fait branche (${stale.join(", ") || "—"})`,
    stale.length === 0,
  );
  console.log(
    `  (${PENDING.size} badge(s) en attente d'une fonctionnalite : ` +
      [...PENDING].map(([n, why]) => `${n} — ${why}`).join(" ; ") + ")",
  );
}

/* ══ 2. Comportement ═══════════════════════════════════════════════════════ */

const { derive } = await load("lib/badges/derive.ts");
const { measure } = await load("lib/badges/measure.ts");
const { BY_ID } = await load("lib/badges/catalog.ts");
const lt = await load("lib/badges/localtime.ts");

const EMPTY_FACTS = {
  v: 1, flags: {}, counters: {}, hosts: [], noPause: [], opSkipped: [], bothLangs: [],
};

/** Un épisode terminé : `time >= duration - 30` est ce que lit `isCompleted`. */
const ep = (aniId, n, at, minutes = 24) => [
  `${aniId}:${n}`,
  { time: minutes * 60, duration: minutes * 60, updatedAt: at },
];

/** Une date LOCALE, pour que les cas d'heure ne dépendent pas du fuseau du CI. */
const local = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

function snap(over = {}) {
  return {
    progress: {}, list: {}, facts: EMPTY_FACTS, favourites: null, vocab: null,
    accountCreatedAt: null, displayedHosts: ["a", "b", "c"],
    now: local(2026, 9, 16, 12), ...over,
  };
}
const state = (got = {}) => ({ v: 1, got, backfilled: true });
const m = (id, s, st = state()) => measure(BY_ID[id], derive(s), st);

/* ── Les paliers : 9 épisodes montrent bien 9/10, pas 0/10 ─────────────────── */
{
  const progress = Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => ep(1, i + 1, local(2026, 9, 10, 20) + i * 1800_000)),
  );
  check("9 épisodes → ep-25 à 9/25", m("ep-25", snap({ progress })), [9, 25]);
  check("9 épisodes → ep-1 atteint", m("ep-1", snap({ progress })), [9, 1]);
}

/* ── Minuit pile : la MINUTE, pas la seconde ──────────────────────────────── */
check("00:00:30 donne minuit", m("midnight", snap({ progress: Object.fromEntries([ep(1, 1, local(2026, 9, 10, 0, 0))]) })), [1, 1]);
check("00:01 ne donne pas minuit", m("midnight", snap({ progress: Object.fromEntries([ep(1, 1, local(2026, 9, 10, 0, 1))]) })), [0, 1]);
check("23:59 ne donne pas minuit", m("midnight", snap({ progress: Object.fromEntries([ep(1, 1, local(2026, 9, 10, 23, 59))]) })), [0, 1]);

/* ── La fenêtre 2 h–5 h, bornes comprises/exclues ──────────────────────────── */
check("01:59 hors fenêtre nocturne", m("late-night", snap({ progress: Object.fromEntries([ep(1, 1, local(2026, 9, 10, 1, 59))]) })), [0, 1]);
check("02:00 dans la fenêtre", m("late-night", snap({ progress: Object.fromEntries([ep(1, 1, local(2026, 9, 10, 2, 0))]) })), [1, 1]);
check("04:59 dans la fenêtre", m("late-night", snap({ progress: Object.fromEntries([ep(1, 1, local(2026, 9, 10, 4, 59))]) })), [1, 1]);
check("05:00 hors fenêtre", m("late-night", snap({ progress: Object.fromEntries([ep(1, 1, local(2026, 9, 10, 5, 0))]) })), [0, 1]);

/* ── Une fenêtre qui TRAVERSE minuit ──────────────────────────────────────── */
ok("23 h est dans [22 h, 2 h[", lt.inHourWindow(local(2026, 9, 10, 23), 22, 2));
ok("01 h est dans [22 h, 2 h[", lt.inHourWindow(local(2026, 9, 11, 1), 22, 2));
ok("12 h n'est pas dans [22 h, 2 h[", !lt.inHourWindow(local(2026, 9, 11, 12), 22, 2));

/* ── Le changement d'heure ne casse pas une série ──────────────────────────── */
ok("29 → 30 mars 2026 = 1 jour (heure d'été)", lt.dayDiff("2026-03-29", "2026-03-30") === 1);
ok("25 → 26 octobre 2026 = 1 jour (heure d'hiver)", lt.dayDiff("2026-10-25", "2026-10-26") === 1);
{
  /* Trois jours à cheval sur le passage à l'heure d'été : la série vaut 3. */
  const days = ["2026-03-28", "2026-03-29", "2026-03-30"];
  check("série de 3 jours malgré le changement d'heure", lt.longestRun(days), 3);
}

/* ── L'horloge en avance est ignorée, pas ramenée ──────────────────────────── */
{
  const now = local(2026, 9, 16, 12);
  const progress = Object.fromEntries([
    ep(1, 1, now - 3600_000),
    ep(1, 2, now + 30 * 86_400_000), // un mois dans le futur
  ]);
  const d = derive(snap({ progress, now }));
  check("les deux épisodes comptent", d.episodes, 2);
  check("mais un seul est daté", d.stamps.length, 1);
  check("et il ne fabrique pas de jour", d.days.size, 1);
}

/* ── La nuit est une grappe, pas une date ─────────────────────────────────── */
{
  /* 12 épisodes de 23 h à 3 h : une seule nuit, deux dates civiles. */
  const start = local(2026, 9, 10, 23, 0);
  const progress = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => ep(1, i + 1, start + i * 1500_000)),
  );
  check("12 épisodes à cheval sur minuit = une nuit", m("night-12", snap({ progress })), [12, 12]);
  check("...et 12 en 24 h glissantes", derive(snap({ progress })).best24h, 12);
}
{
  /* Les mêmes 12 épisodes étalés sur six jours ne font pas une nuit. */
  const progress = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => ep(1, i + 1, local(2026, 9, 1, 20) + i * 12 * 3600_000)),
  );
  check("12 épisodes sur 6 jours ≠ une nuit", m("night-12", snap({ progress })), [1, 12]);
}

/* ── Une liste importée sans horodatage n'alimente aucun badge horaire ─────── */
{
  const list = Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [
      i + 1,
      { mediaId: i + 1, status: "COMPLETED", score: 8, progress: 12, total: 12,
        startedAt: null, completedAt: null, notes: null, updatedAt: local(2026, 9, 16, 11) },
    ]),
  );
  const s = snap({ list });
  check("30 anime importés comptent comme terminés", m("fin-25", s), [30, 25]);
  /* LES ÉPISODES D'UNE LISTE IMPORTÉE COMPTENT (corrigé le 17/09/2026).
     Ils ne comptaient pas, et un compte à cinq mille épisodes sur son profil
     n'avait que le badge du premier — le profil et l'onglet Badges affichaient
     deux chiffres contradictoires sur la même page. Ce qu'une liste importée ne
     donne toujours pas, ce sont les badges qui demandent une HEURE : elle porte
     des dates, pas des horodatages de lecture. */
  check("...et donnent bien leurs épisodes", derive(s).episodes, 360);
  check("...ni minuit", m("midnight", s), [0, 1]);
  check("...ni la fenêtre nocturne", m("late-night", s), [0, 1]);
  check("...ni de série de jours", m("streak-7", s), [0, 7]);
  /* Sans durée connue, aucune minute inventée. */
  check("...ni la moindre minute sans durée connue", Math.round(derive(s).minutes), 0);
}
{
  /* LE DOUBLE COMPTAGE, qui est le piège de ce calcul : un épisode lu ici est
     aussi, en principe, dans le `progress` de la liste. On prend le plus grand
     des deux par anime, jamais la somme. */
  const list = {
    1: { mediaId: 1, status: "CURRENT", score: null, progress: 10, total: 24,
         startedAt: null, completedAt: null, notes: null, updatedAt: 1, duration: 24 },
  };
  const progress = Object.fromEntries(
    Array.from({ length: 4 }, (_, i) => ep(1, i + 1, local(2026, 9, 16, 20))),
  );
  const d = derive(snap({ list, progress }));
  check("4 lus ici + 10 dans la liste = 10, pas 14", d.episodes, 10);
  /* Les 6 épisodes vus AILLEURS comptent la durée qu'AniList donne ; les 4 lus
     ici gardent leur durée mesurée (ep() pose 24 min). */
  check("les minutes suivent la même règle", Math.round(d.minutes), 10 * 24);
}
{
  /* LES RELECTURES COMPTENT (corrigé le 17/09/2026). Le profil affichait 5261
     épisodes et le badge « 4917 / 5000 » sur la même page : `episodesWatched`
     d'AniList ajoute `repeat × épisodes`, pas nous. Ici : 24 vus + 2 relectures
     complètes d'une série de 24 = 72. */
  const list = {
    1: { mediaId: 1, status: "COMPLETED", score: null, progress: 24, total: 24, repeat: 2,
         startedAt: null, completedAt: null, notes: null, updatedAt: 1, duration: 24 },
  };
  const d = derive(snap({ list }));
  check("deux relectures d'une série de 24 = 72 épisodes", d.episodes, 72);
  check("...et les minutes suivent", Math.round(d.minutes), 72 * 24);
  /* Sans `total` connu, une relecture vaut ce qui a été vu — jamais davantage. */
  const sansTotal = {
    1: { mediaId: 1, status: "CURRENT", score: null, progress: 10, total: null, repeat: 1,
         startedAt: null, completedAt: null, notes: null, updatedAt: 1 },
  };
  check("sans total connu, la relecture vaut l'avancement", derive(snap({ list: sansTotal })).episodes, 20);
}
{
  /* Et l'avance locale n'est pas perdue quand la synchro n'a pas encore eu
     lieu : la liste dit 2, on en a lu 5 ici. */
  const list = {
    1: { mediaId: 1, status: "CURRENT", score: null, progress: 2, total: 24,
         startedAt: null, completedAt: null, notes: null, updatedAt: 1 },
  };
  const progress = Object.fromEntries(
    Array.from({ length: 5 }, (_, i) => ep(1, i + 1, local(2026, 9, 16, 20))),
  );
  check("l'avance locale gagne sur une liste en retard", derive(snap({ list, progress })).episodes, 5);
}

/* ── Les badges dérivés de la liste, qui n'observent rien en direct ────────── */
{
  const entry = (over) => ({
    mediaId: 1, status: "COMPLETED", score: 8, progress: 12, total: 12,
    startedAt: null, completedAt: null, notes: null, updatedAt: 1, ...over,
  });
  /* « Par la fin » : le dernier épisode, et aucun autre. */
  check("seul le dernier épisode vu → obtenu",
    m("by-the-end", snap({ list: { 1: entry({ status: "CURRENT" }) }, progress: Object.fromEntries([ep(1, 12, local(2026, 9, 10, 20))]) })), [1, 1]);
  check("les épisodes 1 et 12 → pas « par la fin »",
    m("by-the-end", snap({ list: { 1: entry({ status: "CURRENT" }) }, progress: Object.fromEntries([ep(1, 1, local(2026, 9, 10, 19)), ep(1, 12, local(2026, 9, 10, 20))]) })), [0, 1]);
  check("le seul épisode d'un one-shot ne compte pas",
    m("by-the-end", snap({ list: { 1: entry({ total: 1 }) }, progress: Object.fromEntries([ep(1, 1, local(2026, 9, 10, 20))]) })), [0, 1]);

  /* « D'une traite » : les deux dates sur la même journée. */
  const d1 = { year: 2026, month: 9, day: 10 };
  const d2 = { year: 2026, month: 9, day: 11 };
  check("commencé et terminé le même jour → obtenu",
    m("one-sitting", snap({ list: { 1: entry({ startedAt: d1, completedAt: d1 }) } })), [1, 1]);
  check("deux jours différents → pas obtenu",
    m("one-sitting", snap({ list: { 1: entry({ startedAt: d1, completedAt: d2 }) } })), [0, 1]);
  check("un film d'un seul épisode ne compte pas",
    m("one-sitting", snap({ list: { 1: entry({ total: 1, startedAt: d1, completedAt: d1 }) } })), [0, 1]);
  check("une date incomplète ne compte pas",
    m("one-sitting", snap({ list: { 1: entry({ startedAt: { year: 2026, month: null, day: null }, completedAt: d1 }) } })), [0, 1]);

  /* « Premier pas » : une entrée dans la liste suffit, quel que soit le statut. */
  check("liste vide → 0 / 1", m("first-add", snap()), [0, 1]);
  check("un titre en projet suffit",
    m("first-add", snap({ list: { 1: entry({ status: "PLANNING", progress: 0 }) } })), [1, 1]);
}

/* ── Le contrat du `null` : pas encore mesurable ≠ zéro ────────────────────── */
{
  const list = {
    1: { mediaId: 1, status: "COMPLETED", score: 9, progress: 12, total: 12,
         startedAt: null, completedAt: null, notes: null, updatedAt: 1 },
  };
  check("sans genres, un badge de genre est null", m("g-action", snap({ list })), null);
  check("sans année, « Fonds d'archive » est null", m("archive-1990", snap({ list })), null);
  check("sans vocabulaire, « Tous les genres » est null", m("all-genres", snap({ list })), null);
  check("sans favoris AniList, « Coups de cœur » est null", m("fav-1", snap({ list })), null);

  const withMeta = {
    1: { ...list[1], genres: ["Action", "Comedy"], tags: [], year: 1988, format: "TV",
         studio: "Madhouse", popularity: 1200, relIds: [] },
  };
  check("avec genres, le badge se mesure", m("g-action", snap({ list: withMeta })), [1, 30]);
  check("avec l'année, « Fonds d'archive » est obtenu", m("archive-1990", snap({ list: withMeta })), [1, 1]);
  check("avec la popularité, « Pépite oubliée » est obtenu", m("hidden-gem", snap({ list: withMeta })), [1, 1]);
}

/* ── Le re-visionnage compte des visionnages, pas des re-visionnages ───────── */
{
  const mk = (repeat) => ({
    1: { mediaId: 1, status: "COMPLETED", score: 8, progress: 12, total: 12, repeat,
         startedAt: null, completedAt: null, notes: null, updatedAt: 1 },
  });
  check("repeat 0 → 1 visionnage sur 3", m("thrice", snap({ list: mk(0) })), [1, 3]);
  check("repeat 1 → 2 visionnages sur 3", m("thrice", snap({ list: mk(1) })), [2, 3]);
  check("repeat 2 → 3 visionnages, obtenu", m("thrice", snap({ list: mk(2) })), [3, 3]);
}

/* ── Le temps cumulé se mesure, il ne s'estime pas ─────────────────────────── */
{
  /* 25 épisodes de 24 min = 600 min = 10 h pile. */
  const progress = Object.fromEntries(
    Array.from({ length: 25 }, (_, i) => ep(1, i + 1, local(2026, 9, 10, 10) + i * 1500_000, 24)),
  );
  check("25 × 24 min = 600 min", m("time-10h", snap({ progress })), [600, 600]);
}

/* ── Les fenêtres glissantes ──────────────────────────────────────────────── */
{
  /* 10 épisodes lundi soir, 10 mardi matin : aucun jour civil n'en compte 20,
     mais la fenêtre de 24 h, si. C'est le sujet du badge. */
  const progress = Object.fromEntries([
    ...Array.from({ length: 10 }, (_, i) => ep(1, i + 1, local(2026, 9, 10, 20) + i * 600_000)),
    ...Array.from({ length: 10 }, (_, i) => ep(2, i + 1, local(2026, 9, 11, 8) + i * 600_000)),
  ]);
  check("20 en 24 h à cheval sur deux dates", m("burst-20", snap({ progress })), [20, 20]);
}

/* ── La série de jours ────────────────────────────────────────────────────── */
{
  const days = Array.from({ length: 8 }, (_, i) => ep(1, i + 1, local(2026, 9, 9 + i, 20)));
  const s = snap({ progress: Object.fromEntries(days), now: local(2026, 9, 16, 22) });
  check("8 jours d'affilée → streak-7 obtenu", m("streak-7", s), [8, 7]);
}
{
  /* Un trou d'un jour casse la série en cours, mais pas la meilleure. */
  const progress = Object.fromEntries([
    ep(1, 1, local(2026, 9, 9, 20)), ep(1, 2, local(2026, 9, 10, 20)),
    ep(1, 3, local(2026, 9, 12, 20)), ep(1, 4, local(2026, 9, 15, 20)),
    ep(1, 5, local(2026, 9, 16, 20)),
  ]);
  const d = derive(snap({ progress, now: local(2026, 9, 16, 22) }));
  check("série en cours = 2", d.streak, 2);
  check("meilleure série = 2", d.bestStreak, 2);
}
{
  /* Hier compte : on ne casse pas une série à 00 h 01 parce que la journée
     d'aujourd'hui n'a pas encore servi. */
  const progress = Object.fromEntries([
    ep(1, 1, local(2026, 9, 14, 20)), ep(1, 2, local(2026, 9, 15, 20)),
  ]);
  check("série vivante si le dernier jour est hier", derive(snap({ progress, now: local(2026, 9, 16, 0, 1) })).streak, 2);
  check("série morte si le dernier jour est avant-hier", derive(snap({ progress, now: local(2026, 9, 17, 12) })).streak, 0);
}

/* ── Le marathon de week-end doit tenir sur le week-end ───────────────────── */
{
  /* 12 septembre 2026 = samedi. 12 h de séance. */
  const sat = local(2026, 9, 12, 9);
  const progress = Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => ep(1, i + 1, sat + i * 1500_000, 25)),
  );
  const [cur] = m("session-12h", snap({ progress }));
  ok(`marathon de week-end mesuré (${cur} h)`, cur >= 12);

  /* La même séance un mardi ne le donne pas. */
  const tue = local(2026, 9, 15, 9);
  const week = Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => ep(1, i + 1, tue + i * 1500_000, 25)),
  );
  check("...mais pas en semaine", m("session-12h", snap({ progress: week })), [0, 12]);
}

/* ── « Jamais l'opening » ─────────────────────────────────────────────────── */
{
  const list = {
    7: { mediaId: 7, status: "COMPLETED", score: 8, progress: 3, total: 3,
         startedAt: null, completedAt: null, notes: null, updatedAt: 1 },
  };
  const progress = Object.fromEntries([
    ep(7, 1, local(2026, 9, 10, 20)), ep(7, 2, local(2026, 9, 10, 21)), ep(7, 3, local(2026, 9, 10, 22)),
  ]);
  check("aucun opening sauté → obtenu", m("never-op", snap({ list, progress })), [1, 1]);
  const facts = { ...EMPTY_FACTS, opSkipped: ["7:2"] };
  check("un seul opening sauté → perdu", m("never-op", snap({ list, progress, facts })), [0, 1]);
  check("anime importé sans épisode vu ici → pas obtenu", m("never-op", snap({ list })), [0, 1]);
}

/* ── « Tous les lecteurs » suit le registre, pas une constante ─────────────── */
{
  const facts = { ...EMPTY_FACTS, hosts: ["a", "b"] };
  check("2 lecteurs sur 3", m("all-players", snap({ facts })), [2, 3]);
  const facts2 = { ...EMPTY_FACTS, hosts: ["a", "b", "z"] };
  check("un lecteur retiré du site ne compte pas", m("all-players", snap({ facts: facts2 })), [2, 3]);
}

/* ── Un badge obtenu ne se reperd jamais ──────────────────────────────────── */
{
  const progress = Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => ep(1, i + 1, local(2026, 9, 10, 20) + i * 1800_000)),
  );
  const full = derive(snap({ progress }));
  ok("30 épisodes franchissent ep-25", measure(BY_ID["ep-25"], full, state())[0] >= 25);
  /* L'historique effacé : le compteur retombe à zéro… */
  const wiped = derive(snap({ progress: {} }));
  check("compteur à zéro après effacement", measure(BY_ID["ep-25"], wiped, state())[0], 0);
  /* …mais l'état persisté, lui, garde le badge : c'est `got` qui fait foi, et
     store.ts n'expose aucun retrait. */
  ok("le badge reste dans l'état", state({ "ep-25": 1 }).got["ep-25"] === 1);
}

/* ── La fusion est commutative et garde la date la plus ancienne ───────────── */
{
  const { mergeBadgeState } = await load("lib/badges/store.ts");
  const a = { v: 1, got: { "ep-1": 100, "ep-25": 500 } };
  const b = { v: 1, got: { "ep-1": 50, "fin-1": 700 }, backfilled: true };
  const ab = mergeBadgeState(a, b);
  const ba = mergeBadgeState(b, a);
  /* Comparé CLÉS TRIÉES : l'ordre d'insertion d'un objet dépend de l'ordre des
     opérandes et ne veut rien dire ici. Ce qui doit être commutatif, c'est le
     contenu — quels badges, et à quelle date. */
  const norm = (s) => ({ ...s, got: Object.entries(s.got).sort(([x], [y]) => x.localeCompare(y)) });
  check("fusion commutative", norm(ab), norm(ba));
  check("date la plus ancienne", ab.got["ep-1"], 50);
  check("union des ids", Object.keys(ab.got).sort(), ["ep-1", "ep-25", "fin-1"]);
  check("backfilled est un OU", ab.backfilled, true);
  check("fusion idempotente", mergeBadgeState(ab, ab), ab);
}

/* ── Les badges qui comptent des badges ───────────────────────────────────── */
{
  const got = {};
  for (const b of all.filter((x) => x.family !== "secret").slice(0, 50)) got[b.id] = 1;
  check("50 badges principaux → badges-50 obtenu", m("badges-50", snap(), state(got)), [50, 50]);
  const withSecrets = { ...got };
  for (const b of all.filter((x) => x.family === "secret").slice(0, 10)) withSecrets[b.id] = 1;
  check("les secrets ne gonflent pas le compteur", m("badges-50", snap(), state(withSecrets)), [50, 50]);
  check("...ils ont le leur", m("secret-50", snap(), state(withSecrets)), [10, 50]);
  check("« Collection complète » s'exclut elle-même", m("complete", snap(), state(got))[1], 100);
}

/* ── Verdict ──────────────────────────────────────────────────────────────── */

if (failures.length) {
  console.log(`\n${failures.length} ÉCHEC(S) sur ${pass + failures.length} :\n`);
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log(`${pass} assertions passées — catalogue et évaluateur conformes.`);
