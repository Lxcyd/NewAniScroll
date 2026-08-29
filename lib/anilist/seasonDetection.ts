/**
 * Shared season-detection primitives.
 *
 * Historically the season-numbering logic was copy-pasted in three places
 * (components/anime/v2/helpers.ts, lib/anilist/seasonChain.ts, and the ported
 * copy in pages/api/v2/source/index.js). The copies drifted, so the info page
 * and the streaming panel picker could disagree on which season an entry is —
 * which is one of the SNK "wrong episode" symptoms.
 *
 * This module is the single source of truth for the *predicates* that guard the
 * relation walk. It stays framework-free (no React, no i18n) so the API route
 * can import it too. The title-parsing helpers (extractSeasonFromTitle,
 * isSeasonContinuation) still live in components/anime/v2/helpers.ts and are
 * re-exported from here so all callers reach them through one path.
 */

export {
  extractSeasonFromTitle,
  isSeasonContinuation,
  continuesSameWork,
  nextSeasonNumber,
  seasonTitleBase,
  isSeasonLike,
  sharesFranchise,
  // Season-chain guards live in helpers.ts (that file is the pure source; this
  // module re-exports so non-React callers reach everything through one path).
  yearOf,
  isChainableRelation,
  edgeYearMonotonic,
  isRecapTitle,
} from "@/components/anime/v2/helpers";

/** Minimal shape we need off an AniList Media / relation node. */
export type SeasonNode = {
  id?: number | string;
  type?: string | null;
  format?: string | null;
  seasonYear?: number | null;
  startDate?: { year?: number | null } | null;
  title?: {
    english?: string | null;
    romaji?: string | null;
    native?: string | null;
    userPreferred?: string | null;
  } | null;
};
