/**
 * Per-episode stills from TMDB — a strict COMPLEMENT to Simkl, never a rival.
 *
 * Read lib/simkl/episodeStills.ts first: Simkl's id indexes the same entry
 * AniList does, so it needs no season inference, and that is why it replaced
 * TMDB here on 2026-08-03. Nothing about that has changed. What changed is
 * that we now hold a TMDB key again for series artwork (backdrops, logos —
 * lib/tmdb/animeImages.ts), and the marginal cost of asking it for the
 * episodes Simkl could not cover is one request.
 *
 * THE RULE, and it is the whole safety argument: TMDB may only write into
 * episode numbers Simkl left EMPTY. It never overwrites a Simkl still and
 * never contributes a title. A season mis-mapping can therefore leave a row
 * with a placeholder — the status quo — but can never replace a correct frame
 * with a wrong one.
 *
 * WHY THIS ISN'T THE OLD CODE. The removed implementation was the sole
 * provider and had to prove its mapping, so it demanded an exact
 * episode-count equality and refused on every airing show and every split
 * cour. Here the floor is the one Simkl uses (TMDB must know AT LEAST as many
 * episodes as we display) because a wrong guess costs a missing image, not a
 * wrong one.
 *
 * WHAT WE STILL REFUSE. Fribb's `season.tmdb` is its weakest field — it
 * collides and fuses (Bungo Stray Dogs: 1,1,2,3,3) and is null on long sagas
 * (One Piece, Naruto). No season, no fill. `isFribbGroupConsistent()` is not
 * consulted: it arbitrates franchise ORDER, and a null/instinctively-wrong
 * season already fails the floor check below.
 *
 * Fail-soft throughout; nothing throws.
 */

import {
  getCachedStills,
  setCachedStills,
  type StillsCacheValue,
} from "@/lib/db/tmdbStillsCache";
import { getFribbEntry } from "@/lib/fribb/fribbMap";
import { getSeasonEpisodes, tmdbEnabled, tmdbImageUrl } from "./client";

/** episode number → still URL. */
export type TmdbStills = Record<number, string>;

const EMPTY: TmdbStills = {};

/* w300 matches what the episode rows render at (~250 CSS px wide thumbs).
   next.config.js sets `images.unoptimized: true`, so this URL is exactly what
   the browser downloads — see lib/images/cover.ts for the same reasoning. */
const STILL_SIZE = "w300" as const;

type Reason =
  | "ok"
  | "no-key"
  | "no-fribb"
  | "no-tmdb-id"
  | "no-season"
  | "unknown-episode-count"
  | "too-few-episodes"
  | "no-images"
  | "tmdb-error";

/**
 * Stills for `anilistId`, for the episodes in `wanted`.
 *
 * `wanted` is the set of episode numbers still missing an image after Simkl —
 * pass it so a title Simkl covered fully costs nothing at all.
 */
export async function getTmdbEpisodeStills(
  anilistId: number,
  displayedEpisodes: number | null,
  wanted: Set<number>,
): Promise<TmdbStills> {
  if (!tmdbEnabled()) return EMPTY;
  if (wanted.size === 0) return EMPTY;

  /* Reuses the `tmdbStills:v1:` cache key of the removed implementation, on
     purpose. Its last rows were written 2026-08-03 and the TTLs here are 7
     days (hit) / 24 h (refusal), so every one of them already reads as a miss
     — there is nothing stale left to inherit, and a second key would strand
     the rows this code is about to write next to them. */
  const cached = await getCachedStills(anilistId, "tmdb");
  if (cached) return cached.stills ?? {};

  const refuse = async (
    reason: Reason,
    tvId: number | null = null,
    season: number | null = null,
  ): Promise<TmdbStills> => {
    // A transient failure must not be cached as "no stills" for a day.
    if (reason !== "tmdb-error") {
      const value: StillsCacheValue = { stills: {}, reason, tvId, season };
      await setCachedStills(anilistId, value, "tmdb");
    }
    // warn, not info: Vercel's log stream drops console.info, and "this title
    // shows placeholder tiles" is the symptom we get asked about.
    console.warn(`[tmdb-stills] ${anilistId}: no stills (${reason})`);
    return EMPTY;
  };

  if (!displayedEpisodes || displayedEpisodes <= 0) {
    return refuse("unknown-episode-count");
  }

  const entry = await getFribbEntry(anilistId);
  if (!entry) return await refuse("no-fribb");
  if (!entry.tmdbTvId) return await refuse("no-tmdb-id");
  if (entry.tmdbSeason == null) {
    return await refuse("no-season", entry.tmdbTvId);
  }

  const episodes = await getSeasonEpisodes(entry.tmdbTvId, entry.tmdbSeason);
  // null is a failed request or a 404 on the season, not "no stills".
  if (!episodes) {
    return await refuse("tmdb-error", entry.tmdbTvId, entry.tmdbSeason);
  }

  /* Same floor as Simkl, not the old exact equality: a provider that knows
     MORE episodes than we display is normal (it runs ahead on airing shows);
     one that knows FEWER is a suspect mapping — most often Fribb pointing at a
     fused or renumbered season. */
  if (episodes.length < displayedEpisodes) {
    return await refuse("too-few-episodes", entry.tmdbTvId, entry.tmdbSeason);
  }

  const stills: TmdbStills = {};
  for (const ep of episodes) {
    const n = Number(ep.episode_number);
    if (!Number.isFinite(n) || n < 1 || n > displayedEpisodes) continue;
    const url = tmdbImageUrl(ep.still_path, STILL_SIZE);
    if (url) stills[n] = url;
  }

  if (Object.keys(stills).length === 0) {
    return await refuse("no-images", entry.tmdbTvId, entry.tmdbSeason);
  }

  /* Cache the WHOLE season, not just the `wanted` subset. `wanted` varies with
     what Simkl happened to return on this particular request; caching the
     intersection would make the row depend on another provider's transient
     state, and a later request wanting a different episode would get a false
     "no". Filtering to `wanted` is the caller's job, below. */
  await setCachedStills(
    anilistId,
    {
      stills,
      reason: "ok",
      tvId: entry.tmdbTvId,
      season: entry.tmdbSeason,
    },
    "tmdb",
  );
  console.warn(
    `[tmdb-stills] ${anilistId}: ${Object.keys(stills).length}/${displayedEpisodes} ` +
      `stills (tmdb ${entry.tmdbTvId} s${entry.tmdbSeason})`,
  );
  return stills;
}

/**
 * Simkl's stills, with TMDB filling only the gaps.
 *
 * Returns the Simkl map untouched when it is already complete — which also
 * means no TMDB call is made for those titles.
 */
export async function fillStillGaps(
  anilistId: number,
  displayedEpisodes: number | null,
  simklStills: Record<number, string>,
): Promise<Record<number, string>> {
  if (!tmdbEnabled() || !displayedEpisodes || displayedEpisodes <= 0) {
    return simklStills;
  }

  const wanted = new Set<number>();
  for (let n = 1; n <= displayedEpisodes; n++) {
    if (!simklStills[n]) wanted.add(n);
  }
  if (wanted.size === 0) return simklStills;

  const tmdb = await getTmdbEpisodeStills(anilistId, displayedEpisodes, wanted).catch(
    () => EMPTY,
  );

  // forEach, not for..of: tsconfig targets ES5 without downlevelIteration, so
  // iterating a Set directly doesn't compile.
  const merged = { ...simklStills };
  wanted.forEach((n) => {
    if (tmdb[n]) merged[n] = tmdb[n];
  });
  return merged;
}
