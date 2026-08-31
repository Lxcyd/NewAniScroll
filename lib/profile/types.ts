/**
 * One list entry, in the single shape every profile source is normalised to.
 *
 * The three sources are an AniList MediaListCollection, the cloud backup of an
 * AniScroll account's local list, and this device's own localStorage — they
 * disagree on field names and on the score format, and normalising here is what
 * lets one component render all three (the user's requirement: the profile page
 * looks the same whichever account it is).
 *
 * `score` is POINT_10_DECIMAL everywhere: the AniList query asks for that
 * format explicitly, the local list already stores it.
 */

export type BannerOption = {
  url: string;
  /** fanart type, or where it came from when it isn't a fanart. */
  source: "background" | "thumb" | "banner" | "anilist" | "cover";
  likes: number;
};

/**
 * How a plate is worn. The two kinds of art are not interchangeable:
 *
 *   "page" — a full ILLUSTRATION (a 16:9 background, a thumb, a cover). It is a
 *            picture, so it becomes the background of the whole page and the
 *            profile is read on top of it.
 *   "band" — a BANNER: AniList's 1900x400 strip, or a 1000x185 fanart banner.
 *            Those are composed as a strip and have nothing above or below the
 *            crop, so blowing one up to fill a screen only magnifies it. It
 *            stays a strip at the top.
 *
 * Lives here, next to the types, rather than in lib/profile/banner.ts: that
 * module reaches the fanart database, and the hero component — which is what
 * asks this question — must not drag a libSQL client into the browser bundle.
 */
export function plateMode(
  source: BannerOption["source"] | null | undefined,
): "page" | "band" {
  return source === "anilist" || source === "banner" ? "band" : "page";
}

export type ProfileTitle = {
  english?: string | null;
  romaji?: string | null;
  native?: string | null;
  userPreferred?: string | null;
};

export type ProfileEntry = {
  mediaId: number;
  status: string | null;
  progress: number;
  score: number | null;
  /** Total episodes when known — drives the progress bar. */
  total: number | null;
  title: ProfileTitle | null;
  cover: string | null;
  /** AniList favourite. Always false for a list with no favourites. */
  favourite?: boolean;
  /** Rewatch count. */
  repeat?: number;
  /* Les quatre champs suivants n'existent que sur une liste AniList : ils
     viennent de la meme requete, sans appel supplementaire. Une liste locale ne
     les connait pas, et les blocs qui en dependent affichent alors leur etat
     vide plutot qu'un classement construit sur trois entrees. */
  /** TV, MOVIE, OVA, ONA, SPECIAL… */
  format?: string | null;
  /** Annee de premiere diffusion. */
  year?: number | null;
  genres?: string[];
  /** Studio principal. */
  studio?: string | null;
};

/** Un personnage favori, tel qu'AniList le publie. */
export type ProfileCharacter = {
  id: number;
  name: string;
  image: string | null;
  /** L'anime d'ou il vient, quand AniList le donne. */
  from?: string | null;
};

export type ProfileIdentity = {
  name: string;
  tag: string | null;
  avatar: string | null;
  anilistName: string | null;
  createdAt: number | null;
};

export type ProfileStats = {
  count: number;
  episodes: number;
  /** Minutes watched. Null when the source doesn't know — a local list has no
   *  runtime for its entries, and inventing one would be a fabricated stat. */
  minutes: number | null;
  /** The viewer's own mean score, /10. */
  meanScore: number | null;
};
