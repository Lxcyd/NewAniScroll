/**
 * Comment un profil est habillé — le fond, la musique, le flou.
 *
 * Jusqu'ici le champ stocké était une URL et un `source` : « la bannière
 * épinglée ». Le studio (components/profile/BannerStudio.tsx) en fait un OBJET,
 * parce qu'un fond n'est plus forcément une image — ce peut être une couleur
 * unie ou une vidéo — et parce que deux réglages s'y ajoutent qui ne sont pas
 * des propriétés de l'image : la musique et le flou derrière les widgets.
 *
 * La migration est silencieuse et ne coûte pas de colonne : `profile_banner`
 * contenait déjà du JSON (`{url, animeId, title, source}`), et
 * `normalizeDressing` relit cette forme-là comme un fond de type « banner ».
 * Rien à réécrire en base ; une valeur ancienne se met à jour à la première
 * sauvegarde depuis le studio.
 *
 * Ce module est importé par l'API ET par le navigateur : il ne doit toucher ni
 * la base, ni `window`.
 */

import type { BannerOption } from "./types";

/** Les huit fonds proposés par le dock du studio. */
export type DressingKind =
  | "color"
  | "banner"
  | "anim"
  | "image"
  | "video"
  | "oped"
  | "clip"
  | "upload";

export type DressingMusic = {
  /** Fichier joué. Même hôte que les vidéos d'AnimeThemes. */
  url: string;
  title: string;
  artist: string | null;
  /** "OP1", "ED2"… — ce qui est affiché à côté du titre. */
  slug: string | null;
  /**
   * L'affiche de l'anime dont vient le morceau.
   *
   * Rangée AVEC la musique et non déduite du fond : on peut porter l'opening
   * d'un titre sur la bannière d'un autre, et c'est même l'usage courant. Sans
   * elle, le dock affichait une icône de haut-parleur là où une pochette dit
   * tout de suite de quel anime on parle.
   */
  cover: string | null;
  /**
   * Les bornes de lecture, en secondes — la partie du morceau qui sera jouée.
   *
   * `null` des deux côtés veut dire « tout le fichier », et c'est le cas par
   * défaut. Un générique dure 90 s dont on ne veut souvent que le refrain :
   * plutôt que de laisser le hasard décider par où la boucle repasse, on
   * découpe une fois pour toutes.
   *
   * Ne s'applique qu'au fichier d'AnimeThemes. La version YouTube complète est
   * jouée par le lecteur officiel, qu'on ne pilote pas d'ici.
   */
  from: number | null;
  to: number | null;
  /**
   * Vidéo YouTube du morceau, quand elle est connue.
   *
   * L'audio d'AnimeThemes est le rip du générique : 90 s, mesuré à ffprobe sur
   * plusieurs titres. C'est la version télévisée, pas le morceau. Quand cet
   * identifiant est renseigné, le profil joue la version COMPLÈTE via le
   * lecteur YouTube officiel plutôt que `url` — même mécanique que les
   * bandes-annonces au survol, scène « music » (voir stageStore).
   *
   * Reste `null` tant que la table de résolution n'est pas remplie : le
   * résolveur de tools/ost-resolver produit ces identifiants hors ligne.
   */
  videoId: string | null;
  /**
   * Fondu d'entrée et de sortie sur l'extrait, en secondes. `0` = coupe franche.
   *
   * Un extrait coupé au milieu d'une mesure claque à chaque tour de boucle ;
   * une seconde et demie de fondu suffit à rendre la reprise inaudible. Le
   * fondu est SYMÉTRIQUE (même durée des deux côtés) : deux réglages pour un
   * geste qu'on veut « adoucir la boucle » auraient coûté un panneau.
   *
   * Comme les bornes, ne s'applique qu'au fichier d'AnimeThemes — la version
   * YouTube est jouée par un lecteur qu'on ne pilote pas.
   */
  fade: number;
};

/** Le fondu le plus long qu'on accepte : au-delà, l'extrait n'est plus que montée et descente. */
export const MAX_FADE = 5;

export function clampFade(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_FADE, Math.round(n * 10) / 10);
}

/**
 * Le gain à appliquer à `t` secondes, de 0 à 1 — 1 partout si le fondu est nul.
 *
 * Le fondu se calcule à la volée et se pose sur `volume` plutôt que d'ouvrir un
 * `AudioContext` : une rampe WebAudio demanderait un contexte par lecteur, sa
 * reprise après un geste de l'utilisateur, et un `MediaElementSource` qui
 * confisque l'élément. La boucle qui tient déjà le raccord passe soixante fois
 * par seconde ; y poser un `volume` suffit, l'oreille ne distingue pas.
 *
 * Le fondu est écrasé quand l'extrait est plus court que deux fondus : sinon un
 * extrait de 2 s avec 3 s de fondu ne serait jamais audible.
 */
export function fadeGain(
  t: number,
  from: number,
  to: number,
  fade: number,
): number {
  if (!(fade > 0) || !(to > from)) return 1;
  const f = Math.min(fade, (to - from) / 2);
  const inGain = (t - from) / f;
  const outGain = (to - t) / f;
  return Math.max(0, Math.min(1, inGain, outGain));
}

/**
 * L'AGENCEMENT du haut de profil — où se tiennent l'avatar, le nom et les
 * chiffres. Il ne touche ni au fond ni à la musique : c'est la disposition,
 * pas l'habillage. Il voyage quand même avec le reste parce qu'il se choisit
 * au même endroit et se sauvegarde par le même appel.
 *
 *   "band"      l'existant : identité en bas à gauche, quatre cartes dessous ;
 *   "center"    axe centré, le nom devient le titre de la page ;
 *   "medallion" grand avatar rond débordant sur la plaque, chiffres en ligne ;
 *   "column"    identité en colonne collante à gauche, le contenu à droite.
 */
export type HeroLayout = "band" | "center" | "medallion" | "column";

export const HERO_LAYOUTS: HeroLayout[] = ["band", "center", "medallion", "column"];

export function isHeroLayout(v: unknown): v is HeroLayout {
  return typeof v === "string" && (HERO_LAYOUTS as string[]).includes(v);
}

export type Dressing = {
  kind: DressingKind;
  /** Image ou vidéo de fond. `null` pour un fond de couleur. */
  url: string | null;
  /** Couleur du fond quand `kind === "color"`, en #rrggbb. */
  color: string | null;
  animeId: number | null;
  title: string | null;
  /** Nature de l'illustration — décide fond-de-page ou bandeau (types.plateMode). */
  source: BannerOption["source"] | null;
  /**
   * La bande-annonce YouTube portée en fond, quand le fond est de type
   * « video ». Onze caractères, l'identifiant seul.
   *
   * Elle ne passe pas par `url` : une bande-annonce n'est pas un fichier qu'on
   * peut donner à un `<video>`, c'est un lecteur YouTube, et le seul moyen
   * légitime de la jouer est son embed — celui qui sert la publicité qui paie
   * la licence. La liste blanche d'hôtes de `url` reste donc ce qu'elle est.
   */
  trailerId: string | null;
  /** Musique du profil. Prioritaire sur la bande-son d'une vidéo de fond. */
  music: DressingMusic | null;
  /** Flou derrière les widgets, en pixels. */
  blur: number;
  /** Agencement du haut de profil. Absent des anciennes valeurs : « band ». */
  layout: HeroLayout;
};

/**
 * Ce que le dock propose, dans l'ordre où il l'affiche.
 *
 * `ready: false` n'est pas un « à faire » décoratif : ces quatre fonds
 * attendent une source qui n'existe pas encore côté site (aucune vidéothèque,
 * pas de découpage d'épisode, aucun stockage d'import ni d'IA anti-NSFW en
 * ligne). Le bouton reste dans le dock — la palette dit alors ce qui manque,
 * plutôt que de faire disparaître une option annoncée.
 */
export const DRESSING_KINDS: Array<{ id: DressingKind; ready: boolean }> = [
  { id: "color", ready: true },
  { id: "banner", ready: true },
  { id: "anim", ready: false },
  { id: "image", ready: true },
  /* « Vidéo » est servi par les bandes-annonces AniList depuis le 06/09/2026 :
     elles existent pour presque tous les titres, et arrivent dans la requête
     que le profil fait déjà. */
  { id: "video", ready: true },
  { id: "oped", ready: true },
  { id: "clip", ready: false },
  { id: "upload", ready: false },
];

export const MAX_BLUR = 32;

export function clampBlur(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX_BLUR, Math.round(n)));
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(v: unknown): v is string {
  return typeof v === "string" && HEX_RE.test(v);
}

/**
 * Hôtes qu'une vidéo de fond ou une musique peut viser.
 *
 * Même raison que la liste blanche des images (lib/profile/banner.ts) : la
 * valeur est écrite par le propriétaire puis servie à tous les visiteurs de son
 * profil, donc sans liste ce serait un `<video src>` arbitraire sur une page
 * publique. AnimeThemes est le seul hôte pour l'instant — c'est de là que
 * viennent les openings et les endings (lib/animethemes/themes.ts).
 */
const ALLOWED_MEDIA_HOSTS = ["v.animethemes.moe", "a.animethemes.moe"];

export function isAllowedMediaUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length > 500) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ALLOWED_MEDIA_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

/** Un fond de ce type est une vidéo : le plateau la lit au lieu de l'afficher. */
export function isVideoKind(kind: DressingKind | null | undefined): boolean {
  return kind === "oped" || kind === "video" || kind === "clip" || kind === "anim";
}

const KINDS = new Set<string>(DRESSING_KINDS.map((k) => k.id));
const SOURCES = new Set(["background", "thumb", "banner", "anilist", "cover"]);

function str(v: unknown, max = 200): string | null {
  return typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null;
}

/**
 * Les bornes d'un extrait, relues d'une valeur stockée.
 *
 * Une borne seule ne veut rien dire, et une fin avant son début non plus : dans
 * ces cas on rend le morceau entier plutôt qu'un extrait à moitié valide, qui
 * se traduirait à la lecture par un silence qu'on ne saurait pas expliquer.
 */
/**
 * Un identifiant YouTube, ou `null`.
 *
 * Il part dans l'URL d'une iframe : on le valide sur sa forme exacte — onze
 * caractères de l'alphabet YouTube — plutôt que de le laisser passer en texte
 * libre. Tout le reste devient `null`, jamais une chaîne assainie à moitié.
 */
function youtubeId(raw: unknown): string | null {
  const s = str(raw, 16);
  return s && /^[A-Za-z0-9_-]{11}$/.test(s) ? s : null;
}

function trim(rawFrom: unknown, rawTo: unknown): { from: number | null; to: number | null } {
  const from = Number(rawFrom);
  const to = Number(rawTo);
  const ok =
    Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to > from && to < 36000;
  return ok ? { from, to } : { from: null, to: null };
}

/**
 * Relit une valeur stockée — nouvelle forme, ancienne forme, ou n'importe quoi.
 *
 * Retourne `null` quand il n'y a rien d'exploitable, ce qui est exactement le
 * cas « pas d'épinglage, le profil suit son anime préféré ». La validation des
 * URL est faite par l'appelant serveur (les listes blanches) : ici on ne fait
 * que remettre en forme, y compris pour du contenu qui vient déjà de la base.
 */
export function normalizeDressing(raw: unknown): Dressing | null {
  let obj: any = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;

  const kind: DressingKind = KINDS.has(obj.kind)
    ? obj.kind
    : isHexColor(obj.color) && !obj.url
      ? "color"
      : "banner"; /* l'ancienne forme n'avait pas de type : c'était une bannière */

  const url = str(obj.url, 500);
  const color = isHexColor(obj.color) ? obj.color : null;
  /* Une bande-annonce est un fond à elle seule : ni fichier, ni couleur. Sans
     elle dans ce garde-fou, tout l'habillage — musique et agencement compris —
     serait jeté à la relecture d'un profil qui porte un trailer. */
  const trailerId = youtubeId(obj.trailerId);
  if (!url && !color && !trailerId) return null;

  const rawMusic = obj.music;
  const musicUrl = rawMusic ? str(rawMusic.url, 500) : null;
  const videoId = youtubeId(rawMusic?.videoId);

  const music: DressingMusic | null = musicUrl
    ? {
        url: musicUrl,
        title: str(rawMusic.title) || "—",
        artist: str(rawMusic.artist),
        slug: str(rawMusic.slug, 16),
        cover: str(rawMusic.cover, 500),
        ...trim(rawMusic.from, rawMusic.to),
        videoId,
        fade: clampFade(rawMusic.fade),
      }
    : null;

  const animeId = Number(obj.animeId);

  return {
    kind,
    url: kind === "color" ? null : url,
    color: kind === "color" ? color : null,
    animeId: Number.isFinite(animeId) && animeId > 0 ? animeId : null,
    title: str(obj.title, 300),
    source: SOURCES.has(obj.source) ? obj.source : null,
    trailerId: kind === "video" ? trailerId : null,
    music,
    blur: clampBlur(obj.blur),
    layout: isHeroLayout(obj.layout) ? obj.layout : "band",
  };
}

/** Le fond par défaut d'un brouillon de studio : ce que le profil porte déjà. */
export function emptyDressing(): Dressing {
  return {
    kind: "banner",
    url: null,
    color: null,
    animeId: null,
    title: null,
    source: null,
    trailerId: null,
    music: null,
    blur: 0,
    layout: "band",
  };
}
