#!/usr/bin/env node
/**
 * Enrichissement : va chercher les tags de chaque image et en derive les
 * facettes et la verification de serie.
 *
 * POURQUOI C'EST UN SCRIPT A PART. Les tags ne sont PAS dans les resultats de
 * recherche : il faut une requete par image (`/api/v1/w/{id}`). A 45 requetes
 * par minute depuis une lambda, c'etait hors de question ; depuis le poste,
 * c'est ~57 600 images par jour. Le temps est la seule ressource dont on
 * dispose en abondance depuis que tout ceci a quitte Vercel.
 *
 * CE QUE LES TAGS APPORTENT, et qu'aucun autre champ ne donne :
 *
 * 1. LES FACETTES de la galerie — Illustration / Capture / Personnage /
 *    Paysage. Mesure : 24,2 tags par image, que l'API classe elle-meme
 *    (`Characters` domine largement). C'est ce que ni fanart.tv ni TMDB ne
 *    permettront jamais : eux n'ont pas de vocabulaire.
 * 2. LA VERIFICATION DE SERIE. La recherche Wallhaven est textuelle, donc elle
 *    ramene d'autres animes : dans les 864 resultats de « one piece » on trouve
 *    Sakura Miko (Hololive) et Nishikino Maki (Love Live!), bien notees et bien
 *    creditees. Aucun signal de QUALITE ne peut voir ca — ce n'est pas un
 *    defaut de qualite.
 * 3. LE RATTRAPAGE d'une bonne image non creditee : sur le corpus One Piece,
 *    une image a 13 favoris que les deux autres signaux condamnaient remonte a
 *    27 points grace a son tag `fan art`.
 *
 * Il descend le catalogue PAR POPULARITE : les titres qu'on ouvre vraiment sont
 * enrichis en premier. Arretable a tout moment — ce qui est tague reste tague,
 * et une image non taguee reste affichee (cf. `serie_ok IS NULL`).
 *
 * Usage :
 *   node tools/wallhaven/tags.mjs                  # descend la liste, sans fin
 *   node tools/wallhaven/tags.mjs --limite=2000    # s'arrete apres 2000 images
 *   node tools/wallhaven/tags.mjs --anime=21       # un seul titre
 *   node tools/wallhaven/tags.mjs --profondeur=0   # TOUTES les images, pas que
 *                                                  # celles qui s'affichent
 */

import {
  chargerEnv, baseAnime, baseImages, appel, preparerProgres,
  lireCurseur, ecrireCurseur, maintenant, duree, avancement,
  listerIds, parLots,
} from "./socle.mjs";
import {
  urlFiche, facettesDepuisTags, serieConfirmee, titresConnus,
  scoreDe, TOP_PAR_TITRE,
} from "../../lib/wallhaven/criteres.js";

chargerEnv();

const args = process.argv.slice(2);
const lireArg = (n) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : null;
};
const limite = Number(lireArg("limite")) || Infinity;
const unSeul = Number(lireArg("anime")) || null;

/**
 * Jusqu'ou taguer dans un titre.
 *
 * Par defaut on s'arrete a ce que la galerie peut afficher : taguer les 864
 * images de One Piece quand 120 seulement sont montrables serait payer sept
 * fois le prix pour rien. `--profondeur=0` leve la borne, pour le jour ou on
 * voudra elargir l'affichage.
 *
 * La selection se fait sur le score PROVISOIRE — sans tags, forcement, puisque
 * c'est ce qu'on va chercher. C'est une approximation assumee : une image que
 * son tag aurait fait monter dans le top peut rester hors de portee. Le
 * multiplicateur maximal etant 1,5, on tague avec une marge de securite.
 */
const MARGE = 1.6;
const profondeurArg = lireArg("profondeur");
const profondeur = profondeurArg === null
  ? Math.ceil(TOP_PAR_TITRE * MARGE)
  : Number(profondeurArg) || 0;

const anime = baseAnime();
const images = baseImages();
await preparerProgres(images);

/* L'ordre de travail vient de la base METADONNEES (popularite), les images de
   la base IMAGES : les deux peuvent etre des bases distinctes, donc pas de
   jointure possible. On boucle titre par titre. */
const curseur = Number(await lireCurseur(images, "tags")) || 0;
/* Les IDS d'abord, les blobs par lots — cf. `parLots` dans socle.mjs. Demander
   les 22 643 `data` d'un coup fait ~340 Mo de reponse et Turso coupe la
   communication ; le premier moissonnage est mort la-dessus. */
const ids = unSeul
  ? [unSeul]
  : await listerIds(anime, `SELECT id FROM anime
                             WHERE is_adult = 0 AND data IS NOT NULL
                             ORDER BY popularity DESC NULLS LAST, id`);

/* Le curseur est un RANG dans ce classement, pas un id : le classement par
   popularite est stable d'un passage a l'autre, et reprendre a un id
   obligerait a re-parcourir la liste pour le retrouver. */
const depart = unSeul ? 0 : Math.min(curseur, ids.length);
console.error(
  `${ids.length} titres classes par popularite, reprise au rang ${depart}.\n` +
  `Profondeur : ${profondeur || "toutes les images"} par titre.\n`,
);

const t0 = Date.now();
let taguees = 0, confirmees = 0, dementies = 0, illus = 0, captures = 0, titresVus = 0;
let rang = depart - 1;

for await (const ligne of parLots(anime, ids.slice(depart))) {
  rang++;
  if (taguees >= limite) break;
  const id = ligne.id;
  let data;
  try { data = JSON.parse(String(ligne.data)); } catch { data = null; }
  const titres = data ? titresConnus(data) : [];

  const aFaire = await imagesATaguer(images, id, profondeur);
  titresVus++;
  if (!unSeul) await ecrireCurseur(images, "tags", rang, `${taguees} images`);
  if (!aFaire.length) continue;

  for (const img of aFaire) {
    if (taguees >= limite) break;
    const j = await appel(urlFiche(img.wh_id));
    /* Echec ponctuel : on laisse `tagged_at` a NULL, donc l'image reste
       affichee et sera reproposee au prochain passage. Ne jamais ecrire un
       verdict qu'on n'a pas obtenu. */
    if (!j?.data) continue;

    const tags = (j.data.tags || []).map((t) => ({
      id: Number(t.id) || 0, name: String(t.name || ""), category: t.category ?? null,
    }));
    const f = facettesDepuisTags(tags);
    const ok = serieConfirmee(tags, titres);

    await ecrire(images, img.wh_id, id, tags, f, ok);

    taguees++;
    if (ok === 1) confirmees++;
    if (ok === 0) dementies++;
    if (f.facetType === "illustration") illus++;
    if (f.facetType === "capture") captures++;

    const parSec = taguees / ((Date.now() - t0) / 1000);
    avancement(
      `rang ${rang}/${ids.length}  anime ${id}  ${taguees} taguees  ` +
      `serie ok ${confirmees} / hors-sujet ${dementies}  ` +
      `illu ${illus} capt ${captures}  ${(parSec * 3600).toFixed(0)}/h`,
    );
  }
}

console.error(
  `\n\nTermine en ${duree(Date.now() - t0)}.\n` +
  `  titres parcourus : ${titresVus}\n` +
  `  images taguees   : ${taguees}\n` +
  `  serie confirmee  : ${confirmees}\n` +
  `  HORS-SUJET ecart.: ${dementies}\n` +
  `  illustrations    : ${illus}\n` +
  `  captures         : ${captures}`,
);

/* ── Selection ────────────────────────────────────────────────────────────── */

/**
 * Les images d'un titre qui meritent une requete : pas encore taguees, et dans
 * la profondeur retenue. Le tri reproduit le score provisoire en SQL plutot que
 * de rapatrier toutes les lignes pour les classer en memoire.
 */
async function imagesATaguer(db, animeId, prof) {
  const sql = `
    SELECT wh_id, favorites, width, height, source
      FROM wallhaven_image
     WHERE anime_id = ? AND tagged_at IS NULL
     ORDER BY favorites * (CASE WHEN source IS NOT NULL AND source <> '' THEN 1.4 ELSE 1.0 END) DESC
     ${prof ? "LIMIT ?" : ""}`;
  try {
    const r = await db.execute({ sql, args: prof ? [animeId, prof] : [animeId] });
    return r.rows;
  } catch {
    return [];
  }
}

/* ── Ecriture ─────────────────────────────────────────────────────────────── */

/**
 * Les tags bruts ET les facettes, dans la meme transaction.
 *
 * Les bruts sont conserves pour que corriger la regle de repliage — si
 * « Capture » montre autre chose que des captures — ne demande aucun
 * re-moissonnage : il suffira de recalculer depuis `wallhaven_tag`.
 *
 * `tagged_at` est pose meme quand l'image n'a AUCUN tag : Wallhaven a repondu,
 * la reponse est « pas de tags », et la reposer ne changerait rien. C'est
 * `serie_ok` qui reste alors a NULL, faute de quoi juger.
 */
async function ecrire(db, whId, animeId, tags, facettes, serieOk) {
  const ops = [
    {
      sql: `UPDATE wallhaven_image
               SET facet_type = ?, has_character = ?, is_scenery = ?,
                   serie_ok = ?, tagged_at = ?
             WHERE anime_id = ? AND wh_id = ?`,
      args: [
        facettes.facetType,
        facettes.hasCharacter ? 1 : 0,
        facettes.isScenery ? 1 : 0,
        serieOk,
        maintenant(),
        animeId,
        whId,
      ],
    },
  ];
  for (const t of tags) {
    if (!t.id || !t.name) continue;
    ops.push({
      sql: `INSERT INTO wallhaven_tag (wh_id, tag_id, name, category)
            VALUES (?,?,?,?)
            ON CONFLICT(wh_id, tag_id) DO UPDATE SET
              name = excluded.name, category = excluded.category`,
      args: [whId, t.id, t.name, t.category],
    });
  }
  try {
    await db.batch(ops, "write");
  } catch (e) {
    console.error(`\n  ECHEC d'ecriture sur ${whId} : ${e.message}`);
  }
}
