/**
 * Wallhaven, troisième pourvoyeur d'illustrations — après fanart.tv et TMDB.
 *
 * Ce que les deux autres ne donnent pas : Wallhaven sert des fonds d'écran, en
 * 16/9 et jusqu'à 7680×4320, là où fanart.tv plafonne à 1920×1080 par
 * spécification et où TMDB tire surtout des images de production. Pour un fond
 * de profil, c'est le format qui convient.
 *
 * TROIS DIFFÉRENCES DE NATURE, qui décident de tout le reste du fichier.
 *
 * 1. C'EST UNE RECHERCHE TEXTE, pas un identifiant. fanart.tv et TMDB sont
 *    indexés sur l'anime ; Wallhaven cherche des mots. Un titre distinctif
 *    (« sousou no frieren » → 409 résultats) est sûr, un titre générique
 *    ramènera des images d'autre chose, et aucun réglage ne supprime ça. C'est
 *    la raison pour laquelle ces images arrivent sous un type À ELLES
 *    (`wallpaper`) plutôt que fondues dans `background` : le lecteur doit
 *    pouvoir les distinguer des visuels officiels, et nous pouvoir les écarter
 *    d'un filtre si la pertinence déçoit.
 *
 * 2. 45 REQUÊTES PAR MINUTE, PAR IP — et cette IP est celle de la lambda,
 *    partagée par tous les visiteurs. Au-delà, 429. D'où : un nombre de pages
 *    borné et jamais un appel par titre alternatif, un cache de 30 jours, et un
 *    429 qui n'est JAMAIS mis en cache — sinon un pic de trafic d'une minute
 *    graverait « pas d'images » pour un mois.
 *
 * 3. CE NE SONT PAS DES VISUELS OFFICIELS. Ce sont des fonds d'écran déposés
 *    par des utilisateurs, souvent retouchés. Le champ `source` de l'API pointe
 *    l'auteur d'origine (DeviantArt, Pixiv…) et on le conserve : c'est la seule
 *    de nos trois sources qui permette de créditer, et « All images remain
 *    property of their original owners » est la condition posée par le site.
 *
 * Le NSFW n'est pas un risque à gérer ici : sans clé d'API, Wallhaven REFUSE le
 * contenu non-SFW par un 401. `purity=100` et `categories=010` disent ce qu'on
 * veut, mais c'est le serveur qui l'impose, pas nous.
 *
 * Tout dégrade vers une liste vide ; rien ne lève.
 */

import { getCachedJson, setCachedJson } from "@/lib/db/tmdbImagesCache";
import { getCachedAnime } from "@/lib/db/anime";

/** Une entrée de galerie. Même forme que TmdbArtwork et FanartItem, pour que
 *  les onglets fusionnent les trois listes sans couche de traduction. */
export interface WallhavenArtwork {
  /** La vignette (`thumbs.large`, ~500 px) — la grille en affiche des dizaines. */
  url: string;
  /** Son type à elle : ce n'est pas un visuel officiel, cf. la note 1 ci-dessus. */
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
}

/* 30 jours sur un résultat, comme les autres galeries : le fonds d'écran d'un
   anime ne bouge pas d'une semaine à l'autre. Un résultat VIDE tient moins
   longtemps — un titre récent finit par être illustré, et une absence gravée
   pour un mois est exactement le piège documenté dans tmdbImagesCache. */
const TTL_HIT_S = 30 * 24 * 60 * 60;
const TTL_EMPTY_S = 3 * 24 * 60 * 60;

/**
 * À bumper dès qu'un changement de code donnerait une RÉPONSE DIFFÉRENTE pour
 * un titre déjà interrogé : la requête envoyée, le filtre de résolution, le
 * nombre de résultats gardés. Une ligne en cache ne sait pas que le code a
 * changé (voir la note longue de lib/db/tmdbImagesCache.ts).
 *
 * v1 → v2 (10/09/2026) : une seule page de 24 en donnait 12, et « il en
 * manque » était juste. Mesuré le même jour : « one piece » a 929 images au
 * dessus de 1920×1080 (39 pages), « steins gate » 384, « koe no katachi » 63.
 * Garder 12 revenait à montrer le sommet du classement et rien d'autre. Une
 * ligne en cache ne sait pas que le code a changé : sans ce bump, tout titre
 * déjà consulté aurait gardé ses 12 images pendant trente jours.
 *
 * v2 → v3 (10/09/2026) : plancher de favoris (MIN_FAVORITES). Les lignes v2
 * contiennent la queue qu'il écarte.
 *
 * v3 → v4 (10/09/2026) : paysage seulement, plancher à 2560×1440, deux pages,
 * trente gardées. Une ligne v3 contient des portraits et du 1920×1080.
 *
 * v4 → v5 (11/09/2026) : retour à soixante. Trente était une sur-correction —
 * « il y en a beaucoup trop » visait la qualité (des portraits, du Full HD
 * juste, une queue peu likée), pas le nombre. Les filtres de v4 réglant la
 * qualité, soixante images toutes utilisables n'est pas la même chose que
 * soixante dont un tiers ne servait à rien.
 *
 * v5 → v6 (11/09/2026) : PAGINATION. La clé porte désormais un numéro de page
 * et la ligne a changé de forme (`{arts, hasMore}`). 12, 60, 30, 60 : quatre
 * nombres en deux jours, parce qu'aucun ne pouvait être le bon — One Piece a
 * 1 445 images. La pagination supprime la question au lieu d'y répondre.
 */
const CACHE_VERSION = "v6";

const API = "https://wallhaven.cc/api/v1/search";

/** La taille d'une page chez Wallhaven. Sert à savoir si une autre suit : une
 *  page pleine en annonce une, une page courte est la dernière. */
const PAGE_SIZE = 24;

/** Garde-fou contre un client qui bouclerait. 40 pages ≈ 960 images, bien
 *  au-delà de ce que le plus fourni des titres offre sous nos planchers. */
const MAX_PAGE = 40;

/**
 * Les deux filtres que l'API applique elle-même — donc les moins chers de tous,
 * puisqu'ils écartent avant que l'image n'entre dans la page.
 *
 * `atleast=2560x1440` — une plaque de profil fait ~1900 px de large. Le Full HD
 * y tient à peine, et pas du tout sur un écran à densité double. 2560×1440
 * laisse de la marge. Mesuré le 10/09/2026 : One Piece passe de 929 à 312
 * candidats, Steins;Gate de 384 à 140, Koe no Katachi de 63 à 23, Gachiakuta de
 * 19 à 15. Ce qui disparaît est la queue, pas le choix — 312 images font
 * treize pages, et personne n'en déroule treize.
 *
 * `ratios=landscape` — ET C'EST LUI QUI CORRIGEAIT UN VRAI DÉFAUT. `atleast`
 * exige une largeur ET une hauteur minimales, donc un PORTRAIT les satisfait :
 * la plus grande image de Steins;Gate servie en v3 était un 3532×5000, un fond
 * d'écran de téléphone. Ni un bandeau ni une pleine page n'en font quoi que ce
 * soit. 65 portraits écartés sur One Piece.
 *
 * Ce filtre est aussi la réponse à « seulement bannière et image » : une image
 * paysage sert les deux, et c'est ProfileHero qui tranche — il MESURE l'image
 * et pose en bandeau ce qui dépasse le ratio 3, en pleine page le reste. Rien
 * à décider ici.
 */
const MIN_RES = "2560x1440";
const RATIOS = "landscape";

/**
 * Le plancher de favoris.
 *
 * POURQUOI C'EST AUSSI LE FILTRE DE QUALITÉ, et pas seulement un filtre de
 * popularité : « mauvaise qualité » au sens où on l'entend ici — un scan de
 * manga, un croquis, un montage bâclé — ne se mesure dans aucun champ de
 * l'API. La résolution ne le voit pas (un scan peut faire 3000 px de large),
 * le poids du fichier non plus. Le nombre de favoris est le seul jugement
 * disponible, et c'est un jugement humain : ces images-là n'en récoltent pas.
 *
 * Dix. Mesuré le 10/09/2026 sur les deux premières pages, sous les filtres
 * ci-dessus (la troisième ne change pas le tableau : les favoris ne font que
 * décroître, donc si rien n'est écarté à la 48e, rien ne l'est avant) :
 *
 *   one piece       48 candidats, du 839e au 67e favori   → 0 écartée
 *   steins gate     48 candidats, de 105 à 19             → 0 écartée
 *   koe no katachi  23 candidats, de 67 à 3               → 3 écartées
 *   gachiakuta      15 candidats, de 62 à 5               → 3 écartées
 *
 * Le seuil ne coûte donc RIEN sur un titre populaire et taille exactement là
 * où il faut : la queue des petits titres.
 *
 * Conséquence assumée : un titre dont TOUTES les images sont sous le seuil
 * n'en aura aucune. C'est le bon résultat — la galerie retombe alors sur
 * fanart.tv et TMDB, c'est-à-dire sur les visuels officiels.
 */
const MIN_FAVORITES = 10;

/* Wallhaven répond en ~300 ms. Six secondes est large, et borne le cas où le
   site est lent : la galerie s'affiche alors sans lui, ce qui est le
   comportement voulu — les deux autres sources ne l'attendent pas. */
const TIMEOUT_MS = 6000;

/**
 * Le titre qu'on va chercher.
 *
 * Anglais d'abord, romaji ensuite : mesuré le 10/09/2026, les deux marchent
 * aussi bien (« a silent voice » 73, « koe no katachi » 74 ; « frieren » 411,
 * « sousou no frieren » 409), et l'anglais est la langue des étiquettes du
 * site.
 *
 * LE SOUS-TITRE EST COUPÉ, et c'est ce qui décide du résultat sur les titres
 * longs : « From Overshadowed to Overpowered: … » rend 0, sa première moitié
 * a une chance. Wallhaven cherche tous les mots, donc chaque mot en trop est
 * un filtre supplémentaire.
 */
function queryFor(data: any): string | null {
  const raw: string =
    data?.title?.english || data?.title?.romaji || data?.title?.native || "";
  if (!raw) return null;
  const cut = raw.split(/[:–—|]/)[0];
  const q = cut
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  /* Un mot de deux lettres ne cherche rien d'utile et ramènerait n'importe
     quoi — mieux vaut ne pas appeler du tout. */
  return q.length >= 3 ? q : null;
}

type WhItem = {
  favorites?: number;
  dimension_x?: number;
  dimension_y?: number;
  source?: string;
  path?: string;
  thumbs?: { large?: string; original?: string; small?: string };
};

/** Une page de galerie, telle que le client la consomme. */
export type WallhavenPage = {
  arts: WallhavenArtwork[];
  /** Une page suivante existe. Calculé sur le nombre BRUT de résultats, pas sur
   *  ce qui survit aux planchers : une page où tout serait filtré aurait sinon
   *  l'air d'être la dernière alors que la suivante peut être pleine. */
  hasMore: boolean;
};

/**
 * UNE page d'illustrations Wallhaven, à la demande.
 *
 * POURQUOI PAGE PAR PAGE, et non « les N meilleures » comme fanart.tv et TMDB.
 * Les deux autres sources rendent tout leur catalogue d'un coup parce que ce
 * catalogue est petit — quelques dizaines d'images par titre, connues d'avance.
 * Wallhaven en a 1 445 pour One Piece (312 sous nos planchers), et aucun nombre
 * fixe ne convient : trop bas on ampute un gros titre, trop haut on paie 13
 * requêtes sur une clé froide contre un quota de 45 par minute — et quatre
 * fiches ouvertes en même temps suffiraient à le faire sauter.
 *
 * La pagination supprime l'arbitrage au lieu de le trancher. Le coût d'ouvrir
 * une galerie redevient UNE requête, quel que soit le titre ; les pages
 * suivantes ne sont payées que par qui les regarde, et chacune est mise en
 * cache pour elle-même — la page 7 d'un titre populaire finit par être gratuite
 * pour tout le monde.
 *
 * Rend une page vide sur tout échec ; ne lève jamais.
 */
export async function getWallhavenArtworks(
  anilistId: number,
  page = 1,
): Promise<WallhavenPage> {
  const vide: WallhavenPage = { arts: [], hasMore: false };
  if (!Number.isFinite(anilistId) || anilistId <= 0) return vide;
  /* Borne haute : au-delà, c'est un client qui boucle, pas quelqu'un qui
     regarde des images. Wallhaven plafonne de toute façon bien avant. */
  const p = Math.min(Math.max(1, Math.floor(page)), MAX_PAGE);

  /* UNE LIGNE PAR PAGE. Chacune est indépendante : une page qui échoue
     n'invalide pas les autres, et une ligne pèse ~6 ko au lieu des 78 ko
     qu'aurait fait un catalogue entier sur une table lue à chaud. */
  const key = `wallhaven:${CACHE_VERSION}:${anilistId}:p${p}`;
  /* DEUX TTL POUR UNE SEULE CLÉ : on lit d'abord au plus long, et une page
     VIDE est ensuite relue au TTL court, donc traitée comme absente au-delà.
     Un titre récent finit par être illustré ; une absence gravée un mois est
     le piège documenté dans tmdbImagesCache. */
  const cached = await getCachedJson<WallhavenPage>(key, TTL_HIT_S);
  if (cached) {
    if (cached.arts?.length) return cached;
    const frais = await getCachedJson<WallhavenPage>(key, TTL_EMPTY_S);
    if (frais) return { arts: frais.arts ?? [], hasMore: !!frais.hasMore };
  }

  const anime = await getCachedAnime(anilistId).catch(() => null);
  const q = anime ? queryFor(anime.data) : null;
  if (!q) {
    /* Titre inconnu de notre cache : ce n'est pas une réponse de Wallhaven, et
       la mettre en cache graverait une absence qui n'a rien à voir avec lui. */
    return vide;
  }

  const url =
    `${API}?q=${encodeURIComponent(q)}` +
    `&categories=010&purity=100&sorting=favorites&order=desc` +
    `&atleast=${MIN_RES}&ratios=${RATIOS}&page=${p}`;

  let items: WhItem[];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    /* 429 = notre quota de 45/min, 5xx = leur panne. Ni l'un ni l'autre n'est
       une réponse sur ce titre : on rend vide SANS écrire, pour que l'appel
       suivant repose la question. */
    if (!res.ok) return vide;
    const json = (await res.json()) as { data?: WhItem[] };
    items = Array.isArray(json?.data) ? json.data : [];
  } catch {
    return vide;
  } finally {
    clearTimeout(timer);
  }

  const arts: WallhavenArtwork[] = [];
  for (const w of items) {
    const thumb = w.thumbs?.large || w.thumbs?.original || w.thumbs?.small;
    const full = w.path;
    if (!thumb || !full) continue;
    if ((Number(w.favorites) || 0) < MIN_FAVORITES) continue;
    arts.push({
      url: thumb,
      type: "wallpaper",
      language: null,
      likes: Number(w.favorites) || 0,
      season: null,
      fullUrl: full,
      width: Number(w.dimension_x) || 0,
      height: Number(w.dimension_y) || 0,
      source: w.source || null,
    });
  }

  /* Une page pleine (24 bruts) veut dire qu'il y en a une autre ; une page
     courte est la dernière. C'est le compte BRUT qui décide — voir `hasMore`. */
  const out: WallhavenPage = {
    arts,
    hasMore: items.length >= PAGE_SIZE && p < MAX_PAGE,
  };

  /* Le vide est écrit lui aussi (au TTL court) : la plupart des titres de
     niche n'ont rien sur Wallhaven, et sans ça chaque ouverture de la galerie
     re-poserait la même question à un quota de 45/min. */
  await setCachedJson(key, out);
  return out;
}
