#!/usr/bin/env node
/**
 * L'increment quotidien : les fonds d'ecran neufs, et les compteurs qui bougent
 * encore. ~9 minutes par jour.
 *
 * POURQUOI PAS UN BALAYAGE GLOBAL DU SITE. Le reflexe serait de lire les
 * nouveautes de Wallhaven (`sorting=date_added`) et de les rattacher a nos
 * animes. Ca ne marche pas : un resultat de recherche NE PORTE PAS ses tags,
 * donc savoir de quel anime parle une image neuve demanderait une requete de
 * plus par image. On fait l'inverse — une rotation de TITRES, page 1 seulement,
 * triee par date d'ajout. Le rattachement est alors gratuit : c'est nous qui
 * avons pose la question.
 *
 * DEUX TRAVAUX, et le second repond a une question precise : « comment
 * recupere-t-on une image qui n'avait pas assez de likes mais en gagne ? »
 *
 *   1. Les nouveautes des titres en cours de diffusion, plus une rotation du
 *      reste du catalogue pour que tout soit revu dans l'annee.
 *   2. La relecture des COMPTEURS des images recentes.
 *
 * La fenetre du second point n'est pas arbitraire, elle est mesuree
 * (13/09/2026) : des le 3e jour, 97 % des images ont depasse 10 favoris, et la
 * mediane ne bouge plus entre 30-60 jours (32) et 120 jours et plus (23). Une
 * image de plus d'un mois a un compteur STABILISE — la relire ne changerait
 * rien. Et la population sous le seuil GROSSIT avec l'age (3 % a une semaine,
 * 13 % au-dela de quatre mois) : une image mal aimee ne se rattrape pas.
 *
 * C'est ce mecanisme qui fait remonter seule une image qui franchit le
 * plancher, sans que rien n'ait jamais ete supprime — le score etant calcule a
 * la lecture, il suffit que `favorites` change.
 *
 * Usage :
 *   node tools/wallhaven/quotidien.mjs
 *   node tools/wallhaven/quotidien.mjs --rotation=40   # part du catalogue revue
 *   node tools/wallhaven/quotidien.mjs --sans-refresh  # nouveautes seulement
 */

import {
  chargerEnv, baseAnime, baseImages, appel, preparerProgres,
  lireCurseur, ecrireCurseur, maintenant, duree, avancement,
  listerIds, parLots,
} from "./socle.mjs";
import {
  requetePourAnime, urlRecherche,
} from "../../lib/wallhaven/criteres.js";

chargerEnv();

const args = process.argv.slice(2);
const lireArg = (n) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : null;
};
const sansRefresh = args.includes("--sans-refresh");

/** Un millieme du catalogue par jour : tout est revu en ~3 ans, ce qui suffit
 *  pour un titre termine depuis longtemps. Reglable. */
const ROTATION = Number(lireArg("rotation")) || 60;

/** Au-dela d'un mois, les favoris ne bougent plus — mesure ci-dessus. */
const FENETRE_JOURS = 30;
/** Borne de la relecture : au-dela, ce n'est plus un increment quotidien. */
const MAX_REFRESH = 400;

const anime = baseAnime();
const images = baseImages();
await preparerProgres(images);

const t0 = Date.now();

/* ── 1. Les nouveautes ────────────────────────────────────────────────────── */

/* Les IDS seuls, les blobs par lots — cf. `parLots` dans socle.mjs. Ici la
   liste est courte, mais `RELEASING` grandit a chaque saison et un blob
   `anime.data` pese ~15 ko : c'est la meme mecanique qui a tue le premier
   moissonnage complet, et rien ne justifie de la laisser en embuscade. */
const enCours = await listerIds(anime, `SELECT id FROM anime
   WHERE is_adult = 0 AND data IS NOT NULL AND status = 'RELEASING'
   ORDER BY popularity DESC NULLS LAST`);

/* La rotation reprend la ou elle s'est arretee, pour parcourir le catalogue
   entier plutot que de repasser sur les memes titres chaque jour. */
const rangRotation = Number(await lireCurseur(images, "rotation")) || 0;
const reste = await listerIds(anime, `SELECT id FROM anime
   WHERE is_adult = 0 AND data IS NOT NULL AND (status IS NULL OR status <> 'RELEASING')
   ORDER BY id LIMIT ? OFFSET ?`, [ROTATION, rangRotation]);
await ecrireCurseur(
  images, "rotation",
  reste.length < ROTATION ? 0 : rangRotation + ROTATION,  // boucle en fin de catalogue
);

const aVoir = [...enCours, ...reste];
console.error(`Nouveautes : ${enCours.length} en diffusion + ${reste.length} en rotation.`);

let neuves = 0, revues = 0;
for await (const ligne of parLots(anime, aVoir)) {
  const id = ligne.id;
  let data;
  try { data = JSON.parse(String(ligne.data)); } catch { continue; }
  const q = requetePourAnime(data);
  if (!q) continue;

  /* Page 1 seulement, triee par date d'AJOUT : ce qui est neuf est en tete.
     Trier par favoris ramenerait les memes images qu'hier. */
  const j = await appel(urlRecherche(q, 1, "date_added"));
  revues++;
  if (!j?.data?.length) continue;

  const lot = j.data.map((w) => [
    id, String(w.id), Number(w.favorites) || 0, Number(w.views) || 0,
    Number(w.dimension_x) || 0, Number(w.dimension_y) || 0,
    String(w.path || ""), String(w.thumbs?.large || ""),
    w.source ? String(w.source) : null, JSON.stringify(w.colors || []),
    w.created_at ? String(w.created_at) : null, maintenant(),
  ]);
  neuves += await inserer(images, lot);
  avancement(`nouveautes ${revues}/${aVoir.length}  anime ${id}  +${neuves} au total`);
}

/* ── 2. Les compteurs des images recentes ─────────────────────────────────── */

let rafraichies = 0, montees = 0;
if (!sansRefresh) {
  const limite = new Date(Date.now() - FENETRE_JOURS * 86400_000)
    .toISOString().slice(0, 19).replace("T", " ");
  const recentes = (await images.execute({
    sql: `SELECT anime_id, wh_id, favorites FROM wallhaven_image
           WHERE wh_created_at IS NOT NULL AND wh_created_at > ?
           ORDER BY wh_created_at DESC LIMIT ?`,
    args: [limite, MAX_REFRESH],
  })).rows;
  console.error(`\nCompteurs : ${recentes.length} images de moins de ${FENETRE_JOURS} jours.`);

  for (const r of recentes) {
    const j = await appel(`https://wallhaven.cc/api/v1/w/${r.wh_id}`);
    if (!j?.data) continue;
    const avant = Number(r.favorites) || 0;
    const apres = Number(j.data.favorites) || 0;
    if (apres !== avant) {
      await images.execute({
        sql: `UPDATE wallhaven_image SET favorites = ?, views = ?
               WHERE anime_id = ? AND wh_id = ?`,
        args: [apres, Number(j.data.views) || 0, Number(r.anime_id), r.wh_id],
      });
      if (apres > avant) montees++;
    }
    rafraichies++;
    avancement(`compteurs ${rafraichies}/${recentes.length}  ${montees} en hausse`);
  }
}

console.error(
  `\n\nTermine en ${duree(Date.now() - t0)}.\n` +
  `  titres revus      : ${revues}\n` +
  `  images nouvelles  : ${neuves}\n` +
  `  compteurs relus   : ${rafraichies}\n` +
  `  dont en hausse    : ${montees}`,
);

/**
 * N'ecrit que ce qui n'existe PAS deja.
 *
 * `DO NOTHING` et non `DO UPDATE` : ce passage cherche des nouveautes, et
 * ecraser une ligne existante lui ferait perdre ses facettes et son `serie_ok`
 * pour rien. Les compteurs sont la responsabilite du second travail.
 */
async function inserer(db, lignes) {
  if (!lignes.length) return 0;
  const sql = `
    INSERT INTO wallhaven_image
      (anime_id, wh_id, favorites, views, width, height, path, thumb,
       source, colors, wh_created_at, fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(anime_id, wh_id) DO NOTHING`;
  try {
    const r = await db.batch(lignes.map((args) => ({ sql, args })), "write");
    return r.reduce((n, x) => n + (x.rowsAffected || 0), 0);
  } catch {
    return 0;
  }
}
