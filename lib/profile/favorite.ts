/**
 * "Anime prefere" — the one title a profile is dressed in.
 *
 * The rule is the user's, in this exact order (2026-08-30):
 *   1. the score THEY gave it          (highest wins)
 *   2. favourite or not                (a favourite beats a non-favourite)
 *   3. number of rewatches             (highest wins)
 *   4. the anime's own average score   (highest wins)
 *
 * Each criterion only speaks when the one above it ties, which is why this is a
 * comparator chain and not a weighted score: a 9/10 never loses to an 8/10 that
 * happens to be a favourite.
 *
 * Both list sources feed the same shape. Scores are POINT_10_DECIMAL on both
 * sides — the AniList query asks for that format explicitly, the local list
 * stores it natively — so the two are directly comparable and a profile looks
 * the same whichever account it is read from.
 *
 * `meanScore` is the ONLY field that costs an extra lookup, and it is needed
 * only when the first three criteria all tie. Callers resolve it lazily: rank
 * first, then fill in the mean score for the group still tied at the top.
 */

import type { ProfileEntry } from "./types";

export type FavoriteCandidate = {
  mediaId: number;
  /** The user's rating, /10. null when unrated — an unrated title loses. */
  score: number | null;
  /** AniList favourite. Always false for a list that has no favourites. */
  favourite: boolean;
  /** AniList `repeat` — how many times it was rewatched. */
  repeat: number;
  /** The anime's own average, /100. null when not resolved yet. */
  meanScore?: number | null;
};

/**
 * Which entries may dress a profile at all: **only a title that was finished.**
 *
 * A score given before the end is not a verdict on the show — it is an
 * expectation ("Planning") or an impression mid-run ("Watching"), and it is
 * routinely a 10 that never survives the ending. Measured on a real 683-entry
 * list: 300 planned, 95 in progress, 89 paused — 187 actually finished. Eleven
 * planned-and-untouched titles, all rated 10, filled the whole top of the
 * ranking ahead of shows their owner had really seen, and the first thing their
 * owner said about the picker was "Orb? I haven't watched that."
 *
 * `REPEATING` counts, and is the reason the test is not simply "completed": a
 * rewatch means it was finished at least once — the strongest verdict there is.
 * `PAUSED` and `DROPPED` do not: the story was never seen through, so the score
 * is not about the same object as a finished show's.
 */
const FINISHED = new Set(["COMPLETED", "REPEATING"]);

export function bannerCandidates(
  entries: ProfileEntry[],
  meanScoreOf?: (mediaId: number) => number | null | undefined,
): FavoriteCandidate[] {
  return entries
    .filter((e) => FINISHED.has(e.status || ""))
    .map((e) => ({
      mediaId: e.mediaId,
      score: e.score,
      favourite: !!e.favourite,
      repeat: e.repeat || 0,
      meanScore: meanScoreOf?.(e.mediaId) ?? null,
    }));
}

/** How many of the first-three-criteria ties are worth a mean-score lookup. */
export const MEAN_SCORE_TIE_LIMIT = 8;

function cmp(a: FavoriteCandidate, b: FavoriteCandidate): number {
  // 1. the user's score. Unrated sorts below every rated entry.
  const sa = a.score ?? -1;
  const sb = b.score ?? -1;
  if (sa !== sb) return sb - sa;
  // 2. favourite.
  if (a.favourite !== b.favourite) return a.favourite ? -1 : 1;
  // 3. rewatches.
  if ((a.repeat || 0) !== (b.repeat || 0)) return (b.repeat || 0) - (a.repeat || 0);
  // 4. the anime's own average. Unknown sorts last so a resolved mean always
  //    wins over one we could not look up.
  const ma = a.meanScore ?? -1;
  const mb = b.meanScore ?? -1;
  if (ma !== mb) return mb - ma;
  // Nothing separates them: the id, so the pick is stable across reloads
  // rather than depending on the order the list came back in.
  return a.mediaId - b.mediaId;
}

export function rankCandidates<T extends FavoriteCandidate>(list: T[]): T[] {
  return list.slice().sort(cmp);
}

/**
 * The entries still tied after criteria 1-3 — i.e. the only ones whose mean
 * score can change the outcome. Capped, because a brand-new list where nothing
 * is rated ties on all three and would otherwise ask for every title at once.
 */
export function tiedHead<T extends FavoriteCandidate>(
  list: T[],
  limit = MEAN_SCORE_TIE_LIMIT,
): T[] {
  const ranked = rankCandidates(list);
  const head = ranked[0];
  if (!head) return [];
  const tied = ranked.filter(
    (e) =>
      (e.score ?? -1) === (head.score ?? -1) &&
      e.favourite === head.favourite &&
      (e.repeat || 0) === (head.repeat || 0),
  );
  return tied.slice(0, limit);
}

export function pickFavorite<T extends FavoriteCandidate>(list: T[]): T | null {
  return rankCandidates(list)[0] ?? null;
}
