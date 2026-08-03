/**
 * AniList id → TMDB (tv id, season), or a refusal.
 *
 * This module is deliberately a machine for saying NO.
 *
 * TMDB's season numbering does not agree with AniList's for anime. It fuses
 * split cours, mislabels sequels and leaves long sagas unnumbered — see the
 * warnings in lib/fribb/fribbMap.ts and lib/anilist/resolveSeason.ts, and the
 * header of lib/jikan/episodeScores.ts, which rejected TMDB outright for
 * per-episode data. Pulling a still from the wrong season would be WORSE than
 * the bug we're fixing: ten identical banners are obviously placeholder, but a
 * confident image from season 2 on a season 1 row is a lie the viewer cannot
 * detect, and it spoils the show.
 *
 * So: unless every guard passes, we return `trusted: false` and the caller
 * silently falls back to lib/images/episodeImagePool.ts. Refusal is the
 * designed outcome for a large share of the catalogue, not a failure.
 *
 * `reason` is not decoration — it's persisted in the stills cache so a bad
 * mapping can be diagnosed later without re-running anything.
 */

import {
  getFribbEntry,
  getFribbFranchise,
  isFribbGroupConsistent,
} from "@/lib/fribb/fribbMap";
import { getTmdbShow, tmdbEnabled } from "./tmdbClient";

export type TmdbMatchReason =
  | "ok"
  | "no-key"
  | "no-fribb"
  | "no-tmdb-tv"
  | "movie"
  | "no-season"
  | "specials"
  | "group-inconsistent"
  | "unknown-episode-count"
  | "season-missing"
  | "count-mismatch"
  | "tmdb-error";

export interface TmdbSeasonMatch {
  tvId: number | null;
  season: number | null;
  /** TMDB's episode_count for that season, once validated. */
  episodeCount: number | null;
  /** Only ever true when EVERY guard passed. Callers must check this. */
  trusted: boolean;
  reason: TmdbMatchReason;
}

function refuse(reason: TmdbMatchReason, tvId: number | null = null): TmdbSeasonMatch {
  return { tvId, season: null, episodeCount: null, trusted: false, reason };
}

/**
 * @param anilistEpisodes AniList's episode count for THIS entry. Null (an
 *   airing show whose count we derived from nextAiringEpisode) is a refusal:
 *   the count is the only validation we have, so without it we can't trust the
 *   mapping. Airing shows are also the most likely to carry real
 *   `streamingEpisodes` thumbs anyway.
 */
export async function resolveTmdbSeasonForAnilist(
  anilistId: number,
  anilistEpisodes: number | null,
): Promise<TmdbSeasonMatch> {
  if (!tmdbEnabled()) return refuse("no-key");

  // Guard: we can't validate a count we don't have.
  if (!anilistEpisodes || anilistEpisodes <= 0) {
    return refuse("unknown-episode-count");
  }

  const entry = await getFribbEntry(anilistId);
  if (!entry) return refuse("no-fribb");

  if (entry.tmdbTvId == null) {
    // A movie has no episode stills to offer; say so distinctly so the cache
    // doesn't keep retrying it as if it were a lookup failure.
    return refuse(entry.tmdbMovieId != null ? "movie" : "no-tmdb-tv");
  }
  const tvId = entry.tmdbTvId;

  if (entry.tmdbSeason == null) return refuse("no-season", tvId); // One Piece / Naruto
  if (entry.tmdbSeason === 0) return refuse("specials", tvId); // TMDB's specials bucket

  /* The same guard the season resolver already trusts to reject TMDB's fused
     groupings (Bungo Stray Dogs' 1,1,2,3,3). Not reimplemented, not softened. */
  const franchise = await getFribbFranchise(tvId);
  if (!isFribbGroupConsistent(franchise)) return refuse("group-inconsistent", tvId);

  const show = await getTmdbShow(tvId);
  if (!show) return refuse("tmdb-error", tvId);

  const summary = show.seasons.find((s) => s.seasonNumber === entry.tmdbSeason);
  if (!summary) return refuse("season-missing", tvId);

  /* The decisive guard. Exact equality, no tolerance: AniList 12 vs TMDB 24 is
     the fused-cour signature, and a ±1 slack would admit a 12-vs-13 mismatch
     that silently shifts every still by one episode. */
  if (summary.episodeCount !== anilistEpisodes) {
    return refuse("count-mismatch", tvId);
  }

  return {
    tvId,
    season: entry.tmdbSeason,
    episodeCount: summary.episodeCount,
    trusted: true,
    reason: "ok",
  };
}
