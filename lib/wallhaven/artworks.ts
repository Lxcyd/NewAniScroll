/**
 * Wallhaven, troisième pourvoyeur d'illustrations — après fanart.tv et TMDB.
 *
 * Ce que les deux autres ne donnent pas : Wallhaven sert des fonds d'écran, en
 * 16/9 et jusqu'à 7680×4320, là où fanart.tv plafonne à 1920×1080 par
 * spécification et où TMDB tire surtout des images de production. Pour un fond
 * de profil, c'est le format qui convient.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CE FICHIER N'APPELLE PLUS WALLHAVEN. Il lit une table.
 *
 * Il l'a appelé en direct jusqu'au 13/09/2026, et c'était le seul de nos trois
 * pourvoyeurs dans ce cas. Le problème n'était pas la latence : Wallhaven
 * limite à **45 requêtes par minute et par IP**, et cette IP était celle de la
 * lambda — donc partagée par TOUS les visiteurs à la fois. Quatre fiches
 * froides ouvertes en même temps suffisaient à la faire sauter, et un 429 rend
 * une galerie vide.
 *
 * S'y ajoutait un défaut plus insidieux. Les critères de tri s'appliquaient à
 * l'ÉCRITURE du cache, si bien que changer un seuil imposait de tout
 * re-télécharger : ce fichier en était à sa **sixième version de clé en deux
 * jours**, dont trois bumps qui ne réglaient qu'un chiffre, chacun invalidant
 * trente jours de galeries pour tous les titres déjà consultés.
 *
 * Les deux problèmes ont la même réponse : `tools/wallhaven/` moissonne depuis
 * le poste et écrit TOUT sans rien juger ; les critères vivent dans
 * `lib/wallhaven/criteres.js` et s'appliquent à la LECTURE, où les changer ne
 * coûte rien et n'invalide rien.
 *
 * Ce qui en découle pour ce fichier :
 *   • plus aucun appel sortant, donc plus de quota ni de 429 ;
 *   • plus de cache applicatif — la table EST le cache, et elle ne périme pas ;
 *   • plus de `CACHE_VERSION` à bumper ;
 *   • le total réel est enfin connu (Wallhaven le donnait dans `meta.total`,
 *     l'ancien code le jetait) ;
 *   • les images hors sujet sont écartées, ce qu'aucun réglage ne permettait.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * CE QUI N'A PAS CHANGÉ, et reste vrai :
 *
 * Ce ne sont PAS des visuels officiels. Ce sont des fonds d'écran déposés par
 * des utilisateurs, souvent retouchés. Le champ `source` pointe l'auteur
 * d'origine (DeviantArt, Pixiv…) et on le conserve : c'est la seule de nos
 * trois sources qui permette de créditer, et « All images remain property of
 * their original owners » est la condition posée par le site. C'est aussi la
 * raison pour laquelle ces images arrivent sous un type À ELLES (`wallpaper`)
 * plutôt que fondues dans `background`.
 *
 * Tout dégrade vers une liste vide ; rien ne lève.
 */

import { lireGalerie, compterFacettes, type Facette } from "@/lib/db/wallhavenImages";

/** Une entrée de galerie. Même forme que TmdbArtwork et FanartItem, pour que
 *  les onglets fusionnent les trois listes sans couche de traduction. */
export interface WallhavenArtwork {
  /** La vignette (`thumbs.large`, ~500 px) — la grille en affiche des dizaines. */
  url: string;
  /** Son type à elle : ce n'est pas un visuel officiel, cf. la note ci-dessus. */
  type: "wallpaper";
  /** Toujours nul : Wallhaven n'étiquette pas la langue d'une image. */
  language: null;
  /** `favorites` — un vrai décompte, contrairement à la note sur 10 de TMDB. */
  likes: number;
  season: null;
  /** L'image entière, celle qui part en fond. */
  fullUrl: string;
  /** Les DIMENSIONS RÉELLES, que ni fanart.tv ni TMDB ne nous donnent. C'est ce
   *  qui rend un classement par qualité possible sur ces lignes-là. */
  width: number;
  height: number;
  /** L'auteur d'origine quand Wallhaven le connaît — pour créditer. */
  source: string | null;
  /** La nature de l'image, dérivée de ses tags. `null` = pas encore enrichie. */
  facetType: "illustration" | "capture" | null;
  /** Les cinq couleurs dominantes que Wallhaven calcule. L'ancien code les
   *  jetait ; elles servent à teinter la plaque autour de l'image. */
  colors: string[];
}

/** Une page de galerie, telle que le client la consomme. */
export type WallhavenPage = {
  arts: WallhavenArtwork[];
  hasMore: boolean;
  /** Le nombre d'images disponibles pour ce titre sous les critères courants. */
  total: number;
  /** Combien d'images derrière chaque bouton de facette — pour n'afficher que
   *  ceux qui mènent quelque part. Un bouton « Capture » vide est un bouton qui
   *  ment. */
  facettes: Record<Facette, number>;
};

export type { Facette };

const VIDE: WallhavenPage = {
  arts: [],
  hasMore: false,
  total: 0,
  facettes: { tout: 0, illustration: 0, capture: 0, personnage: 0, paysage: 0 },
};

/** La taille d'une page de galerie. Inchangée : c'est ce que la grille déroule. */
const PAR_PAGE = 24;

/**
 * UNE page d'illustrations Wallhaven.
 *
 * La pagination survit au changement de dos, pour la raison d'origine : One
 * Piece a 864 images sous nos paramètres de moisson. Ce qui change, c'est que
 * dérouler ne coûte plus rien — auparavant chaque page était une requête
 * sortante contre un quota partagé, c'est désormais une lecture indexée.
 *
 * Les décomptes de facettes ne sont calculés QUE pour la première page : ils
 * portent sur le titre entier et ne bougent pas d'une page à l'autre, donc les
 * recalculer à chaque défilement doublerait les lignes lues pour rien.
 *
 * Rend une page vide sur tout échec ; ne lève jamais.
 */
export async function getWallhavenArtworks(
  anilistId: number,
  page = 1,
  facette: Facette = "tout",
): Promise<WallhavenPage> {
  if (!Number.isFinite(anilistId) || anilistId <= 0) return VIDE;
  const p = Math.max(1, Math.floor(page));

  try {
    const [res, facettes] = await Promise.all([
      lireGalerie(anilistId, p, PAR_PAGE, facette),
      p === 1 ? compterFacettes(anilistId) : Promise.resolve(VIDE.facettes),
    ]);
    return {
      arts: res.arts.map((l) => ({
        url: l.url,
        type: "wallpaper" as const,
        language: null,
        likes: l.likes,
        season: null,
        fullUrl: l.fullUrl,
        width: l.width,
        height: l.height,
        source: l.source,
        facetType: l.facetType,
        colors: l.colors,
      })),
      hasMore: res.hasMore,
      total: res.total,
      facettes,
    };
  } catch {
    /* La galerie s'affiche très bien avec fanart.tv et TMDB seuls — c'est le
       comportement voulu depuis le premier jour. */
    return VIDE;
  }
}
