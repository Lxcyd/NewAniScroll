/**
 * Le catalogue complet d'AniList pour les onglets « Tous les genres / tags /
 * studios » du panneau Tri & filtres (components/profile/ListSortFilter.tsx).
 *
 * Pourquoi un fichier figé plutôt qu'une requête au chargement : la liste des
 * studios demande ~55 pages (AniList n'en donne que 50 par page et plafonne à
 * 90 requêtes/min) — impensable à chaque ouverture du panneau.
 *
 * INCRÉMENTAL (12/11/2026, Luc : « un script qui regarde tous les jours si
 * nouveau studio ou tags et qui les ajoute ») :
 *   - genres et tags : une requête, la liste remplace l'ancienne ;
 *   - studios : seulement ceux dont l'id dépasse `maxStudioId`, pris du plus
 *     récent au plus ancien jusqu'à retomber sur un connu — une ou deux
 *     requêtes par jour. `--full` refait tout (premier passage, ou ménage).
 * Le fichier n'est réécrit QUE si quelque chose a changé : sinon aucun commit,
 * aucun déploiement (cf. .github/workflows/anilist-catalog.yml).
 *
 * TOUS les studios (animation, producteurs, chaînes, éditeurs…), comme la
 * référence : un titre de la liste compte chacun de ses studios.
 *
 *   node tools/anilist/catalog.mjs          → mise à jour incrémentale
 *   node tools/anilist/catalog.mjs --full   → tout recharger
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../../lib/data/anilistCatalog.json");
const API = "https://graphql.anilist.co";
const FULL = process.argv.includes("--full");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gql(query, variables = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") || 60);
      console.log(`429, pause ${wait} s`);
      await sleep(wait * 1000 + 500);
      continue;
    }
    const json = await res.json();
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    return json.data;
  }
  throw new Error("AniList : trop de 429");
}

const prev = !FULL && existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
const incremental = !!(prev && Array.isArray(prev.studios) && prev.maxStudioId);

const vocab = await gql(`query { GenreCollection MediaTagCollection { name isAdult } }`);
const genres = vocab.GenreCollection.filter(Boolean);
const tags = vocab.MediaTagCollection.filter((t) => t?.name).map((t) => ({ name: t.name, isAdult: !!t.isAdult }));
/* Garde-fou : une réponse vide ou tronquée ne doit pas vider le catalogue. */
if (genres.length < 10 || tags.length < 300) throw new Error(`réponse suspecte : ${genres.length} genres, ${tags.length} tags`);

const studios = new Set(incremental ? prev.studios : []);
let maxStudioId = incremental ? prev.maxStudioId : 0;
const QUERY = (sort) =>
  `query ($page: Int) { Page(page: $page, perPage: 50) { pageInfo { hasNextPage } studios(sort: ${sort}) { id name } } }`;

if (incremental) {
  /* Du plus récent au plus ancien, jusqu'au premier id déjà connu. */
  let top = maxStudioId;
  for (let page = 1; ; page++) {
    const d = await gql(QUERY("ID_DESC"), { page });
    let reached = false;
    for (const s of d.Page.studios) {
      if (s.id <= prev.maxStudioId) { reached = true; break; }
      if (s.name) studios.add(s.name.trim());
      top = Math.max(top, s.id);
    }
    if (reached || !d.Page.pageInfo.hasNextPage) break;
    await sleep(1400);
  }
  maxStudioId = top;
} else {
  for (let page = 1; ; page++) {
    const d = await gql(QUERY("ID"), { page });
    for (const s of d.Page.studios) {
      if (s.name) studios.add(s.name.trim());
      maxStudioId = Math.max(maxStudioId, s.id);
    }
    if (page % 10 === 0) console.log(`page ${page} : ${studios.size} studios`);
    if (!d.Page.pageInfo.hasNextPage) break;
    await sleep(1400);
  }
}

const next = {
  genres,
  tags,
  studios: [...studios].sort((a, b) => a.localeCompare(b)),
  maxStudioId,
};
const same =
  prev &&
  JSON.stringify({ genres: prev.genres, tags: prev.tags, studios: prev.studios, maxStudioId: prev.maxStudioId }) ===
    JSON.stringify(next);
const newStudios = prev ? next.studios.length - (prev.studios?.length ?? 0) : next.studios.length;
const newTags = prev ? next.tags.length - (prev.tags?.length ?? 0) : next.tags.length;

if (same) {
  console.log(`rien de neuf : ${genres.length} genres, ${tags.length} tags, ${next.studios.length} studios`);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString().slice(0, 10), ...next }) + "\n");
  console.log(`mis à jour : ${genres.length} genres, ${tags.length} tags (${newTags >= 0 ? "+" : ""}${newTags}), ${next.studios.length} studios (${newStudios >= 0 ? "+" : ""}${newStudios})`);
}
