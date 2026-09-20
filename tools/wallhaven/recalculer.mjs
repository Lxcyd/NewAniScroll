#!/usr/bin/env node
/**
 * Recalcule les facettes et la verification de serie depuis les tags DEJA en
 * base. Aucun appel reseau.
 *
 * C'EST LA RAISON D'ETRE DE LA TABLE `wallhaven_tag`. Les tags bruts y sont
 * conserves tels que Wallhaven les a rendus precisement pour que corriger une
 * regle de jugement ne coute pas un re-moissonnage. Sans eux, changer la liste
 * des tags d'illustration ou la comparaison des titres imposerait de re-payer
 * une requete par image — 192 requetes pour le seul One Piece.
 *
 * SON PREMIER USAGE, le jour meme de son ecriture : la comparaison des titres
 * ne reconnaissait pas la serie quand Wallhaven la met entre parentheses apres
 * le personnage — « Uta (One Piece) », « King (One Piece) ». Trois des treize
 * images ecartees de One Piece l'etaient a tort, dont une a 110 favoris. Une
 * image ecartee ne se signale nulle part : on ne trouve ca qu'en allant
 * regarder les verdicts, jamais en relisant le code.
 *
 * Par defaut le script ne fait que COMPTER ce qui changerait. `--apply` ecrit.
 *
 * Usage :
 *   node tools/wallhaven/recalculer.mjs                # simulation
 *   node tools/wallhaven/recalculer.mjs --apply
 *   node tools/wallhaven/recalculer.mjs --anime=21 --apply
 */

import {
  chargerEnv, baseAnime, baseImages, maintenant, duree, avancement,
} from "./socle.mjs";
import {
  facettesDepuisTags, serieConfirmee, titresConnus,
} from "../../lib/wallhaven/criteres.js";

chargerEnv();

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const unSeul = Number((args.find((a) => a.startsWith("--anime=")) || "").slice(8)) || null;

const anime = baseAnime();
const images = baseImages();

/* On ne recalcule que ce qui a DEJA ete tague : une image sans tags n'a pas de
   verdict a reviser, et lui en donner un transformerait une ignorance en
   jugement. */
const animes = (await images.execute({
  sql: `SELECT DISTINCT anime_id FROM wallhaven_image
         WHERE tagged_at IS NOT NULL ${unSeul ? "AND anime_id = ?" : ""}
         ORDER BY anime_id`,
  args: unSeul ? [unSeul] : [],
})).rows;

console.error(`${animes.length} anime(s) avec des images taguees.${apply ? "" : "  [SIMULATION]"}\n`);

const t0 = Date.now();
let vues = 0, changees = 0;
const bascules = { "0->1": 0, "1->0": 0, "facette": 0 };
const exemples = [];

for (const a of animes) {
  const animeId = Number(a.anime_id);

  const meta = (await anime.execute({
    sql: "SELECT data FROM anime WHERE id = ?",
    args: [animeId],
  })).rows[0];
  let data;
  try { data = JSON.parse(String(meta?.data)); } catch { data = null; }
  const titres = data ? titresConnus(data) : [];

  const lignes = (await images.execute({
    sql: `SELECT wh_id, facet_type, has_character, is_scenery, serie_ok
            FROM wallhaven_image WHERE anime_id = ? AND tagged_at IS NOT NULL`,
    args: [animeId],
  })).rows;

  const ops = [];
  for (const l of lignes) {
    const tags = (await images.execute({
      sql: "SELECT tag_id, name, category FROM wallhaven_tag WHERE wh_id = ?",
      args: [l.wh_id],
    })).rows.map((t) => ({
      id: Number(t.tag_id), name: String(t.name), category: t.category ?? null,
    }));

    const f = facettesDepuisTags(tags);
    const ok = serieConfirmee(tags, titres);
    vues++;

    const avantOk = l.serie_ok === null ? null : Number(l.serie_ok);
    const changeSerie = avantOk !== ok;
    const changeFacette =
      (l.facet_type ?? null) !== f.facetType ||
      Number(l.has_character) !== (f.hasCharacter ? 1 : 0) ||
      Number(l.is_scenery) !== (f.isScenery ? 1 : 0);
    if (!changeSerie && !changeFacette) continue;

    changees++;
    if (changeSerie) {
      const cle = `${avantOk}->${ok}`;
      bascules[cle] = (bascules[cle] || 0) + 1;
      if (exemples.length < 12) {
        exemples.push(
          `  anime ${animeId}  ${l.wh_id}  serie ${avantOk} -> ${ok}   ` +
          tags.map((t) => t.name).slice(0, 4).join(" | "),
        );
      }
    }
    if (changeFacette) bascules.facette++;

    ops.push({
      sql: `UPDATE wallhaven_image
               SET facet_type = ?, has_character = ?, is_scenery = ?, serie_ok = ?, tagged_at = ?
             WHERE anime_id = ? AND wh_id = ?`,
      args: [
        f.facetType, f.hasCharacter ? 1 : 0, f.isScenery ? 1 : 0, ok,
        maintenant(), animeId, l.wh_id,
      ],
    });
  }

  if (apply && ops.length) {
    /* Par paquets : un batch de plusieurs milliers d'instructions depasse la
       taille de requete acceptee par Turso. */
    for (let i = 0; i < ops.length; i += 100) {
      await images.batch(ops.slice(i, i + 100), "write");
    }
  }
  avancement(`anime ${animeId}  ${vues} images relues  ${changees} a changer`);
}

console.error(
  `\n\n${apply ? "Applique" : "Simulation"} en ${duree(Date.now() - t0)}.\n` +
  `  images relues        : ${vues}\n` +
  `  images modifiees     : ${changees}\n` +
  `  RATTRAPEES (0 -> 1)  : ${bascules["0->1"] || 0}\n` +
  `  nouvellement ecartees: ${bascules["1->0"] || 0}\n` +
  `  facettes revisees    : ${bascules.facette}`,
);
if (exemples.length) console.error(`\nExemples :\n${exemples.join("\n")}`);
if (!apply && changees) console.error(`\nRelancer avec --apply pour ecrire.`);
