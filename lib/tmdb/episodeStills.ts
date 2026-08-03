/**
 * Episode stills for an AniList id: cache → resolve+validate → TMDB → cache.
 *
 * The one entry point the episode API calls. Everything here is fail-soft: any
 * miss, refusal, outage or misconfiguration returns an empty map, and the
 * client varies the row image from the fanart pool instead
 * (lib/images/episodeImagePool.ts). Nothing throws.
 */

import {
  getCachedStills,
  setCachedStills,
  type StillsCacheValue,
} from "@/lib/db/tmdbStillsCache";
import { resolveTmdbSeasonForAnilist } from "./resolveTmdbSeason";
import { getTmdbSeasonEpisodes, tmdbStillUrl, tmdbEnabled } from "./tmdbClient";

/** episode number → still URL. Empty when we have nothing trustworthy. */
export type EpisodeStills = Record<number, string>;

const EMPTY: EpisodeStills = {};

export async function getEpisodeStills(
  anilistId: number,
  anilistEpisodes: number | null,
): Promise<EpisodeStills> {
  if (!tmdbEnabled()) return EMPTY;

  const cached = await getCachedStills(anilistId);
  if (cached) return cached.stills ?? EMPTY;

  const match = await resolveTmdbSeasonForAnilist(anilistId, anilistEpisodes);

  if (!match.trusted || match.tvId == null || match.season == null) {
    // Don't cache a transient failure as "no stills" — it'd stick for a day.
    if (match.reason !== "tmdb-error") {
      await setCachedStills(anilistId, {
        stills: {},
        reason: match.reason,
        tvId: match.tvId,
        season: match.season,
      });
    }
    console.info(
      `[tmdb-stills] ${anilistId}: no stills (${match.reason})`,
    );
    return EMPTY;
  }

  const episodes = await getTmdbSeasonEpisodes(match.tvId, match.season);
  if (!episodes) {
    // Reached TMDB for the show but not the season — transient, so no cache.
    console.info(`[tmdb-stills] ${anilistId}: season fetch failed`);
    return EMPTY;
  }

  /* Re-validate on arrival: TMDB's show summary and season detail can disagree,
     and the summary's episode_count is what we validated against. If they've
     drifted, the mapping we trusted no longer holds — refuse. */
  if (match.episodeCount != null && episodes.length !== match.episodeCount) {
    await setCachedStills(anilistId, {
      stills: {},
      reason: "count-mismatch",
      tvId: match.tvId,
      season: match.season,
    });
    console.info(
      `[tmdb-stills] ${anilistId}: season detail has ${episodes.length} eps, ` +
        `summary said ${match.episodeCount} — refusing`,
    );
    return EMPTY;
  }

  // Keyed by TMDB's own episode_number, never array position.
  const stills: EpisodeStills = {};
  for (const ep of episodes) {
    const url = tmdbStillUrl(ep.still);
    if (url) stills[ep.number] = url;
  }

  const value: StillsCacheValue = {
    stills,
    reason: "ok",
    tvId: match.tvId,
    season: match.season,
  };
  await setCachedStills(anilistId, value);
  console.info(
    `[tmdb-stills] ${anilistId}: ${Object.keys(stills).length} stills ` +
      `(tv ${match.tvId} s${match.season})`,
  );
  return stills;
}
