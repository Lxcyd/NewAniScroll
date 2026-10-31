#!/usr/bin/env node
/**
 * Etape 3/3 : a quels animes appartient chaque image etiquetee ? Aucune requete
 * a Wallhaven : on compare ses tags aux titres AniList, puis on etend a la
 * FRANCHISE. Resultat dans `wallhaven_image` (une ligne par anime x image), la
 * table que lit la galerie (lib/db/wallhavenImages.ts) — le site ne change pas.
 *
 * LA REGLE, et les pieges qu'elle evite :
 *  - Un tag nomme sa serie par son nom, ses ALIAS (« Kill la Kill » /
 *    « キルラキル »), ou entre parentheses sur un personnage (« Uta (One
 *    Piece) ») ; « Naruto (anime) » vaut « Naruto ».
 *  - Les series ne sont pas toutes rangees dans la categorie « Series » (Koe no
 *    Katachi est dans « Movies ») : le nom complet compte dans les categories
 *    qui rangent des OEUVRES (Series, Anime & Manga, Movies, Games…), JAMAIS
 *    dans les descriptives ni les melangees — essai du 31/10/2026 : `umbrella`
 *    donnait l'anime Umbrella, « looking back » LOOK BACK, l'alias `pigtails`
 *    de « twintails » Pigtails.
 *  - Sword Art Online, range dans « Miscellaneous », passe par ses personnages :
 *    « Yuuki Asuna (Sword Art Online) ». La parenthese d'un personnage compte
 *    toujours ; ailleurs elle doit faire plusieurs mots (« heart (design) »).
 *  - Correspondance EXACTE, apres normalisation (normaliserTitre : accents,
 *    « ō » = « ou ») ; jamais par inclusion.
 *  - Franchise = relations AniList SEQUEL / PREQUEL / PARENT / SIDE_STORY /
 *    SUMMARY : une image « Shingeki no Kyojin » va a toutes les saisons, aux
 *    films et aux OAV. Pas les SPIN_OFF ni les ALTERNATIVE (autre oeuvre).
 *  - Les lignes de l'ancienne recherche par titre restent si les tags
 *    confirment la serie (serieConfirmee), et partent s'ils la dementent.
 *
 *   node tools/wallhaven/attribuer.mjs [--tout] [--essai=wh_id,…]
 *     --tout : rejoue toutes les images etiquetees (apres un changement de regle)
 *     --essai : affiche l'attribution de ces images, n'ecrit rien
 */
import {
  chargerEnv, baseAnime, baseImages, maintenant, duree, preparerChaine,
} from "./socle.mjs";
import { normaliserTitre, serieConfirmee } from "../../lib/wallhaven/criteres.js";

chargerEnv();
const args = process.argv.slice(2);
const tout = args.includes("--tout");
const essai = args.find((a) => a.startsWith("--essai="))?.slice(8).split(",") || null;

const anime = baseAnime();
const db = baseImages();
await preparerChaine(db);
const t0 = Date.now();

/* ── Formes comparables d'un titre ou d'un tag ───────────────────────────── */
const STOP = new Set(["anime", "manga", "anime girls", "anime boys", "4k", "chibi", "anime screenshot", "fan art",
  "original characters", "original character", "video game characters", "anime games", "digital art", "artwork", "crossover", "parody"]
  .map(normaliserTitre));
/** Latin : normaliserTitre ; ecriture japonaise/chinoise : on garde les lettres. */
function formes(s) {
  const out = [];
  const n = normaliserTitre(s);
  if (n.length >= 3 && !STOP.has(n)) out.push(n);
  if (/[^\u0000-ɏ]/.test(String(s))) {
    const u = String(s).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (u.length >= 2) out.push(`u:${u}`);
  }
  return out;
}

/* ── Les animes : titres et franchise ─────────────────────────────────────── */
const LIENS = new Set(["SEQUEL", "PREQUEL", "PARENT", "SIDE_STORY", "SUMMARY"]);
const titres = new Map(); // id -> [titres bruts]
const parForme = new Map(); // forme -> Set(id)
const relations = [];
const ids = (await anime.execute("SELECT id FROM anime WHERE is_adult = 0 AND data IS NOT NULL")).rows.map((r) => Number(r.id));
for (let i = 0; i < ids.length; i += 500) {
  const lot = ids.slice(i, i + 500);
  const r = await anime.execute({
    sql: `SELECT id, json_extract(data,'$.title.romaji') ro, json_extract(data,'$.title.english') en,
            json_extract(data,'$.title.native') na, json_extract(data,'$.synonyms') syn,
            (SELECT json_group_array(json_extract(e.value,'$.relationType') || ':' || json_extract(e.value,'$.node.id'))
               FROM json_each(json_extract(data,'$.relations.edges')) e) rel
          FROM anime WHERE id IN (${lot.map(() => "?").join(",")})`,
    args: lot,
  });
  for (const x of r.rows) {
    const id = Number(x.id);
    let syn = []; try { syn = JSON.parse(String(x.syn || "[]")); } catch {}
    const t = [x.en, x.ro, x.na].filter(Boolean).map(String);
    titres.set(id, [...t, ...syn]);
    const ajouter = (f) => (parForme.get(f) || parForme.set(f, new Set()).get(f)).add(id);
    for (const s of t) for (const f of formes(s)) ajouter(f);
    // Synonymes : souvent des abreviations (« SnK », « AoT ») ; 4 caracteres au moins.
    for (const s of syn) for (const f of formes(s)) if (f.length >= 4) ajouter(f);
    let rel = []; try { rel = JSON.parse(String(x.rel || "[]")); } catch {}
    for (const e of rel) {
      const [type, autre] = String(e).split(":");
      if (LIENS.has(type)) relations.push([id, Number(autre)]);
    }
  }
}
// Franchises : union-find sur les relations entre animes connus.
const parent = new Map(ids.map((id) => [id, id]));
const racine = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
for (const [a, b] of relations) if (parent.has(b)) parent.set(racine(a), racine(b));
const franchise = new Map();
for (const id of ids) { const r = racine(id); (franchise.get(r) || franchise.set(r, []).get(r)).push(id); }
const membres = (id) => {
  const f = franchise.get(racine(id)) || [id];
  return f.length > 200 ? [id] : f; // garde-fou : un pont absurde ne doit pas tout relier
};
console.error(`${ids.length} animes, ${parForme.size} formes de titre, ${franchise.size} franchises (${duree(Date.now() - t0)})`);

/* ── Les tags ─────────────────────────────────────────────────────────────── */
const SURES = new Set(["Series", "Anime & Manga", "Movies", "Games", "Visual Novels", "Television", "Literature",
  "Comic Books & Graphic Novels"]);
/* Une forme assez precise pour une categorie melangee : PLUSIEURS mots. Essai du
   31/10/2026 : un seul mot, meme long, laissait passer les alias descriptifs —
   « twintails » (alias « pigtails ») donnait l'anime Pigtails, « umbrella »
   l'anime Umbrella. */
const precise = (f) => f.startsWith("u:") ? f.length >= 5 : f.includes(" ");
const defs = new Map();
for (const r of (await db.execute("SELECT tag_id, name, alias, category FROM wallhaven_tag_def")).rows) {
  defs.set(Number(r.tag_id), { name: String(r.name), alias: r.alias ? String(r.alias) : "", category: r.category ? String(r.category) : "" });
}
/** Les animes que nomme un tag (sans la franchise). */
const cacheTag = new Map();
function animesDuTag(tagId, nom, categorie) {
  const k = `${tagId}`;
  if (cacheTag.has(k)) return cacheTag.get(k);
  const def = defs.get(tagId) || { name: nom, alias: "", category: categorie };
  const cat = def.category || categorie || "";
  const out = new Set();
  const essayer = (s, exigerPrecision) => {
    for (const f of formes(s)) {
      if (exigerPrecision && !precise(f)) continue;
      for (const id of parForme.get(f) || []) out.add(id);
    }
  };
  // Tag descriptif connu (« original characters »…) ou adulte : ignore, alias compris.
  if (STOP.has(normaliserTitre(def.name)) || /\((hentai|ecchi)\)/i.test(def.name)) { cacheTag.set(k, out); return out; }
  const noms = [def.name, ...def.alias.split(",").map((x) => x.trim()).filter(Boolean)];
  /* Nom complet : seulement dans les categories qui rangent des oeuvres. Essai
     du 31/10/2026 : « looking back » (Miscellaneous) donnait l'anime LOOK BACK. */
  if (SURES.has(cat)) {
    for (const s of noms) {
      essayer(s, false);
      essayer(s.replace(/\s*\([^)]*\)\s*/g, " ").trim(), false); // « Naruto (anime) » -> « Naruto »
    }
  }
  /* La serie entre parentheses : « Uta (One Piece) ». Sur un PERSONNAGE c'est
     toujours sa serie, meme d'un seul mot (« Ichigo (Bleach) ») ; ailleurs il
     faut plusieurs mots (« heart (design) », « rigging (ship) »). */
  const personnage = cat === "Characters" || cat === "Fictional Characters";
  for (const m of def.name.matchAll(/\(([^)]+)\)/g)) essayer(m[1], !personnage);
  cacheTag.set(k, out);
  return out;
}

if (tout && !essai) await db.execute("UPDATE wallhaven_brut SET attribue_at = NULL WHERE tagged_at IS NOT NULL");

/* ── Le travail ───────────────────────────────────────────────────────────── */
const COLS = "wh_id, favorites, views, width, height, path, thumb, source, colors, wh_created_at, facet_type, has_character, is_scenery, tagged_at, fetched_at";
let images = 0, attribuees = 0, lignesEcrites = 0, lignesRetirees = 0, sansAnime = 0;
for (;;) {
  const lot = essai
    ? (await db.execute({ sql: `SELECT ${COLS} FROM wallhaven_brut WHERE wh_id IN (${essai.map(() => "?").join(",")})`, args: essai })).rows
    : (await db.execute(`SELECT ${COLS} FROM wallhaven_brut WHERE tagged_at IS NOT NULL AND attribue_at IS NULL LIMIT 300`)).rows;
  if (!lot.length) break;
  const whIds = lot.map((r) => String(r.wh_id));
  const ph = whIds.map(() => "?").join(",");
  const tagsPar = new Map();
  for (const t of (await db.execute({ sql: `SELECT wh_id, tag_id, name, category FROM wallhaven_tag WHERE wh_id IN (${ph})`, args: whIds })).rows) {
    (tagsPar.get(String(t.wh_id)) || tagsPar.set(String(t.wh_id), []).get(String(t.wh_id))).push({ id: Number(t.tag_id), name: String(t.name), category: t.category });
  }
  const existantes = new Map();
  for (const r of (await db.execute({ sql: `SELECT anime_id, wh_id FROM wallhaven_image WHERE wh_id IN (${ph})`, args: whIds })).rows) {
    (existantes.get(String(r.wh_id)) || existantes.set(String(r.wh_id), new Set()).get(String(r.wh_id))).add(Number(r.anime_id));
  }
  const ops = [];
  for (const img of lot) {
    const wh = String(img.wh_id);
    images++;
    const tags = tagsPar.get(wh) || [];
    const directs = new Set();
    if (Number(img.tagged_at) > 0) for (const t of tags) for (const id of animesDuTag(t.id, t.name, t.category)) directs.add(id);
    const voulus = new Set();
    for (const id of directs) for (const m of membres(id)) voulus.add(m);
    // Lignes de l'ancienne recherche : gardees si les tags confirment la serie.
    for (const id of existantes.get(wh) || []) {
      if (voulus.has(id)) continue;
      if (Number(img.tagged_at) > 0 && serieConfirmee(tags, titres.get(id) || []) === 1) voulus.add(id);
    }
    if (essai) {
      console.log(wh, "| tags :", tags.map((t) => t.name).join(", ").slice(0, 200));
      console.log("   directs :", [...directs].map((id) => `${id} ${titres.get(id)?.[0]}`).join(" ; "));
      for (const t of tags) {
        const a = animesDuTag(t.id, t.name, t.category);
        if (a.size) console.log(`     <- « ${t.name} » (${defs.get(t.id)?.category || t.category}) : ${[...a].map((id) => titres.get(id)?.[0]).join(", ")}`);
      }
      console.log(`   franchise : ${voulus.size} anime(s)`);
      continue;
    }
    if (voulus.size) attribuees++; else sansAnime++;
    for (const id of existantes.get(wh) || []) {
      if (!voulus.has(id) && Number(img.tagged_at) > 0) {
        ops.push({ sql: "DELETE FROM wallhaven_image WHERE anime_id = ? AND wh_id = ?", args: [id, wh] });
        lignesRetirees++;
      }
    }
    for (const id of voulus) {
      ops.push({
        sql: `INSERT INTO wallhaven_image (anime_id, wh_id, favorites, views, width, height, path, thumb, source, colors,
                wh_created_at, facet_type, has_character, is_scenery, serie_ok, tagged_at, fetched_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)
              ON CONFLICT(anime_id, wh_id) DO UPDATE SET favorites = excluded.favorites, views = excluded.views,
                path = excluded.path, thumb = excluded.thumb, source = excluded.source, facet_type = excluded.facet_type,
                has_character = excluded.has_character, is_scenery = excluded.is_scenery, serie_ok = 1,
                tagged_at = excluded.tagged_at, fetched_at = excluded.fetched_at`,
        args: [id, wh, img.favorites, img.views, img.width, img.height, img.path, img.thumb, img.source, img.colors,
          img.wh_created_at, img.facet_type, img.has_character, img.is_scenery, img.tagged_at, img.fetched_at],
      });
      lignesEcrites++;
    }
    ops.push({ sql: "UPDATE wallhaven_brut SET attribue_at = ? WHERE wh_id = ?", args: [maintenant(), wh] });
  }
  if (essai) break;
  for (let i = 0; i < ops.length; i += 400) await db.batch(ops.slice(i, i + 400), "write");
  process.stderr.write(`\r${images} images : ${attribuees} attribuees, ${sansAnime} sans anime, ${lignesEcrites} lignes ecrites, ${lignesRetirees} retirees`);
}
console.error(`\nfini en ${duree(Date.now() - t0)}`);
