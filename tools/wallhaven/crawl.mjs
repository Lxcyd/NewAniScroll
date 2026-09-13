#!/usr/bin/env node
/**
 * Amorcage : aspire les fonds d'ecran Wallhaven de TOUT le catalogue.
 *
 * A lancer une fois. ~28 h pour 22 643 animes a 40 requetes/minute — une nuit
 * et une matinee. Reprenable : un curseur avance apres chaque anime, donc
 * Ctrl-C, coupure reseau ou redemarrage ne coutent que l'anime en cours.
 *
 * ⛔ CE SCRIPT N'APPLIQUE AUCUN CRITERE DE TRI. Il ecrit TOUT ce que Wallhaven
 * rend, avec ses compteurs bruts. C'est la regle centrale du dispositif, et
 * elle vient d'une erreur precise : l'ancien lib/wallhaven/artworks.ts filtrait
 * a l'ecriture, si bien que changer un seuil imposait de re-telecharger trente
 * jours de galeries — ce qui est arrive six fois en deux jours. Ici le tri vit
 * dans lib/wallhaven/criteres.js et s'applique a la LECTURE.
 *
 * Le SEUL jugement porte ici est celui qui part dans l'URL (resolution minimale
 * et ratio paysage), parce qu'il ecarte avant que l'image ne nous parvienne :
 * c'est la seule decision non rattrapable, et c'est pourquoi elle est prise
 * large (1920x1080 alors qu'on affiche a partir de 2560x1440).
 *
 * Usage :
 *   node tools/wallhaven/crawl.mjs                 # reprend ou commence
 *   node tools/wallhaven/crawl.mjs --depuis=21     # force un point de depart
 *   node tools/wallhaven/crawl.mjs --limite=50     # s'arrete apres 50 animes
 *   node tools/wallhaven/crawl.mjs --anime=21      # un seul titre (mise au point)
 */

import {
  chargerEnv, baseAnime, baseImages, appel, preparerProgres,
  lireCurseur, ecrireCurseur, maintenant, duree, avancement,
} from "./socle.mjs";
import {
  requetePourAnime, urlRecherche, PAGE_SIZE,
} from "../../lib/wallhaven/criteres.js";

chargerEnv();

const args = process.argv.slice(2);
const lireArg = (n) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : null;
};
const depuisArg = Number(lireArg("depuis"));
const limite = Number(lireArg("limite")) || Infinity;
const unSeul = Number(lireArg("anime")) || null;

/**
 * Bornes de pagination.
 *
 * Wallhaven annonce lui-meme `meta.last_page` — que l'ancien code ignorait,
 * d'ou quatre reglages successifs de « combien d'images garder » en deux jours
 * alors que la reponse etait dans la charge utile. MAX_PAGES reste un garde-fou
 * contre un titre pathologique : 40 pages font 960 images, au-dela c'est que la
 * requete est trop generique et ramene autre chose.
 */
const MAX_PAGES = 40;

const anime = baseAnime();
const images = baseImages();
await preparerProgres(images);
await creerTables(images);

/* On ne moissonne pas l'adulte : la galerie ne l'affiche pas, et Wallhaven
   refuse de toute facon le non-SFW sans cle d'API. */
const titres = unSeul
  ? (await anime.execute({ sql: "SELECT id, data FROM anime WHERE id = ?", args: [unSeul] })).rows
  : (await anime.execute({
      sql: `SELECT id, data FROM anime
             WHERE is_adult = 0 AND data IS NOT NULL AND id > ?
             ORDER BY id`,
      args: [Number.isFinite(depuisArg) ? depuisArg : Number(await lireCurseur(images, "crawl")) || 0],
    })).rows;

console.error(`${titres.length} animes a traiter.`);
if (!titres.length) process.exit(0);

const t0 = Date.now();
let traites = 0, ecrites = 0, sansRequete = 0, vides = 0, appels = 0;

for (const ligne of titres) {
  if (traites >= limite) break;
  const id = Number(ligne.id);
  let data;
  try { data = JSON.parse(String(ligne.data)); } catch { data = null; }

  const q = data ? requetePourAnime(data) : null;
  if (!q) {
    /* Pas de titre exploitable : ce n'est pas une reponse de Wallhaven, on
       n'ecrit rien. Le curseur avance quand meme — reposer la question au
       prochain passage donnerait le meme resultat. */
    sansRequete++;
    traites++;
    if (!unSeul) await ecrireCurseur(images, "crawl", id);
    continue;
  }

  const lot = [];
  let derniere = 1;
  for (let p = 1; p <= MAX_PAGES; p++) {
    const j = await appel(urlRecherche(q, p));
    appels++;
    if (!j) break;
    const d = Array.isArray(j.data) ? j.data : [];
    for (const w of d) lot.push(versLigne(id, w));
    derniere = Number(j?.meta?.last_page) || p;
    if (p >= derniere || d.length < PAGE_SIZE) break;
  }

  if (lot.length) {
    await ecrireLot(images, lot);
    ecrites += lot.length;
  } else {
    vides++;
  }

  traites++;
  if (!unSeul) await ecrireCurseur(images, "crawl", id, `${ecrites} images`);

  const parSec = traites / ((Date.now() - t0) / 1000);
  const reste = (titres.length - traites) / Math.max(parSec, 1e-9);
  avancement(
    `${traites}/${titres.length}  anime ${id}  «${q.slice(0, 28)}»  ` +
    `+${lot.length}  total ${ecrites}  ${appels} appels  reste ~${duree(reste * 1000)}`,
  );
}

console.error(
  `\n\nTermine en ${duree(Date.now() - t0)}.\n` +
  `  animes traites  : ${traites}\n` +
  `  images ecrites  : ${ecrites}\n` +
  `  sans titre util : ${sansRequete}\n` +
  `  sans resultat   : ${vides}\n` +
  `  appels Wallhaven: ${appels}`,
);

/* ── Ecriture ─────────────────────────────────────────────────────────────── */

function versLigne(animeId, w) {
  return [
    animeId,
    String(w.id),
    Number(w.favorites) || 0,
    Number(w.views) || 0,
    Number(w.dimension_x) || 0,
    Number(w.dimension_y) || 0,
    String(w.path || ""),
    String(w.thumbs?.large || w.thumbs?.original || w.thumbs?.small || ""),
    w.source ? String(w.source) : null,
    JSON.stringify(w.colors || []),
    w.created_at ? String(w.created_at) : null,
    maintenant(),
  ];
}

/**
 * Ecrit un lot en une transaction.
 *
 * `ON CONFLICT … DO UPDATE` remet a jour les compteurs sans toucher aux
 * colonnes de tags : une image deja enrichie ne doit pas perdre ses facettes
 * parce qu'on repasse dessus. C'est ce qui rend le moissonneur rejouable.
 */
async function ecrireLot(db, lignes) {
  const sql = `
    INSERT INTO wallhaven_image
      (anime_id, wh_id, favorites, views, width, height, path, thumb,
       source, colors, wh_created_at, fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(anime_id, wh_id) DO UPDATE SET
      favorites  = excluded.favorites,
      views      = excluded.views,
      path       = excluded.path,
      thumb      = excluded.thumb,
      source     = excluded.source,
      fetched_at = excluded.fetched_at`;
  try {
    await db.batch(lignes.map((args) => ({ sql, args })), "write");
  } catch (e) {
    console.error(`\n  ECHEC d'ecriture (${lignes.length} lignes) : ${e.message}`);
  }
}

async function creerTables(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS wallhaven_image (
      anime_id      INTEGER NOT NULL,
      wh_id         TEXT    NOT NULL,
      favorites     INTEGER NOT NULL,
      views         INTEGER,
      width         INTEGER NOT NULL,
      height        INTEGER NOT NULL,
      path          TEXT    NOT NULL,
      thumb         TEXT    NOT NULL,
      source        TEXT,
      colors        TEXT,
      wh_created_at TEXT,
      facet_type    TEXT,
      has_character INTEGER,
      is_scenery    INTEGER,
      serie_ok      INTEGER,
      tagged_at     INTEGER,
      fetched_at    INTEGER NOT NULL,
      PRIMARY KEY (anime_id, wh_id)
    )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_wh_anime ON wallhaven_image(anime_id, favorites DESC)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_wh_atag  ON wallhaven_image(tagged_at)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_wh_frais ON wallhaven_image(wh_created_at)`);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS wallhaven_tag (
      wh_id    TEXT NOT NULL,
      tag_id   INTEGER NOT NULL,
      name     TEXT NOT NULL,
      category TEXT,
      PRIMARY KEY (wh_id, tag_id)
    )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_whtag_nom ON wallhaven_tag(name)`);
}
