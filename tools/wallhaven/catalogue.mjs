#!/usr/bin/env node
/**
 * Etape 1/3 : TOUTE la categorie Anime de Wallhaven, aux filtres de la galerie
 * (SFW, paysage, au moins 1920x1080), dans `wallhaven_brut`. Aucune recherche
 * par titre : c'est l'etiquetage puis l'attribution qui rattachent chaque
 * image a ses animes (cf. socle.mjs, `preparerChaine`).
 *
 * Tri par date d'ajout DECROISSANTE : une image ajoutee pendant le parcours
 * decale les pages d'un cran — on revoit alors une image, on n'en saute
 * jamais une.
 *
 *   node tools/wallhaven/catalogue.mjs --complet [--minutes=N]
 *       tout le catalogue (88 625 images, 3 693 pages, ~1 h 35), reprenable ;
 *       une fois fini, se comporte comme l'increment
 *   node tools/wallhaven/catalogue.mjs
 *       increment : les pages recentes, jusqu'aux images de plus de 30 jours
 *       (nouveautes + favoris qui bougent encore ; au-dela d'un mois ils ne
 *       bougent plus, mesure du 13/09/2026)
 */
import {
  chargerEnv, baseImages, appel, lireCurseur, ecrireCurseur, maintenant, duree,
  avancement, preparerChaine, colonnesImage, finDeCreneau,
} from "./socle.mjs";
import { CRAWL_MIN_RES, CRAWL_RATIOS } from "../../lib/wallhaven/criteres.js";

chargerEnv();
const args = process.argv.slice(2);
const finA = finDeCreneau(args);
const FENETRE_JOURS = 30;

const db = baseImages();
await preparerChaine(db);
// --complet une fois le catalogue fini = increment : le workflow peut le passer chaque jour.
const curseur = await lireCurseur(db, "catalogue");
const complet = args.includes("--complet") && curseur !== "fini";

const url = (page) =>
  `https://wallhaven.cc/api/v1/search?categories=010&purity=100&atleast=${CRAWL_MIN_RES}` +
  `&ratios=${CRAWL_RATIOS}&sorting=date_added&order=desc&page=${page}`;

async function ecrire(images) {
  const t = maintenant();
  const ops = images.map((w) => {
    const c = colonnesImage(w);
    return {
      sql: `INSERT INTO wallhaven_brut (wh_id, favorites, views, width, height, path, thumb, source, colors, wh_created_at, fetched_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(wh_id) DO UPDATE SET
              -- Des favoris qui bougent : l'image repasse par l'attribution, qui les recopie dans la galerie.
              attribue_at = CASE WHEN wallhaven_brut.favorites <> excluded.favorites THEN NULL ELSE wallhaven_brut.attribue_at END,
              favorites = excluded.favorites, views = excluded.views,
              path = excluded.path, thumb = excluded.thumb, source = excluded.source, fetched_at = excluded.fetched_at`,
      args: [c.wh_id, c.favorites, c.views, c.width, c.height, c.path, c.thumb, c.source, c.colors, c.wh_created_at, t],
    };
  });
  if (ops.length) await db.batch(ops, "write");
}

const t0 = Date.now();
let page = complet ? Number(curseur) || 1 : 1;
let derniere = Infinity, lues = 0, images = 0;
const limiteFenetre = Date.now() - FENETRE_JOURS * 864e5;
while (page <= derniere) {
  if (Date.now() > finA) { console.error("\nfin du creneau — reprise au prochain passage"); break; }
  const j = await appel(url(page));
  if (!j?.data) { console.error(`\npage ${page} illisible — on s'arrete la, reprise au prochain passage`); break; }
  derniere = j.meta?.last_page || derniere;
  await ecrire(j.data);
  lues++; images += j.data.length;
  if (complet) await ecrireCurseur(db, "catalogue", page + 1, `${j.meta?.total} images annoncees`);
  avancement(`page ${page}/${derniere}  ${images} images  ${duree(Date.now() - t0)}`);
  // Increment : on s'arrete des que la page entiere a plus de 30 jours.
  if (!complet && j.data.every((w) => Date.parse(w.created_at) < limiteFenetre)) break;
  page++;
}
if (complet && page > derniere) await ecrireCurseur(db, "catalogue", "fini", "catalogue complet");
console.error(`\n${lues} page(s) lue(s), ${images} images ecrites en ${duree(Date.now() - t0)}`);
