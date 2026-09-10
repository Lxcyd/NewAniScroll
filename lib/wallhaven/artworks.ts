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
 */
const CACHE_VERSION = "v3";

const API = "https://wallhaven.cc/api/v1/search";

/**
 * Combien de pages on va chercher, et combien d'images on garde.
 *
 * L'ARBITRAGE EST ENTRE TROIS CHOSES, et aucune ne permet de tout prendre :
 *
 *  • le quota — une page = une requête, contre 45 par minute et par IP, celle
 *    de la lambda, partagée par tous les visiteurs ;
 *  • la ligne de cache — chaque entrée pèse ~350 octets sérialisés, et
 *    `tmdb_images_cache` documente déjà qu'une ligne de 80 ko sur une table lue
 *    à chaud est une mauvaise idée ;
 *  • la galerie elle-même — les 929 images de One Piece ne se regardent pas.
 *
 * Trois pages, soixante gardées : cinq fois plus qu'avant, ~21 ko par ligne,
 * trois requêtes sur une clé froide (donc une fois par mois et par titre).
 * Comme le classement est `favorites` décroissant, ces soixante-là sont les
 * soixante meilleures, pas soixante au hasard.
 */
const PAGES = 3;
const KEEP = 60;

/* En dessous, ça ne vaut pas un fond d'écran — et c'est le filtre qui coûte le
   moins cher, puisque l'API l'applique elle-même (`atleast`). */
const MIN_RES = "1920x1080";

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
 * Dix, et pas plus haut. Mesuré le 10/09/2026 sur les trois premières pages
 * classées par favoris :
 *
 *   one piece    72 images, la 60e à 94 favoris, la dernière à 82 → 0 écartée
 *   steins gate  72 images, la 60e à 33, la dernière à 31        → 0 écartée
 *   koe no katachi  63 images, la 60e à 4, la dernière à 3       → 14 écartées
 *   gachiakuta      19 images, la dernière à 5                   → 3 écartées
 *
 * Le seuil ne coûte donc RIEN sur un titre populaire et taille exactement là
 * où il faut : la queue des petits titres, celle qu'on descend justement en
 * allant chercher soixante images au lieu de douze.
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

/** Les illustrations Wallhaven d'un id AniList. Liste vide sur tout échec. */
export async function getWallhavenArtworks(
  anilistId: number,
): Promise<WallhavenArtwork[]> {
  if (!Number.isFinite(anilistId) || anilistId <= 0) return [];

  type Row = { arts: WallhavenArtwork[]; partiel?: boolean };

  const key = `wallhaven:${CACHE_VERSION}:${anilistId}`;
  /* DEUX TTL POUR UNE SEULE CLÉ. On lit d'abord au plus long ; une ligne qui
     n'est pas un résultat complet — vide, ou interrompue par une page en échec
     — est ensuite relue au TTL court, et traitée comme absente au-delà. C'est
     ce qui empêche un hoquet d'une seconde de graver un manque pour un mois. */
  const cached = await getCachedJson<Row>(key, TTL_HIT_S);
  if (cached) {
    const complet = !!cached.arts?.length && !cached.partiel;
    if (complet) return cached.arts;
    const frais = await getCachedJson<Row>(key, TTL_EMPTY_S);
    if (frais) return frais.arts ?? [];
  }

  const anime = await getCachedAnime(anilistId).catch(() => null);
  const q = anime ? queryFor(anime.data) : null;
  if (!q) {
    /* Titre inconnu de notre cache : ce n'est pas une réponse de Wallhaven, et
       la mettre en cache graverait une absence qui n'a rien à voir avec lui. */
    return [];
  }

  const base =
    `${API}?q=${encodeURIComponent(q)}` +
    `&categories=010&purity=100&sorting=favorites&order=desc&atleast=${MIN_RES}`;

  /** Une page. `null` distingue « la question n'a pas abouti » de « la page est
   *  vide », et c'est cette distinction qui décide de ce qu'on met en cache. */
  const fetchPage = async (page: number): Promise<WhItem[] | null> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${base}&page=${page}`, { signal: ctl.signal });
      /* 429 = notre quota de 45/min, 5xx = leur panne. Ni l'un ni l'autre n'est
         une réponse sur ce titre. */
      if (!res.ok) return null;
      const json = (await res.json()) as { data?: WhItem[] };
      return Array.isArray(json?.data) ? json.data : [];
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const arts: WallhavenArtwork[] = [];
  /* Séquentiel, et non en parallèle : trois requêtes simultanées comptent
     autant contre le quota, mais toutes les lambdas qui ouvrent une fiche au
     même instant les enverraient en même temps — c'est le profil qui déclenche
     un 429. À ~300 ms la page, la boucle coûte moins d'une seconde. */
  let partiel = false;
  for (let page = 1; page <= PAGES && arts.length < KEEP; page++) {
    const items = await fetchPage(page);
    if (items === null) {
      /* La page a échoué. Ce qu'on a déjà reste bon — on le garde — mais le
         résultat n'est PAS complet, et le mettre en cache pour trente jours
         graverait un manque dû à un hoquet. Le drapeau raccourcit le TTL. */
      partiel = true;
      break;
    }
    /* Une page courte est la dernière : Wallhaven en sert 24, moins veut dire
       qu'il n'y en a plus. Continuer coûterait une requête pour rien. */
    const court = items.length < 24;
    for (const w of items) {
      const thumb = w.thumbs?.large || w.thumbs?.original || w.thumbs?.small;
      const full = w.path;
      if (!thumb || !full) continue;
      const favoris = Number(w.favorites) || 0;
      /* La liste arrive classée par favoris décroissants : la première image
         sous le plancher est suivie de rien qui le repasse. On pourrait donc
         sortir des deux boucles — mais `continue` reste juste si Wallhaven
         change un jour son ordre, et ne coûte que de parcourir une page déjà
         téléchargée. */
      if (favoris < MIN_FAVORITES) continue;
      arts.push({
        url: thumb,
        type: "wallpaper",
        language: null,
        likes: favoris,
        season: null,
        fullUrl: full,
        width: Number(w.dimension_x) || 0,
        height: Number(w.dimension_y) || 0,
        source: w.source || null,
      });
      if (arts.length >= KEEP) break;
    }
    if (court) break;
  }

  /* Rien du tout ET la première page a échoué : ce n'est pas une réponse sur ce
     titre, donc pas d'écriture — l'appel suivant repose la question. */
  if (partiel && arts.length === 0) return [];

  /* Le vide est écrit lui aussi (au TTL court) : la plupart des titres de
     niche n'ont rien sur Wallhaven, et sans ça chaque ouverture de la galerie
     re-poserait la même question à un quota de 45/min. */
  await setCachedJson(key, { arts, partiel });
  return arts;
}
