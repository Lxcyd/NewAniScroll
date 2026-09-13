#!/usr/bin/env node
/**
 * Amorcage : aspire les fonds d'ecran Wallhaven du catalogue.
 *
 * ── CE QUI BORNE LA DUREE, ET CE QU'ON PEUT EN FAIRE ──────────────────────
 *
 * Verifie dans la documentation le 13/09/2026, et c'est sans appel :
 * « API calls are currently limited to 45 per minute. » Une cle d'API ne
 * releve PAS cette limite — elle ne debloque que le NSFW et applique les
 * reglages de navigation du compte. Il n'y a donc aucun moyen de demander plus
 * vite ; on ne peut que demander MOINS, et demander l'UTILE D'ABORD.
 *
 * Trois leviers, mesures avant d'etre codes :
 *
 * 1. L'ORDRE DE POPULARITE — de loin le plus utile, et il ne supprime aucune
 *    requete. La premiere version parcourait les animes par ID, c'est-a-dire
 *    dans un ordre sans rapport avec quoi que ce soit : Monster (id 19) etait
 *    moissonne avant tout ce que quelqu'un ouvre vraiment. Par popularite, les
 *    2 000 titres qui portent l'essentiel du trafic sont en base au bout
 *    d'environ une heure et demie, et le reste se remplit tout seul derriere.
 *    La base devient UTILE en une heure au lieu de trente.
 *
 * 2. LA DEDUPLICATION DES REQUETES — 15 %, mesure sur le catalogue entier :
 *    20 851 titres exploitables ne font que 17 822 recherches distinctes.
 *    `requetePourAnime` coupe au sous-titre, donc toutes les saisons, films et
 *    OAV d'une franchise posent la MEME question : 61 entrees Doraemon, 27 One
 *    Piece, 34 Detective Conan. On interroge une fois et on ecrit le resultat
 *    pour chaque membre du groupe — ce que l'ancienne version faisait deja,
 *    mais en re-payant la requete a chaque fois.
 *
 * 3. LE PLAFOND DE PAGES — le plus gros gain sur les grosses franchises.
 *    Monster a rendu 691 images en 29 requetes, One Piece 864 en 36. Or la
 *    galerie n'en affiche que TOP_PAR_TITRE (120) et l'enrichissement n'en
 *    tague que 192 : au-dela de ~10 pages, on payait des requetes pour des
 *    lignes que personne ne verra jamais.
 *
 *    ⚠️ C'est le seul des trois qui CONCEDE quelque chose. Le principe du
 *    dispositif est « aspirer large, juger a la lecture », et un plafond est
 *    un jugement pose a l'ecriture. La concession est rendue reversible : le
 *    `meta.total` annonce par Wallhaven est enregistre pour chaque titre, donc
 *    on SAIT lesquels sont tronques et de combien. `--approfondir` repasse
 *    dessus sans rien re-faire d'autre. On ne perd pas l'information : on
 *    differe sa collecte.
 *
 * ── LE RESTE ──────────────────────────────────────────────────────────────
 *
 * ⛔ AUCUN CRITERE DE TRI N'EST APPLIQUE ICI. Tout ce que Wallhaven rend est
 * ecrit, avec ses compteurs bruts. Le tri vit dans lib/wallhaven/criteres.js et
 * s'applique a la LECTURE, ou le changer ne coute rien — l'ancien
 * lib/wallhaven/artworks.ts filtrait a l'ecriture et en etait a sa sixieme
 * version de cle de cache en deux jours.
 *
 * Reprenable : le curseur avance apres chaque groupe. Ctrl-C, coupure reseau ou
 * redemarrage ne coutent que le groupe en cours.
 *
 * Usage :
 *   node tools/wallhaven/crawl.mjs                  # reprend ou commence
 *   node tools/wallhaven/crawl.mjs --pages=4        # plafond plus bas, plus vite
 *   node tools/wallhaven/crawl.mjs --limite=200     # s'arrete apres 200 groupes
 *   node tools/wallhaven/crawl.mjs --anime=21       # un seul titre
 *   node tools/wallhaven/crawl.mjs --approfondir    # revient sur les tronques
 *   node tools/wallhaven/crawl.mjs --reprise=0      # repart du debut
 */

import {
  chargerEnv, baseAnime, baseImages, appel, preparerProgres,
  lireCurseur, ecrireCurseur, maintenant, duree, avancement,
} from "./socle.mjs";
import {
  requetePourAnime, urlRecherche, PAGE_SIZE, REQUETES_PAR_MINUTE,
} from "../../lib/wallhaven/criteres.js";

chargerEnv();

const args = process.argv.slice(2);
const lireArg = (n) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : null;
};
const limite = Number(lireArg("limite")) || Infinity;
const unSeul = Number(lireArg("anime")) || null;
const approfondir = args.includes("--approfondir");
const repriseArg = lireArg("reprise");

/**
 * Le plafond de pages du PREMIER passage.
 *
 * TROIS, et pas dix — corrige apres mesure. Un essai sur les 25 titres les plus
 * populaires a demande 146 appels : ce sont exactement les titres les plus
 * profonds, donc un plafond haut se paie en entier sur eux. A trois pages (72
 * images) le meme essai en aurait coute une soixantaine.
 *
 * LE RAISONNEMENT QUI LE JUSTIFIE. Ce qui compte n'est pas d'avoir tout, tout
 * de suite : c'est que CHAQUE titre ait de quoi remplir une galerie au plus
 * vite. 72 images valent trois pages d'affichage, et pour l'immense majorite du
 * catalogue c'est deja tout ce que Wallhaven possede. Les grosses franchises
 * sont notees comme tronquees et `--approfondir` revient les completer, par
 * popularite, une fois que le catalogue entier a quelque chose.
 *
 * Autrement dit : on passe d'« un titre complet, puis un autre » a « tous les
 * titres servis, puis on approfondit ». Le second ordre rend la base utile
 * beaucoup plus tot pour le meme travail total.
 */
const PLAFOND_PAGES = Number(lireArg("pages")) || 3;
/** Le garde-fou absolu, pour `--approfondir` : 40 pages = 960 images. */
const MAX_PAGES = 40;

const anime = baseAnime();
const images = baseImages();
await preparerProgres(images);
await creerTables(images);

/* ── Construire les groupes de travail ────────────────────────────────────── */

/**
 * On ne lit ici que les TITRES, jamais les blobs `data` : trois chaines par
 * anime au lieu de 15 ko. C'est ce qui a tue la premiere version — 22 643 blobs
 * font ~340 Mo dans une reponse, et Turso coupe.
 *
 * `popularity` decide de l'ordre, et c'est tout l'enjeu de cette version.
 */
const lignes = (await anime.execute(`
  SELECT id,
         json_extract(data, '$.title.english') AS e,
         json_extract(data, '$.title.romaji')  AS r,
         json_extract(data, '$.title.native')  AS n,
         popularity
    FROM anime
   WHERE is_adult = 0 AND data IS NOT NULL
   ORDER BY popularity DESC NULLS LAST, id`)).rows;

/* Un groupe = une requete Wallhaven + tous les animes qui la posent. L'ordre
   d'insertion dans la Map est celui de la popularite : le premier membre d'un
   groupe est le plus populaire, donc les franchises arrivent tot. */
const groupes = new Map();
let sansRequete = 0;
for (const x of lignes) {
  if (unSeul && Number(x.id) !== unSeul) continue;
  const q = requetePourAnime({ title: { english: x.e, romaji: x.r, native: x.n } });
  if (!q) { sansRequete++; continue; }
  const cle = q.toLowerCase();
  if (!groupes.has(cle)) groupes.set(cle, { q, ids: [] });
  groupes.get(cle).ids.push(Number(x.id));
}

let travail = [...groupes.values()];

if (approfondir) {
  /* Les titres dont on sait qu'on n'a pas tout pris. L'information vient de
     `meta.total`, que Wallhaven donne et que l'ancienne version jetait. */
  const tronques = new Set(
    (await images.execute(`SELECT anime_id FROM wallhaven_titre
                            WHERE total_dispo > images_prises`)).rows.map((x) => Number(x.anime_id)),
  );
  travail = travail.filter((g) => g.ids.some((id) => tronques.has(id)));
  console.error(`APPROFONDISSEMENT : ${travail.length} groupes tronques a reprendre.`);
}

const reprise = repriseArg !== null
  ? Number(repriseArg)
  : (unSeul || approfondir ? 0 : Number(await lireCurseur(images, "crawl")) || 0);
travail = travail.slice(reprise);

console.error(
  `${lignes.length} animes -> ${groupes.size} requetes distinctes ` +
  `(${lignes.length - sansRequete - groupes.size} economisees par regroupement).\n` +
  `Plafond : ${approfondir ? MAX_PAGES : PLAFOND_PAGES} pages par titre.\n` +
  `A traiter : ${travail.length} groupes, par POPULARITE DECROISSANTE — ` +
  `les titres qu'on ouvre vraiment sont faits en premier.\n`,
);
if (!travail.length) process.exit(0);

/* ── Moissonner ───────────────────────────────────────────────────────────── */

const plafond = approfondir ? MAX_PAGES : PLAFOND_PAGES;
const t0 = Date.now();
let faits = 0, ecrites = 0, vides = 0, appels = 0, tronques = 0, animesCouverts = 0;

for (const g of travail) {
  if (faits >= limite) break;

  const brutes = [];
  let total = 0;
  for (let p = 1; p <= plafond; p++) {
    const j = await appel(urlRecherche(g.q, p));
    appels++;
    if (!j) break;
    const d = Array.isArray(j.data) ? j.data : [];
    brutes.push(...d);
    if (p === 1) total = Number(j?.meta?.total) || d.length;
    const derniere = Number(j?.meta?.last_page) || p;
    if (p >= derniere || d.length < PAGE_SIZE) break;
  }

  if (brutes.length) {
    /* LE GAIN DU REGROUPEMENT : une seule recherche, ecrite pour chaque membre.
       C'est le comportement de l'ancienne version — chaque entree d'une
       franchise recevait de toute facon les memes images — mais sans re-payer
       la requete pour chacune. */
    const lot = [];
    for (const id of g.ids) for (const w of brutes) lot.push(versLigne(id, w));
    await ecrireLot(images, lot);
    await noterTitres(images, g, total, brutes.length);
    ecrites += lot.length;
    animesCouverts += g.ids.length;
    if (total > brutes.length) tronques++;
  } else {
    vides++;
    await noterTitres(images, g, total, 0);
  }

  faits++;
  if (!unSeul && !approfondir) await ecrireCurseur(images, "crawl", reprise + faits, `${ecrites} lignes`);

  /* ESTIMATION HAUTE, et il faut le dire. On parcourt par popularite
     decroissante, or la popularite et la profondeur vont de pair : la tete du
     classement est la partie la plus chere du catalogue. Extrapoler le rythme
     courant sur le reste surestime donc systematiquement — la queue coute une
     requete par titre. Le plancher, lui, est certain : une requete par groupe
     restant, a 40 par minute. On montre les deux. */
  const parMin = appels / Math.max((Date.now() - t0) / 60000, 1e-9);
  const restants = travail.length - faits;
  const plancher = (restants / REQUETES_PAR_MINUTE) * 60000;
  const haute = (restants * (appels / faits) / REQUETES_PAR_MINUTE) * 60000;
  avancement(
    `${faits}/${travail.length}  «${g.q.slice(0, 24)}»  ` +
    `${g.ids.length > 1 ? `x${g.ids.length} ` : ""}+${brutes.length}  ` +
    `${animesCouverts} animes  ${appels} app (${parMin.toFixed(0)}/min)  ` +
    `reste ${duree(plancher)}–${duree(haute)}`,
  );
}

console.error(
  `\n\nTermine en ${duree(Date.now() - t0)}.\n` +
  `  groupes traites   : ${faits}\n` +
  `  animes couverts   : ${animesCouverts}\n` +
  `  lignes ecrites    : ${ecrites}\n` +
  `  sans resultat     : ${vides}\n` +
  `  TRONQUES (plafond): ${tronques}   -> node tools/wallhaven/crawl.mjs --approfondir\n` +
  `  appels Wallhaven  : ${appels}`,
);

/* ── Ecriture ─────────────────────────────────────────────────────────────── */

function versLigne(animeId, w) {
  return [
    animeId, String(w.id),
    Number(w.favorites) || 0, Number(w.views) || 0,
    Number(w.dimension_x) || 0, Number(w.dimension_y) || 0,
    String(w.path || ""),
    String(w.thumbs?.large || w.thumbs?.original || w.thumbs?.small || ""),
    w.source ? String(w.source) : null,
    JSON.stringify(w.colors || []),
    w.created_at ? String(w.created_at) : null,
    maintenant(),
  ];
}

/**
 * `ON CONFLICT … DO UPDATE` remet a jour les compteurs sans toucher aux
 * colonnes de tags : une image deja enrichie ne doit pas perdre ses facettes
 * parce qu'on repasse dessus. C'est ce qui rend le moissonneur rejouable, et ce
 * sur quoi `--approfondir` repose.
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
  /* Par paquets : un batch de plusieurs milliers d'instructions depasse la
     taille de requete acceptee par Turso, et une franchise de 61 titres x 200
     images y arrive tres vite. */
  for (let i = 0; i < lignes.length; i += 200) {
    try {
      await db.batch(lignes.slice(i, i + 200).map((args) => ({ sql, args })), "write");
    } catch (e) {
      console.error(`\n  ECHEC d'ecriture : ${e.message}`);
    }
  }
}

/** Ce que Wallhaven annonce contre ce qu'on a pris — la trace de ce qui manque. */
async function noterTitres(db, g, total, prises) {
  const sql = `INSERT INTO wallhaven_titre (anime_id, requete, total_dispo, images_prises, maj_at)
               VALUES (?,?,?,?,?)
               ON CONFLICT(anime_id) DO UPDATE SET
                 requete = excluded.requete, total_dispo = excluded.total_dispo,
                 images_prises = excluded.images_prises, maj_at = excluded.maj_at`;
  try {
    await db.batch(
      g.ids.map((id) => ({ sql, args: [id, g.q, total, prises, maintenant()] })),
      "write",
    );
  } catch {
    /* Perdre cette trace coute un approfondissement moins precis, pas le
       travail lui-meme. */
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
  /* Ce que Wallhaven dit AVOIR, face a ce qu'on a pris. Sans cette table, un
     plafond de pages perdrait silencieusement de l'information ; avec elle, il
     ne fait que la differer. */
  await db.execute(`
    CREATE TABLE IF NOT EXISTS wallhaven_titre (
      anime_id      INTEGER PRIMARY KEY,
      requete       TEXT,
      total_dispo   INTEGER,
      images_prises INTEGER,
      maj_at        INTEGER NOT NULL
    )`);
}
