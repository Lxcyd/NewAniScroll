/**
 * Confronte chaque id de works.data.mjs au titre qu'il est censé porter.
 *
 * À LANCER À LA MAIN, pas en CI : c'est un appel à un tiers, et la table ne
 * bouge qu'à l'ajout d'un badge. `node tools/badges/check-works.mjs`
 *
 * Un id faux est un badge qui ne se débloquera jamais, et rien dans l'interface
 * ne le distinguerait d'un badge difficile. C'est donc ici, et nulle part
 * ailleurs, que cette classe de bug se rattrape.
 *
 * La comparaison est VOLONTAIREMENT LÂCHE sur la forme du titre (casse,
 * ponctuation, accents, romanisation) et stricte sur le fond : on cherche le
 * titre attendu parmi romaji / english / native / synonymes. Un « Shingeki no
 * Kyojin » écrit « Attack on Titan » n'est pas une erreur ; un id qui rend
 * « Naruto: Shippuden » là où on attend « Naruto » en est une.
 */

import { WORKS } from "./works.data.mjs";

const API = "https://graphql.anilist.co/";

/** Réduit un titre à ce qui l'identifie : minuscules, sans accents ni ponctuation. */
const norm = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const QUERY = `query ($ids: [Int]) {
  Page(perPage: 50) {
    media(id_in: $ids, type: ANIME) {
      id
      title { romaji english native }
      synonyms
      format
      episodes
      startDate { year }
    }
  }
}`;

async function fetchMedia(ids) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { ids } }),
  });
  if (!res.ok) throw new Error(`AniList ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data?.Page?.media ?? [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wanted = new Map(); // id -> [titre attendu, clé d'œuvre]
for (const [key, def] of Object.entries(WORKS)) {
  for (const [id, title] of def.ids) {
    if (wanted.has(id) && wanted.get(id)[0] !== title) {
      console.warn(`! id ${id} attendu sous deux titres différents`);
    }
    wanted.set(id, [title, key]);
  }
}

const ids = [...wanted.keys()];
console.log(`${ids.length} ids distincts, ${Object.keys(WORKS).length} œuvres.\n`);

const found = new Map();
for (let i = 0; i < ids.length; i += 50) {
  const batch = ids.slice(i, i + 50);
  const media = await fetchMedia(batch);
  for (const m of media) found.set(m.id, m);
  /* AniList plafonne à 90 requêtes/minute. On est très en dessous, mais on
     espace quand même : ce script n'est pas pressé et le tiers n'est pas à
     nous. */
  if (i + 50 < ids.length) await sleep(1200);
}

let bad = 0;
for (const [id, [expected, key]] of wanted) {
  const m = found.get(id);
  if (!m) {
    console.log(`✗ ${key.padEnd(14)} ${String(id).padEnd(7)} INTROUVABLE (attendu « ${expected} »)`);
    bad += 1;
    continue;
  }
  const names = [m.title.romaji, m.title.english, m.title.native, ...(m.synonyms || [])];
  const want = norm(expected);
  const hit = names.some((n) => {
    const got = norm(n);
    return got === want || got.startsWith(want) || want.startsWith(got);
  });
  if (hit) continue;
  console.log(
    `✗ ${key.padEnd(14)} ${String(id).padEnd(7)} attendu « ${expected} »\n` +
      `                        trouvé  « ${m.title.romaji} » / « ${m.title.english ?? "—"} »` +
      ` (${m.format}, ${m.startDate?.year ?? "?"}, ${m.episodes ?? "?"} ép.)`,
  );
  bad += 1;
}

console.log(
  bad
    ? `\n${bad} id(s) à corriger dans tools/badges/works.data.mjs.`
    : `\nLes ${ids.length} ids correspondent au titre attendu.`,
);
process.exit(bad ? 1 : 0);
