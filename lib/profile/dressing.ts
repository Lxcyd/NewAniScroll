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
};

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
  /** Musique du profil. Prioritaire sur la bande-son d'une vidéo de fond. */
  music: DressingMusic | null;
  /** Flou derrière les widgets, en pixels. */
  blur: number;
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
  { id: "video", ready: false },
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
  if (!url && !color) return null;

  const rawMusic = obj.music;
  const musicUrl = rawMusic ? str(rawMusic.url, 500) : null;
  /* Cet identifiant part dans l'URL d'une iframe : on le valide sur la forme
     exacte d'un id YouTube (11 caractères) plutôt que de le laisser passer en
     texte libre. Tout le reste devient null, pas une chaîne assainie à moitié. */
  const rawVideoId = rawMusic ? str(rawMusic.videoId, 16) : null;
  const videoId =
    rawVideoId && /^[A-Za-z0-9_-]{11}$/.test(rawVideoId) ? rawVideoId : null;

  const music: DressingMusic | null = musicUrl
    ? {
        url: musicUrl,
        title: str(rawMusic.title) || "—",
        artist: str(rawMusic.artist),
        slug: str(rawMusic.slug, 16),
        cover: str(rawMusic.cover, 500),
        videoId,
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
    music,
    blur: clampBlur(obj.blur),
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
    music: null,
    blur: 0,
  };
}
