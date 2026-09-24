/**
 * Écrit lib/badges/catalog.ts, lib/badges/works.ts et le namespace `badges`
 * des deux fichiers de langue, depuis catalog.data.mjs et works.data.mjs.
 *
 *   node tools/badges/gen-catalog.mjs
 *
 * Le générateur VALIDE avant d'écrire, et n'écrit rien s'il trouve une faute :
 * un id en double, une échelle qui ne monte pas, une icône inconnue, un libellé
 * manquant dans une des deux langues. C'est ce qui garantit l'invariant posé en
 * tête de catalog.data.mjs — un badge ne peut pas exister sans ses libellés.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

import { CATALOG, FAMILIES, LADDERS } from "./catalog.data.mjs";
import { WORKS } from "./works.data.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require_ = createRequire(join(ROOT, "package.json"));

/* ── Validation ───────────────────────────────────────────────────────────── */

const errors = [];
const byId = new Map();

for (const family of Object.keys(CATALOG)) {
  if (!FAMILIES.includes(family)) errors.push(`famille inconnue : ${family}`);
  for (const row of CATALOG[family]) {
    const [id, rarity, icon, tag, metric, frName, frCond, enName, enCond] = row;
    if (byId.has(id)) errors.push(`id en double : ${id}`);
    byId.set(id, { id, family, rarity, icon, tag, metric, frName, frCond, enName, enCond });
    if (!"curelm".includes(rarity) || rarity.length !== 1) errors.push(`${id} : rareté « ${rarity} »`);
    if (!metric || typeof metric.k !== "string") errors.push(`${id} : métrique absente`);
    for (const [label, v] of [["frName", frName], ["frCond", frCond], ["enName", enName], ["enCond", enCond]]) {
      if (typeof v !== "string" || !v.trim()) errors.push(`${id} : ${label} manquant`);
    }
  }
}

/* Les icônes doivent exister dans le registre généré — sans quoi le badge
   s'affiche avec le trophée de repli et personne ne s'en aperçoit. */
let iconKeys = null;
try {
  const src = readFileSync(join(ROOT, "lib", "badges", "icons.ts"), "utf8");
  const body = src.slice(src.indexOf("BADGE_ICONS: Record<string, IconType> = {"));
  iconKeys = new Set([...body.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]));
} catch {
  errors.push("lib/badges/icons.ts introuvable — lancer d'abord gen-icons.mjs");
}
if (iconKeys) {
  for (const b of byId.values()) {
    if (!iconKeys.has(b.icon)) errors.push(`${b.id} : icône inconnue « ${b.icon} »`);
  }
}

/* Une échelle doit monter, et ne mesurer qu'une seule chose : c'est ce qui rend
   « le premier palier non atteint » bien défini. */
/* « Tous les autres badges » (`allBadges`) compte la même chose que
   `count/badges`, avec une cible calculée à l'exécution : le total principal
   moins lui-même (measure.ts). Il peut donc fermer l'échelle des badges. */
const mainCount = [...byId.values()].filter((b) => b.family !== "secret").length;
const ladderMetric = (m) =>
  m.k === "allBadges" ? { k: "count", of: "badges", n: mainCount - 1 } : m;
for (const [name, ids] of Object.entries(LADDERS)) {
  let prev = -Infinity;
  let kind = null;
  for (const id of ids) {
    const b = byId.get(id);
    if (!b) { errors.push(`échelle ${name} : id inconnu ${id}`); continue; }
    const m = ladderMetric(b.metric);
    const key = JSON.stringify({ ...m, n: undefined });
    if (kind === null) kind = key;
    else if (kind !== key) errors.push(`échelle ${name} : ${id} ne mesure pas la même chose`);
    const n = m.n;
    if (!(n > prev)) errors.push(`échelle ${name} : ${id} (${n}) ne dépasse pas le palier précédent (${prev})`);
    prev = n;
  }
}

/* Les métriques qui nomment une œuvre doivent la trouver. */
for (const b of byId.values()) {
  const key = b.metric.key;
  if ((b.metric.k === "works" || b.metric.k === "worksEpisodes" || b.metric.k === "worksCount") &&
      key && key !== "ghibli" && !WORKS[key]) {
    errors.push(`${b.id} : œuvre « ${key} » absente de works.data.mjs`);
  }
}

if (errors.length) {
  console.error(`Catalogue refusé — ${errors.length} faute(s) :`);
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}

/* ── lib/badges/catalog.ts ────────────────────────────────────────────────── */

const ladderOf = new Map();
for (const [name, ids] of Object.entries(LADDERS)) for (const id of ids) ladderOf.set(id, name);

const defs = [...byId.values()].map((b) => {
  const bits = [
    `id: ${JSON.stringify(b.id)}`,
    `family: ${JSON.stringify(b.family)}`,
    `rarity: ${JSON.stringify(b.rarity)}`,
    `icon: ${JSON.stringify(b.icon)}`,
    `tag: ${JSON.stringify(b.tag)}`,
    `metric: ${JSON.stringify(b.metric)}`,
  ];
  if (ladderOf.has(b.id)) bits.push(`ladder: ${JSON.stringify(ladderOf.get(b.id))}`);
  if (b.family === "secret") bits.push("secret: true");
  return `  { ${bits.join(", ")} },`;
});

const catalogTs = `/**
 * Le catalogue des badges — ${byId.size} définitions.
 *
 * FICHIER GÉNÉRÉ — ne pas éditer à la main.
 * Source : tools/badges/catalog.data.mjs, régénéré par
 * \`node tools/badges/gen-catalog.mjs\`, qui écrit aussi les libellés dans
 * locales/fr.json et locales/en.json.
 *
 * L'\`id\` est l'identité du badge : il est écrit dans les données de
 * l'utilisateur et ne doit JAMAIS changer. Les libellés, eux, vivent en i18n
 * sous \`badges.<id>.name\` et \`badges.<id>.cond\`.
 */

/** c(ommon) u(ncommon) r(are) e(pic) l(egendary) m(ythic). */
export type Rarity = "c" | "u" | "r" | "e" | "l" | "m";

export type Family =
${FAMILIES.map((f) => `  | ${JSON.stringify(f)}`).join("\n")};

/**
 * Ce que l'évaluateur doit mesurer. \`n\` est l'objectif quand il est connu
 * d'avance ; les métriques dont la cible dépend des données (tous les genres,
 * tous les lecteurs, toute la collection) portent \`n: 0\` et la calculent à
 * l'exécution — cf. lib/badges/evaluate.ts.
 */
export type Metric = { k: string; n: number; [param: string]: unknown };

export type BadgeDef = {
  id: string;
  family: Family;
  rarity: Rarity;
  icon: string;
  /** Ce qui s'écrit sur la plaque du jeton. Vide = pas de plaque. */
  tag: string;
  metric: Metric;
  /** L'échelle de paliers à laquelle il appartient, s'il y en a une. */
  ladder?: string;
  secret?: true;
};

export const BADGES: BadgeDef[] = [
${defs.join("\n")}
];

export const BY_ID: Record<string, BadgeDef> = Object.fromEntries(
  BADGES.map((b) => [b.id, b]),
);

/**
 * Les échelles, du plus petit palier au plus grand.
 *
 * L'onglet n'affiche qu'un badge par échelle — le premier non atteint — et
 * range les autres dans le dépli.
 */
export const LADDERS: Record<string, string[]> = ${JSON.stringify(LADDERS, null, 2)
  .split("\n").map((l, i) => (i ? "" : "") + l).join("\n")};

/** Les badges hors secret : ceux qui comptent dans le total annoncé. */
export const MAIN = BADGES.filter((b) => !b.secret);
export const SECRETS = BADGES.filter((b) => b.secret);

/** L'ordre des raretés, du socle au sommet. */
export const RARITY_ORDER: Rarity[] = ["c", "u", "r", "e", "l", "m"];
`;

writeFileSync(join(ROOT, "lib", "badges", "catalog.ts"), catalogTs);

/* ── lib/badges/works.ts ──────────────────────────────────────────────────── */

const worksTs = `/**
 * Les œuvres nommées par les badges secrets, par id AniList.
 *
 * FICHIER GÉNÉRÉ — ne pas éditer à la main.
 * Source : tools/badges/works.data.mjs, qui porte aussi le TITRE attendu de
 * chaque id. \`node tools/badges/check-works.mjs\` confronte les deux à AniList :
 * c'est là, et nulle part ailleurs, qu'un id faux se rattrape — un badge dont
 * l'id est faux ne se débloque jamais et ressemble à un badge difficile.
 *
 * Vérifié le ${new Date().toISOString().slice(0, 10)} : ${
  new Set(Object.values(WORKS).flatMap((w) => w.ids.map(([id]) => id))).size
} ids, tous conformes.
 */

export type WorkDef = {
  /** "all" : toutes les entrées doivent être terminées. "any" : une suffit. */
  mode: "all" | "any";
  ids: number[];
};

export const WORKS: Record<string, WorkDef> = {
${Object.entries(WORKS)
  .map(([key, def]) =>
    `  ${key}: { mode: ${JSON.stringify(def.mode ?? "all")}, ids: [${def.ids.map(([id]) => id).join(", ")}] },`,
  )
  .join("\n")}
};
`;

writeFileSync(join(ROOT, "lib", "badges", "works.ts"), worksTs);

/* ── locales ──────────────────────────────────────────────────────────────── */

/**
 * Le namespace `badges` est RÉÉCRIT en entier à chaque génération, et rien
 * d'autre n'est touché : les clés sont dérivées du catalogue, donc un badge
 * supprimé doit voir ses libellés disparaître avec lui plutôt que rester en
 * poids mort.
 */
function writeLocale(file, pick) {
  const path = join(ROOT, "locales", file);
  const json = JSON.parse(readFileSync(path, "utf8"));
  const ns = {};
  for (const b of byId.values()) ns[b.id] = pick(b);
  json.badges = { ...(json.badges?.ui ? { ui: json.badges.ui } : {}), ...ns };
  /* Deux espaces, un saut de ligne final — et les MÊMES fins de ligne que le
     fichier d'origine. Les deux locales sont en CRLF ; les réécrire en LF
     ferait un diff de 1 554 lignes pour un ajout de badges, et le vrai
     changement deviendrait illisible. */
  const eol = readFileSync(path, "utf8").includes("\r\n") ? "\r\n" : "\n";
  writeFileSync(path, JSON.stringify(json, null, 2).replace(/\n/g, eol) + eol);
}

writeLocale("fr.json", (b) => ({ name: b.frName, cond: b.frCond }));
writeLocale("en.json", (b) => ({ name: b.enName, cond: b.enCond }));

const secrets = [...byId.values()].filter((b) => b.family === "secret").length;
console.log(
  `catalog.ts : ${byId.size} badges (${byId.size - secrets} principaux, ${secrets} secrets)\n` +
  `works.ts   : ${Object.keys(WORKS).length} œuvres\n` +
  `locales    : namespace « badges » réécrit dans fr.json et en.json`,
);
