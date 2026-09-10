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
 *    partagée par tous les visiteurs. Au-delà, 429. D'où : un seul appel par
 *    anime (jamais un par titre alternatif), un cache de 30 jours, et un 429
 *    qui n'est JAMAIS mis en cache — sinon un pic de trafic d'une minute
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
 * v1 — première version.
 *
 * À bumper dès qu'un changement de code donnerait une RÉPONSE DIFFÉRENTE pour
 * un titre déjà interrogé : la requête envoyée, le filtre de résolution, le
 * nombre de résultats gardés. Une ligne en cache ne sait pas que le code a
 * changé (voir la note longue de lib/db/tmdbImagesCache.ts).
 */
const CACHE_VERSION = "v1";

const API = "https://wallhaven.cc/api/v1/search";

/* On ne garde pas les 24 résultats d'une page : la galerie fusionne déjà trois
   sources, et une grille où Wallhaven pèse plus que les visuels officiels ne
   ressemble plus à la fiche d'un anime. 12 suffit à donner le choix. */
const KEEP = 12;

/* En dessous, ça ne vaut pas un fond d'écran — et c'est le filtre qui coûte le
   moins cher, puisque l'API l'applique elle-même (`atleast`). */
const MIN_RES = "1920x1080";

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

  const key = `wallhaven:${CACHE_VERSION}:${anilistId}`;
  /* Deux TTL pour une seule clé : on lit d'abord au plus long, et une ligne
     vide plus vieille que TTL_EMPTY_S est traitée comme absente. */
  const cached = await getCachedJson<{ arts: WallhavenArtwork[] }>(
    key,
    TTL_HIT_S,
  );
  if (cached) {
    if (cached.arts?.length) return cached.arts;
    const still = await getCachedJson<{ arts: WallhavenArtwork[] }>(
      key,
      TTL_EMPTY_S,
    );
    if (still) return [];
  }

  const anime = await getCachedAnime(anilistId).catch(() => null);
  const q = anime ? queryFor(anime.data) : null;
  if (!q) {
    /* Titre inconnu de notre cache : ce n'est pas une réponse de Wallhaven, et
       la mettre en cache graverait une absence qui n'a rien à voir avec lui. */
    return [];
  }

  const url =
    `${API}?q=${encodeURIComponent(q)}` +
    `&categories=010&purity=100&sorting=favorites&order=desc&atleast=${MIN_RES}`;

  let json: { data?: WhItem[] } | null = null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    /* 429 = notre quota de 45/min, 5xx = leur panne. Ni l'un ni l'autre n'est
       une réponse sur ce titre : on renvoie vide SANS écrire, pour que l'appel
       suivant repose la question. */
    if (!res.ok) return [];
    json = (await res.json()) as { data?: WhItem[] };
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }

  const arts: WallhavenArtwork[] = [];
  for (const w of Array.isArray(json?.data) ? json!.data! : []) {
    const thumb = w.thumbs?.large || w.thumbs?.original || w.thumbs?.small;
    const full = w.path;
    if (!thumb || !full) continue;
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
    if (arts.length >= KEEP) break;
  }

  /* Le vide est écrit lui aussi (au TTL court) : la plupart des titres de
     niche n'ont rien sur Wallhaven, et sans ça chaque ouverture de la galerie
     re-poserait la même question à un quota de 45/min. */
  await setCachedJson(key, { arts });
  return arts;
}
