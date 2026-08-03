/**
 * Per-episode stills for an AniList id, via Simkl: cache → validate → fetch → cache.
 *
 * Simkl's id maps 1:1 onto the AniList entry (Fribb's `simkl_id`), so there is
 * no season to infer. That is why it is now the only stills provider: the TMDB
 * path it replaced had to map a franchise onto a season and then refuse
 * whenever it couldn't prove the match (One Piece has no tmdb_season at all).
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
import {
  getSimklEpisodes,
  resolveSimklId,
  simklEnabled,
  simklStillUrl,
} from "./simklClient";

/** episode number → still URL. Empty when we have nothing trustworthy. */
export type EpisodeStills = Record<number, string>;

/** episode number → title. Simkl numbers each ENTRY from 1, so these line up
 *  with the rows we render — unlike AniList's streamingEpisodes, which serves
 *  the franchise's season-1 list on every sequel entry (see [id].tsx). */
export type EpisodeTitles = Record<number, string>;

export interface SimklEpisodeData {
  stills: EpisodeStills;
  titles: EpisodeTitles;
}

const EMPTY: EpisodeStills = {};
const EMPTY_DATA: SimklEpisodeData = { stills: {}, titles: {} };

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
): Promise<SimklEpisodeData> {
  if (!simklEnabled()) return EMPTY_DATA;

  const cached = await getCachedStills(anilistId, "simkl");
  if (cached) {
    return { stills: cached.stills ?? {}, titles: cached.titles ?? {} };
  }

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
    return EMPTY_DATA;
  };

  if (!displayedEpisodes || displayedEpisodes <= 0) {
    return refuse("unknown-episode-count");
  }

  /* Fribb first (a local row, no network), then ask Simkl itself.
     Fribb's Simkl coverage is partial and skewed against new shows — 14,480 of
     its 42,868 entries carry a simkl_id — so relying on it alone left airing
     titles with no stills at all and every row falling back to the same pool
     placeholder. Measured case: AniList 208044, `simkl_id: null` in Fribb while
     Simkl has the entry with 6 stills.
     A missing Fribb row is no longer fatal either: the AniList id alone is
     enough for the lookup, `mal_id` is only a second chance. */
  const entry = await getFribbEntry(anilistId);
  const simklId =
    entry?.simklId ?? (await resolveSimklId(anilistId, entry?.malId ?? null));
  if (simklId == null) return refuse("no-simkl-id");

  const all = await getSimklEpisodes(simklId);
  if (!all) return refuse("simkl-error", simklId);

  // Specials are numbered in their own sequence and would collide with real
  // episode numbers.
  const episodes = all.filter((e) => e.type === "episode");

  if (episodes.length < displayedEpisodes) {
    return refuse("too-few-episodes", simklId);
  }

  const stills: EpisodeStills = {};
  const titles: EpisodeTitles = {};
  for (const ep of episodes) {
    // Ignore anything past what we render (Simkl runs ahead on airing shows).
    if (ep.episode < 1 || ep.episode > displayedEpisodes) continue;
    const url = simklStillUrl(ep.img);
    if (url) stills[ep.episode] = url;
    /* Simkl labels an untitled episode "Episode N" — that's what the caller
       already falls back to, so keeping it would just fake a real title. */
    const title = typeof ep.title === "string" ? ep.title.trim() : "";
    if (title && !/^episode\s+\d+$/i.test(title)) titles[ep.episode] = title;
  }

  const count = Object.keys(stills).length;
  if (count === 0) return refuse("no-images", simklId);

  const value: StillsCacheValue = {
    stills,
    titles,
    reason: "ok",
    tvId: simklId,
    season: null,
  };
  await setCachedStills(anilistId, value, "simkl");
  console.info(
    `[simkl-stills] ${anilistId}: ${count}/${displayedEpisodes} stills, ` +
      `${Object.keys(titles).length} titles (simkl ${simklId})`,
  );
  return { stills, titles };
}
