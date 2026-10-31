#!/usr/bin/env node
/**
 * Etape 2/3 : les tags de chaque image de `wallhaven_brut`, UNE requete par
 * image (`/api/v1/w/{id}`, seule source des tags). Les plus aimees d'abord :
 * ce sont celles que la galerie montre.
 *
 * Une image sous MIN_FAVORIS n'est pas etiquetee : le plancher d'affichage
 * (PLANCHER_DUR, 10 points) multiplie au plus les favoris par 1,4 x 1,2 x 1,5
 * (lib/wallhaven/criteres.js) — sous 4 favoris, elle ne s'affichera jamais.
 *
 * Ecrit : `wallhaven_tag` (lien image -> tag, avec nom et categorie),
 * `wallhaven_tag_def` (le tag et ses ALIAS, que l'attribution compare aux
 * titres AniList), et les facettes de l'image.
 *
 *   node tools/wallhaven/etiquette.mjs [--minutes=N] [--limite=N]
 */
import {
  chargerEnv, baseImages, appel, maintenant, duree, avancement, preparerChaine, finDeCreneau,
} from "./socle.mjs";
import { urlFiche, facettesDepuisTags } from "../../lib/wallhaven/criteres.js";

chargerEnv();
const args = process.argv.slice(2);
const finA = finDeCreneau(args);
const limite = Number(args.find((a) => a.startsWith("--limite="))?.slice(9)) || Infinity;
const MIN_FAVORIS = 4;

const db = baseImages();
await preparerChaine(db);

const t0 = Date.now();
let faites = 0, echecs = 0;
const vus = new Set(); // tags deja ecrits dans wallhaven_tag_def pendant ce passage
for (;;) {
  if (Date.now() > finA || faites >= limite) break;
  const lot = (await db.execute({
    sql: `SELECT wh_id FROM wallhaven_brut WHERE tagged_at IS NULL AND favorites >= ?
           ORDER BY favorites DESC LIMIT 100`,
    args: [MIN_FAVORIS],
  })).rows.map((r) => String(r.wh_id));
  if (!lot.length) { console.error("\nplus rien a etiqueter"); break; }
  let progres = 0;
  for (const whId of lot) {
    if (Date.now() > finA || faites >= limite) break;
    const j = await appel(urlFiche(whId));
    if (!j?.data) {
      /* Image retiree de Wallhaven (404) ou echec ponctuel : on la marque quand
         meme, sans tags, pour ne pas la redemander a chaque lot. L'attribution
         n'en fera rien ; une image retiree n'a de toute facon plus d'adresse. */
      echecs++;
      await db.execute({ sql: "UPDATE wallhaven_brut SET tagged_at = ? WHERE wh_id = ?", args: [-maintenant(), whId] });
      continue;
    }
    const tags = (j.data.tags || []).filter((t) => t?.id && t?.name);
    const f = facettesDepuisTags(tags);
    const ops = [
      { sql: "DELETE FROM wallhaven_tag WHERE wh_id = ?", args: [whId] },
      ...tags.map((t) => ({
        sql: "INSERT INTO wallhaven_tag (wh_id, tag_id, name, category) VALUES (?,?,?,?) ON CONFLICT(wh_id, tag_id) DO NOTHING",
        args: [whId, Number(t.id), String(t.name), t.category ?? null],
      })),
      ...tags.filter((t) => !vus.has(t.id)).map((t) => ({
        sql: `INSERT INTO wallhaven_tag_def (tag_id, name, alias, category, category_id) VALUES (?,?,?,?,?)
              ON CONFLICT(tag_id) DO UPDATE SET name = excluded.name, alias = excluded.alias, category = excluded.category`,
        args: [Number(t.id), String(t.name), t.alias || null, t.category ?? null, t.category_id ?? null],
      })),
      {
        sql: `UPDATE wallhaven_brut SET facet_type = ?, has_character = ?, is_scenery = ?, tagged_at = ?, attribue_at = NULL,
                favorites = ?, views = ? WHERE wh_id = ?`,
        args: [f.facetType, f.hasCharacter ? 1 : 0, f.isScenery ? 1 : 0, maintenant(),
          Number(j.data.favorites) || 0, Number(j.data.views) || 0, whId],
      },
    ];
    try {
      await db.batch(ops, "write");
      for (const t of tags) vus.add(t.id);
      faites++; progres++;
    } catch (e) {
      echecs++;
      console.error(`\n  ECHEC d'ecriture sur ${whId} : ${e.message}`);
    }
    avancement(`${faites} etiquetees, ${echecs} echecs, ${duree(Date.now() - t0)}`);
  }
  // Un lot entier en echec d'ecriture : on ne boucle pas a l'infini sur les memes images.
  if (!progres && lot.length) break;
}
console.error(`\n${faites} image(s) etiquetee(s), ${echecs} echec(s), en ${duree(Date.now() - t0)}`);
