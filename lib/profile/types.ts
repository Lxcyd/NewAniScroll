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
