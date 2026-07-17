/**
 * Per-episode stills for an AniList id, via Simkl: cache → validate → fetch → cache.
 *
 * Simkl's id maps 1:1 onto the AniList entry (Fribb's `simkl_id`), so unlike
 * TMDB there is no season to infer — which is why this works for the titles
 * lib/tmdb/resolveTmdbSeason.ts must refuse (One Piece: no tmdb_season at all).
 *
 * We still validate rather than trust. The check is a floor, not equality:
 *   - Drop `type: "special"` first — specials inflate the count (AoT S1 returns
 *     40 rows: 25 episodes + 15 specials; after filtering it's exactly 25).
 *   - Require Simkl to know AT LEAST as many episodes as we display. Measured
 *     drift is Simkl-ahead on airing shows (One Piece 1172 vs AniList's 1169
 *     aired, Conan 1212 vs 1206) — harmless, because we only ever read the
 *     numbers we actually render.
 *   - If Simkl knows FEWER, the mapping is suspect (wrong entry, or its list is
 *     truncated) → refuse, and rows fall back to the fanart pool.
 *
 * Everything is fail-soft; nothing throws.
 */

import {
  getCachedStills,
  setCachedStills,
  type StillsCacheValue,
} from "@/lib/db/tmdbStillsCache";
import { getFribbEntry } from "@/lib/fribb/fribbMap";
import { getSimklEpisodes, simklEnabled, simklStillUrl } from "./simklClient";

/** episode number → still URL. Empty when we have nothing trustworthy. */
export type EpisodeStills = Record<number, string>;

const EMPTY: EpisodeStills = {};

type Reason =
  | "ok"
  | "no-key"
  | "no-fribb"
  | "no-simkl-id"
  | "unknown-episode-count"
  | "too-few-episodes"
  | "no-images"
  | "simkl-error";

export async function getSimklEpisodeStills(
  anilistId: number,
  /** How many episodes we actually display: AniList's total, or aired-so-far
   *  for an airing show. Null when we know neither — nothing to validate. */
  displayedEpisodes: number | null,
): Promise<EpisodeStills> {
  if (!simklEnabled()) return EMPTY;

  const cached = await getCachedStills(anilistId, "simkl");
  if (cached) return cached.stills ?? EMPTY;

  const refuse = async (reason: Reason, simklId: number | null = null) => {
    // Never cache a transient failure as "no stills" — it'd stick for a day.
    if (reason !== "simkl-error") {
      const value: StillsCacheValue = {
        stills: {},
        reason,
        tvId: simklId,
        season: null,
      };
      await setCachedStills(anilistId, value, "simkl");
    }
    console.info(`[simkl-stills] ${anilistId}: no stills (${reason})`);
    return EMPTY;
  };

  if (!displayedEpisodes || displayedEpisodes <= 0) {
    return refuse("unknown-episode-count");
  }

  const entry = await getFribbEntry(anilistId);
  if (!entry) return refuse("no-fribb");
  if (entry.simklId == null) return refuse("no-simkl-id");

  const all = await getSimklEpisodes(entry.simklId);
  if (!all) return refuse("simkl-error", entry.simklId);

  // Specials are numbered in their own sequence and would collide with real
  // episode numbers.
  const episodes = all.filter((e) => e.type === "episode");

  if (episodes.length < displayedEpisodes) {
    return refuse("too-few-episodes", entry.simklId);
  }

  const stills: EpisodeStills = {};
  for (const ep of episodes) {
    // Ignore anything past what we render (Simkl runs ahead on airing shows).
    if (ep.episode < 1 || ep.episode > displayedEpisodes) continue;
    const url = simklStillUrl(ep.img);
    if (url) stills[ep.episode] = url;
  }

  const count = Object.keys(stills).length;
  if (count === 0) return refuse("no-images", entry.simklId);

  const value: StillsCacheValue = {
    stills,
    reason: "ok",
    tvId: entry.simklId,
    season: null,
  };
  await setCachedStills(anilistId, value, "simkl");
  console.info(
    `[simkl-stills] ${anilistId}: ${count}/${displayedEpisodes} stills (simkl ${entry.simklId})`,
  );
  return stills;
}
