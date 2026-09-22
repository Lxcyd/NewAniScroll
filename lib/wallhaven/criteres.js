/**
 * Les critères Wallhaven — en UN SEUL exemplaire.
 *
 * POURQUOI CE FICHIER EST EN .js ET PAS EN .ts. Il est lu par deux mondes qui
 * ne parlent pas le même langage : le site (TypeScript, compilé par Next) et
 * les moissonneurs de `tools/wallhaven/` (des `.mjs` lancés par node nu, sans
 * tsx ni ts-node, et `tools/` est exclu du tsconfig). Du JS ordinaire annoté en
 * JSDoc est le seul terrain que les deux acceptent — c'est déjà le procédé de
 * `lib/extractors.js` et `lib/hostRegistry.js`.
 *
 * ET C'EST TOUT L'INTÉRÊT. Le fichier qu'il remplace,
 * `lib/wallhaven/artworks.ts`, en était à sa SIXIÈME version de clé de cache en
 * deux jours ; trois de ces bumps ne réglaient qu'un seuil. Chacun invalidait
 * trente jours de galeries. La cause n'était pas l'indécision : c'était que les
 * critères s'appliquaient À L'ÉCRITURE, donc les changer imposait de tout
 * re-télécharger. Ici, le moissonneur n'applique AUCUN jugement — il écrit tout
 * ce que Wallhaven rend, avec ses compteurs — et tout ce qui suit s'applique à
 * la LECTURE. Changer un seuil ne coûte plus rien et n'invalide plus rien.
 *
 * Si un chiffre de ce fichier doit bouger, il bouge ici et nulle part ailleurs.
 */

/* ── Ce que le moissonneur demande à Wallhaven ────────────────────────────── */

/**
 * Le plancher de résolution du CRAWL — pas celui de l'affichage.
 *
 * Il part dans l'URL, donc il écarte avant même que l'image nous parvienne :
 * c'est la seule décision de tout ce dispositif qui ne soit pas rattrapable
 * sans tout re-moissonner. D'où 1920×1080 et non les 2560×1440 qu'on affiche :
 * mesuré le 13/09/2026, One Piece passe de 312 à 929 candidats. On aspire
 * large et on choisit à la lecture, où c'est gratuit.
 */
export const CRAWL_MIN_RES = "1920x1080";

/**
 * Paysage seulement, et CELUI-CI reste dans la requête.
 *
 * Ce n'est pas un goût, c'est la forme de la plaque de profil : `atleast` exige
 * une largeur ET une hauteur minimales, donc un PORTRAIT les satisfait — la
 * plus grande image de Steins;Gate servie avant ce filtre était un 3532×5000,
 * un fond d'écran de téléphone. Ni un bandeau ni une pleine page n'en font quoi
 * que ce soit.
 */
export const CRAWL_RATIOS = "landscape";

/** La taille d'une page chez Wallhaven. Sert à savoir si une autre suit. */
export const PAGE_SIZE = 24;

/**
 * 45 requêtes/minute par IP, et un 429 au-delà. On vise 40 : la marge absorbe
 * une relance et le temps n'est plus une ressource rare depuis que tout ceci
 * tourne sur le poste et non dans une lambda.
 */
export const REQUETES_PAR_MINUTE = 40;

/* ── Le plancher d'affichage, lui, est réglable ───────────────────────────── */

/**
 * Ce qu'on montre par défaut. Au-dessus du plancher du crawl, donc réglable
 * dans les deux sens sans rien re-télécharger — c'était le but.
 *
 * 2560×1440 parce qu'une plaque de profil fait ~1900 px de large : le Full HD y
 * tient à peine, et pas du tout sur un écran à densité double.
 */
export const AFFICHAGE_MIN_LARGEUR = 2560;
export const AFFICHAGE_MIN_HAUTEUR = 1440;

/* ── Le signal « trame vidéo » ────────────────────────────────────────────── */

/**
 * Les résolutions d'ÉCRAN et de TRAME VIDÉO exactes.
 *
 * C'est le meilleur indice de capture dont on dispose, et il a été mesuré
 * plutôt que supposé : sur 965 images (13/09/2026), celles SANS auteur crédité
 * tombent sur une de ces valeurs dans **68 %** des cas, contre **36 %** pour
 * celles qui en ont un. Une illustration a des dimensions arbitraires ; une
 * capture, ou un upscale de capture, tombe pile.
 *
 * ⚠️ C'est un INDICE, jamais une preuve — un illustrateur exporte aussi en
 * 3840×2160. D'où un simple multiplicateur ci-dessous, et pas un filtre : ce
 * signal rétrograde, il ne supprime pas.
 */
export const RESOLUTIONS_STANDARD = new Set([
  // l'échelle 16/9
  "1280x720", "1366x768", "1600x900", "1920x1080", "2048x1152",
  "2560x1440", "3200x1800", "3840x2160", "5120x2880", "7680x4320",
  // l'échelle 16/10
  "1680x1050", "1920x1200", "2560x1600", "3840x2400",
]);

/** Vrai si les dimensions sont libres, c'est-à-dire PAS une trame vidéo. */
export function estResolutionLibre(largeur, hauteur) {
  return !RESOLUTIONS_STANDARD.has(`${largeur}x${hauteur}`);
}

/* ── Les tags, repliés en facettes ────────────────────────────────────────── */

/**
 * Les tags qui disent « c'est une œuvre », en minuscules.
 *
 * Mesuré sur 47 fiches : `fan art` porte sur **33 %** des images créditées et
 * **0 %** des non créditées ; `artwork` 29 % en dimensions libres contre 4 % en
 * trame vidéo. Les trois signaux (auteur, dimensions, tag) pointent donc dans
 * le même sens, ce qui fonde le score composite plus bas.
 *
 * Leur limite, à garder en tête : ils sont RARES (17 % portent `fan art`). Un
 * tag présent est une preuve ; un tag absent ne dit rien du tout. C'est
 * pourquoi leur absence ne pénalise pas.
 */
export const TAGS_ILLUSTRATION = [
  "fan art", "digital art", "artwork", "illustration",
  "drawing", "painting", "vector art",
];

/** Le seul marqueur négatif explicite du vocabulaire Wallhaven. Rare (4 %),
 *  mais sans ambiguïté quand il est là. */
export const TAGS_CAPTURE = ["anime screenshot", "screenshot"];

/** Les catégories que l'API attribue elle-même aux tags. */
const CAT_PERSONNAGES = ["Characters", "Fictional Characters", "People"];
const CAT_DECOR = ["Landscapes", "Nature"];

/**
 * @typedef {{ name: string, category?: string|null }} TagWh
 * @typedef {{ facetType: "illustration"|"capture"|null,
 *             hasCharacter: boolean, isScenery: boolean }} Facettes
 */

/**
 * Replie les 24 tags bruts d'une image en une poignée de facettes cliquables.
 *
 * Les tags bruts restent en base (`wallhaven_tag`) précisément pour que cette
 * règle-ci puisse être corrigée sans re-moissonner quoi que ce soit : si
 * « Capture » montre autre chose que des captures, c'est ce tableau qu'on
 * change, et un simple recalcul suffit.
 *
 * @param {TagWh[]} tags
 * @returns {Facettes}
 */
export function facettesDepuisTags(tags) {
  const noms = (tags || []).map((t) => String(t?.name || "").toLowerCase());
  const cats = (tags || []).map((t) => String(t?.category || ""));

  const illustration = TAGS_ILLUSTRATION.some((t) => noms.includes(t));
  const capture = TAGS_CAPTURE.some((t) => noms.includes(t));
  const personnage = cats.some((c) => CAT_PERSONNAGES.includes(c));

  return {
    /* Un tag de capture l'emporte : quand les deux sont posés, c'est
       qu'on a affaire à une retouche de capture, pas à une œuvre. */
    facetType: capture ? "capture" : illustration ? "illustration" : null,
    hasCharacter: personnage,
    /* Un décor SANS personnage. « Paysage » ne veut rien dire si un
       protagoniste occupe la moitié du cadre. */
    isScenery: cats.some((c) => CAT_DECOR.includes(c)) && !personnage,
  };
}

/* ── La vérification de série ─────────────────────────────────────────────── */

/**
 * Aplatit un titre ou un tag pour les comparer.
 *
 * Le point final n'est pas une coquette : le tag mesuré s'écrit littéralement
 * `Koe no Katachi.` Les accents sautent aussi — `Sōsō no Frieren` et
 * `Sousou No Frieren` doivent se rencontrer.
 */
export function normaliserTitre(s) {
  return String(s || "")
    .normalize("NFD")
    /* Les diacritiques décomposés par NFD, en échappement explicite : écrits
       en littéral, ce sont des caractères combinants invisibles qu'un éditeur
       ou un copier-coller peut manger sans que rien ne le signale. */
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    /* LES DEUX ROMANISATIONS DU JAPONAIS DOIVENT SE RENCONTRER. Une voyelle
       longue s'écrit au choix `ō` ou `ou`, et les deux circulent : AniList
       donne « Sousou no Frieren » en romaji mais peut porter « Sōsō » dans ses
       synonymes, et Wallhaven étiquette « Sousou No Frieren ». Après NFD la
       première forme devient `soso` et la seconde reste `sousou` — elles ne se
       verraient jamais. On les replie sur la forme courte des deux côtés.
       C'est une canonicalisation, pas une lecture : peu importe que `youjo`
       devienne `yojo`, du moment que les deux camps le font pareil. */
    .replace(/ou/g, "o")
    .replace(/uu/g, "u")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Le plus court des deux est-il le DÉBUT de l'autre, à la coupe d'un mot ?
 *
 * Il faut cette souplesse : le tag « One Piece » doit confirmer l'anime
 * « One Piece Film: Red », et le tag « Shingeki no Kyojin The Final Season »
 * doit confirmer « Shingeki no Kyojin ».
 *
 * Mais une inclusion NUE serait un piège : le tag décoratif `sword` — courant
 * sur les fonds d'écran — confirmerait « Sword Art Online » pour n'importe
 * quelle image. D'où les deux garde-fous : six caractères au minimum, et le
 * point de coupe doit tomber sur une frontière de mot, jamais au milieu.
 */
/**
 * Les formes sous lesquelles un tag peut nommer sa série.
 *
 * WALLHAVEN QUALIFIE SES PERSONNAGES PAR LA SÉRIE, ENTRE PARENTHÈSES —
 * « Uta (One Piece) », « King (One Piece) », « Keqing (Genshin Impact) ». Sans
 * ce traitement, la parenthèse est aplatie en « uta one piece » et la
 * comparaison par préfixe ne la voit pas : le nom de la série est à la FIN.
 *
 * Mesuré en le déployant : 3 des 13 images écartées de One Piece l'étaient à
 * tort pour cette seule raison, dont une à 110 favoris. Une image écartée ne se
 * signale nulle part — c'est exactement le genre de défaut qu'on ne trouve
 * qu'en allant regarder, et pas en relisant le code.
 *
 * @returns {string[]} le tag entier, plus le contenu de chaque parenthèse
 */
function formesDuTag(nom) {
  const brut = String(nom || "");
  const formes = [brut];
  for (const m of brut.matchAll(/\(([^)]+)\)/g)) formes.push(m[1]);
  return formes.map(normaliserTitre).filter((s) => s.length >= 3);
}

function memeDebut(a, b) {
  const [court, long] = a.length <= b.length ? [a, b] : [b, a];
  if (court.length < 6) return court === long;
  if (!long.startsWith(court)) return false;
  return long.length === court.length || long[court.length] === " ";
}

/**
 * Cette image parle-t-elle bien de cet anime ?
 *
 * LE DÉFAUT QU'ELLE CORRIGE, mesuré le 13/09/2026 sur le corpus One Piece
 * entier : la recherche est TEXTUELLE, donc elle ramène autre chose. Parmi les
 * 864 résultats de « one piece » : Sakura Miko (Hololive), Nishikino Maki
 * (Love Live!), Ushio Kofune (Summertime Render). La première était parmi les
 * images les mieux notées — 42 points, auteur crédité, 3840×2160. Elle est
 * bonne. Elle n'est simplement pas One Piece.
 *
 * Aucun signal de QUALITÉ ne peut attraper ça, parce que ce n'est pas un
 * défaut de qualité. Les tags sont le seul recours.
 *
 * DEUX PIÈGES, tous deux rencontrés à la mesure :
 *
 * 1. Ne PAS filtrer sur `category === "Series"`. Koe no Katachi n'a aucun tag
 *    de cette catégorie (0/6 images) — il est rangé ailleurs. On compare les
 *    NOMS, toutes catégories confondues.
 * 2. « Au moins un tag correspond », et surtout pas « le tag dominant ». Une
 *    image « One Piece » de l'échantillon portait 18 tags de série : c'était un
 *    collage Shonen Jump, légitimement rattaché à plusieurs animes. Une règle
 *    majoritaire l'aurait rejetée à tort.
 *
 * @param {TagWh[]} tags       les tags de l'image
 * @param {string[]} titres    tous les titres connus de l'anime
 * @returns {0|1|null} 1 confirmé, 0 démenti, null si on ne peut pas juger
 */
export function serieConfirmee(tags, titres) {
  /* Sans tags, on ne SAIT pas — et une ignorance ne doit jamais devenir un
     refus. `null` laisse l'image visible ; c'est l'enrichissement qui
     tranchera. */
  if (!tags?.length) return null;

  const connus = new Set();
  for (const t of titres || []) {
    const n = normaliserTitre(t);
    if (n.length >= 3) connus.add(n);
  }
  /* Aucun titre exploitable de notre côté : c'est NOTRE lacune, pas un
     démenti sur l'image. */
  if (!connus.size) return null;

  for (const t of tags) {
    for (const n of formesDuTag(t?.name)) {
      if (connus.has(n)) return 1;
      for (const c of connus) {
        if (memeDebut(c, n)) return 1;
      }
    }
  }
  return 0;
}

/**
 * Tous les titres d'un anime, tels qu'on peut les opposer aux tags.
 * @param {any} data la charge AniList stockée dans `anime.data`
 */
export function titresConnus(data) {
  const t = data?.title || {};
  return [t.english, t.romaji, t.native, ...(data?.synonyms || [])].filter(Boolean);
}

/* ── Le score ─────────────────────────────────────────────────────────────── */

/**
 * Les multiplicateurs, nommés pour qu'une relecture du SQL reste lisible.
 *
 * POURQUOI DES MULTIPLICATEURS ET PAS UNE PORTE. Un filtre dur sur « auteur
 * crédité » jetterait de bonnes images : mesuré, les créditées ont 72 favoris
 * de médiane contre 60 pour les autres — 20 % d'écart, pas un gouffre. Une
 * image non créditée à 300 favoris est manifestement bonne, et ses likes le
 * disent. Ici les signaux ne suppriment pas : ils ABAISSENT le nombre de likes
 * exigé. Une image créditée en dimensions libres passe dès 15 favoris là où une
 * image nue doit en aligner 25.
 */
export const MULT_AUTEUR = 1.4;
export const MULT_RES_LIBRE = 1.2;
export const MULT_ILLUSTRATION = 1.5;
export const MULT_CAPTURE = 0.3;

/**
 * @param {{favorites:number, source?:string|null, width:number, height:number,
 *          facetType?:string|null}} img
 */
export function scoreDe(img) {
  let s = Number(img?.favorites) || 0;
  if (img?.source) s *= MULT_AUTEUR;
  if (estResolutionLibre(img?.width, img?.height)) s *= MULT_RES_LIBRE;
  if (img?.facetType === "illustration") s *= MULT_ILLUSTRATION;
  else if (img?.facetType === "capture") s *= MULT_CAPTURE;
  return s;
}

/* ── Les deux seuils, et pourquoi il en faut DEUX ─────────────────────────── */

/**
 * En dessous, c'est du rebut quel que soit le titre.
 *
 * ⚠️ NON CALIBRÉ. Valeur de départ. Elle s'applique à la LECTURE, donc la
 * changer ne coûte rien et n'invalide rien — c'est exactement ce que ce
 * dispositif achète. À poser pour de bon en regardant la galerie sur
 * dev.aniscroll.com, jamais en local.
 */
export const PLANCHER_DUR = 10;

/**
 * Le nombre d'images affichables par titre, au-delà duquel on coupe.
 *
 * POURQUOI UN PLAFOND PLUTÔT QU'UN PLANCHER PLUS HAUT. Un seuil unique ne peut
 * pas convenir aux deux bouts du catalogue, et le corpus One Piece complet l'a
 * montré : un plancher de 25 points y écarte **51 %** des 864 images — sans
 * dommage, il en reste 421 — mais appliqué à Gachiakuta, qui en a 19, il
 * deviendrait un massacre. Les échantillons précédents ne pouvaient pas le
 * voir : ils s'arrêtaient aux cinq premières pages, triées par favoris
 * décroissants, donc aveugles à la queue.
 *
 * Un plafond règle ça sans percentile ni calcul par titre à maintenir : la
 * sévérité s'adapte d'elle-même à l'abondance. One Piece garde ses 120
 * meilleures (soit un tri BIEN plus sévère qu'un plancher), Gachiakuta garde
 * ses 19 moins le rebut. 120 = cinq pages de galerie.
 */
export const TOP_PAR_TITRE = 120;

/* ── Le même score, mais en SQL ───────────────────────────────────────────── */

/**
 * L'expression SQL du score, bâtie à partir des constantes ci-dessus.
 *
 * Elle est GÉNÉRÉE plutôt qu'écrite à la main pour que `scoreDe()` et la
 * requête ne puissent pas diverger — c'est le même défaut, à une échelle plus
 * petite, que celui qui a motivé tout ce fichier.
 *
 * `res_libre` est calculé à la volée depuis `width`/`height` plutôt que stocké :
 * une colonne figerait le jeu de résolutions du jour où la ligne a été écrite,
 * et il faudrait une migration pour l'élargir.
 */
export function sqlScore(prefixe = "") {
  const p = prefixe ? `${prefixe}.` : "";
  const resLibre = [...RESOLUTIONS_STANDARD].map((r) => `'${r}'`).join(",");
  return `(${p}favorites
    * CASE WHEN ${p}source IS NOT NULL AND ${p}source <> '' THEN ${MULT_AUTEUR} ELSE 1.0 END
    * CASE WHEN (${p}width || 'x' || ${p}height) IN (${resLibre}) THEN 1.0 ELSE ${MULT_RES_LIBRE} END
    * CASE WHEN ${p}facet_type = 'illustration' THEN ${MULT_ILLUSTRATION}
           WHEN ${p}facet_type = 'capture' THEN ${MULT_CAPTURE}
           ELSE 1.0 END)`;
}

/* ── La requête envoyée à Wallhaven ───────────────────────────────────────── */

/**
 * Le texte qu'on va chercher pour un anime.
 *
 * Déménagé depuis `artworks.ts`, dont c'était la seule pièce encore utile : le
 * moissonneur est désormais le seul appelant, le site ne parle plus à Wallhaven.
 *
 * Anglais d'abord, romaji ensuite — mesuré, les deux marchent aussi bien
 * (« a silent voice » 73, « koe no katachi » 74), et l'anglais est la langue
 * des étiquettes du site.
 *
 * LE SOUS-TITRE EST COUPÉ, et c'est ce qui décide du résultat sur les titres
 * longs : « From Overshadowed to Overpowered: … » rend 0, sa première moitié a
 * une chance. Wallhaven cherche TOUS les mots, donc chaque mot en trop est un
 * filtre de plus.
 */
export function requetePourAnime(data) {
  const brut = String(
    data?.title?.english || data?.title?.romaji || data?.title?.native || "",
  );
  if (!brut) return null;
  const coupe = brut.split(/[:–—|]/)[0];
  const q = coupe.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  /* Un mot de deux lettres ne cherche rien d'utile et ramènerait n'importe
     quoi — mieux vaut ne pas appeler du tout. */
  return q.length >= 3 ? q : null;
}

/** L'URL de recherche, une page. */
export function urlRecherche(q, page, tri = "favorites") {
  return (
    `https://wallhaven.cc/api/v1/search?q=${encodeURIComponent(q)}` +
    `&categories=010&purity=100&sorting=${tri}&order=desc` +
    `&atleast=${CRAWL_MIN_RES}&ratios=${CRAWL_RATIOS}&page=${page}`
  );
}

/** L'URL d'une fiche, la seule qui porte les tags. */
export function urlFiche(whId) {
  return `https://wallhaven.cc/api/v1/w/${whId}`;
}
