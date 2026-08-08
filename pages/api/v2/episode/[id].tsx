// @ts-nocheck

import { rateLimiterRedis, rateSuperStrict, redis } from "@/lib/redis";
import { NextApiRequest, NextApiResponse } from "next";
import { anilistFetch } from "@/lib/anilist/anilistFetch";
import { getCachedAnime } from "@/lib/db/anime";
import {
  getSimklEpisodeStills,
  type SimklEpisodeData,
} from "@/lib/simkl/episodeStills";
import { fillStillGaps } from "@/lib/tmdb/episodeStills";
import {
  getAniZipEpisodes,
  type AniZipEpisodeData,
} from "@/lib/anizip/episodes";

/**
 * Episode API — generates episode lists from AniList data.
 * No external provider (consumet, anify) needed since we use megaplay.buzz iframe embeds.
 */

async function fetchAniListEpisodes(id: string) {
  const json = await anilistFetch({
    query: `query ($id: Int) {
      Media (id: $id) {
        episodes
        nextAiringEpisode { episode }
        status
        title { romaji english }
        coverImage { extraLarge }
        bannerImage
        streamingEpisodes { title thumbnail url site }
      }
    }`,
    variables: { id: Number(id) },
    label: `episode:${id}`,
  });
  return json?.data?.Media || null;
}

/** How many episode rows we render: AniList's total, or aired-so-far for an
 *  ongoing show. Shared with the stills lookups so they validate against the
 *  exact count we display. */
function displayedEpisodeCount(media: any): number {
  let totalEpisodes = media?.episodes;
  if (!totalEpisodes && media?.nextAiringEpisode?.episode) {
    totalEpisodes = media.nextAiringEpisode.episode - 1; // aired so far
  }
  if (!totalEpisodes || totalEpisodes <= 0) {
    // Ongoing with no episode count — show at least 1
    totalEpisodes = media?.status === "RELEASING" ? 1 : 0;
  }
  return totalEpisodes;
}

/**
 * True when `streamingEpisodes` describes a DIFFERENT entry than this one.
 *
 * Crunchyroll attaches its catalogue to the franchise, and AniList copies that
 * same list onto every sequel entry — so Shingeki S3 (episodes=12) ships the
 * 25 season-1 titles, and the rows read "To You, 2,000 Years in the Future"
 * under a "Season 3" pill. Measured across the library: every S1 matches its
 * own count exactly, every sequel over-runs it (SnK S2/S3/S3P2/Final/FinalP2,
 * Demon Slayer S2/S3, JJK S2), and in each of those the first title is S1's.
 *
 * The signal is strictly MORE entries than the season has, which cannot be a
 * list of this season. Fewer is legitimate partial coverage — One Piece has 69
 * of 1169 — and those 69 really are One Piece's, so we keep them.
 */
function streamingEpisodesAreForeign(media: any): boolean {
  const listed = Array.isArray(media?.streamingEpisodes)
    ? media.streamingEpisodes.filter((e: any) => e?.title || e?.thumbnail).length
    : 0;
  const own = media?.episodes;
  if (!listed || !own || own <= 0) return false;
  return listed > own;
}

function buildEpisodeList(
  id: string,
  media: any,
  stills: Record<number, string> = {},
  titles: Record<number, string> = {},
) {
  const totalEpisodes = displayedEpisodeCount(media);

  // AniList provides per-episode thumbnails for Crunchyroll/Funimation
  // titles via `streamingEpisodes`. They come ordered by air date but
  // titles like "Episode 1 - Foo" need a number extracted to map back
  // to an episode index. We try the number out of the title, then fall
  // back to the array index.
  const streamingByNum: Record<number, { thumbnail: string; title: string }> = {};
  if (Array.isArray(media?.streamingEpisodes) && !streamingEpisodesAreForeign(media)) {
    media.streamingEpisodes.forEach((se: any, idx: number) => {
      if (!se?.thumbnail) return;
      const m = String(se.title || "").match(/Episode\s+(\d+)/i);
      const num = m ? Number(m[1]) : idx + 1;
      if (!streamingByNum[num]) {
        streamingByNum[num] = { thumbnail: se.thumbnail, title: se.title };
      }
    });
  }

  const episodes = Array.from({ length: totalEpisodes }, (_, i) => {
    const num = i + 1;
    const streaming = streamingByNum[num];
    /* AniList sometimes returns titles like
       "Episode 1 - To You, 2,000 Years in the Future (1)"
       where the trailing "(1)" / "(2)" is a part-indicator (split arc
       across 2 episodes). Strip both the "Episode N -" prefix and a
       trailing "(<number>)" so the displayed title is just the human
       title. */
    const cleanTitle = streaming?.title
      ?.replace(/^Episode\s+\d+\s*-\s*/i, "")
      .replace(/\s*\(\d+\)\s*$/, "")
      .trim();
    return {
      id: `megaplay-${id}-${num}`,
      /* Simkl backs the sequels up: it keys on THIS entry and numbers from 1,
         so it has real titles exactly where streamingEpisodes was rejected as
         foreign (and where AniList lists nothing at all — Chainsaw Man). */
      title: cleanTitle || titles[num] || `Episode ${num}`,
      number: num,
      /* Only a genuinely per-episode image, or null. We used to fall back to
         the anime's banner here, which handed EVERY row the same image — the
         "10 identical tiles" bug. Null lets the client vary the tile from the
         fanart pool instead (lib/images/episodeImagePool.ts); it has the
         artwork loaded already, and this response is a shared 30-day cache
         blob, so a pick made here would freeze one viewer's choice for all.

         AniList's own thumb still wins over the Simkl still when it survived
         the foreign-entry check above: it is this entry's own artwork. */
      img: streaming?.thumbnail || stills[num] || null,
      description: null,
    };
  });

  return [
    {
      map: true,
      providerId: "megaplay",
      episodes: {
        sub: episodes,
        dub: episodes, // megaplay handles sub/dub via its own embed parameter
      },
    },
  ];
}

function filterData(data: any[], type: "sub" | "dub") {
  const filteredData = data.map((item) => {
    if (item?.map === true) {
      if (!item.episodes[type] || item.episodes[type].length === 0) {
        return null;
      }
      // No per-episode clone: `data` is always freshly built or freshly
      // JSON.parse'd for this request and discarded after serialization, so
      // returning the array by reference is safe. The old `.map(e => ({...e}))`
      // copied every episode on every request — cheap per row, but a real CPU
      // cost on 1000+-episode lists (One Piece, Conan) on the hot cache-hit path.
      return {
        ...item,
        episodes: item.episodes[type],
      };
    }
    return item;
  });

  return filteredData.filter((i) => i !== null);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const { id, releasing = "false", dub = false, refresh = null } = req.query;

  let cacheTime = releasing === "true" ? 60 * 60 * 3 : 60 * 60 * 24 * 30;

  // Edge TTL mirrors the cache lifetime. An airing show keeps a short 30 min
  // window so a freshly aired episode shows up promptly; a finished show's
  // episode list is immutable, so it can sit on the edge for a day (with a day
  // of stale-while-revalidate on top). The old flat 30 min woke the function —
  // and spent a Redis GET — every half hour for every popular finished series.
  const edgeSmaxage = releasing === "true" ? 1800 : 86400;

  let cached;
  let headers: any = {};

  if (redis) {
    try {
      const ipAddress: any = req.socket.remoteAddress;
      refresh
        ? await rateSuperStrict.consume(ipAddress)
        : await rateLimiterRedis.consume(ipAddress);

      headers = refresh
        ? await rateSuperStrict.get(ipAddress)
        : await rateLimiterRedis.get(ipAddress);
    } catch (error: any) {
      return res.status(429).json({
        error: `Too Many Requests, retry after ${getTimeFromMs(
          error.msBeforeNext
        )}`,
        remaining: error.remainingPoints,
      });
    }

    if (refresh !== null) {
      await redis.del(`episode:v5:${id}`);
    } else {
      cached = await redis.get(`episode:v5:${id}`);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (!parsed || parsed.length === 0) {
          await redis.del(`episode:v5:${id}`);
          cached = null;
        }
      }
    }
  }

  // Serve from cache
  if (cached && !refresh) {
    const rawData = JSON.parse(cached);
    const subDub = dub ? "dub" : "sub";
    const filteredData = filterData(rawData, subDub);

    if (redis) {
      res.setHeader("X-RateLimit-Remaining", headers.remainingPoints);
      res.setHeader("X-RateLimit-BeforeReset", headers.msBeforeNext);
    }

    // Edge cache: episode lists change only when a new episode airs.
    // 30 min on the edge with a day of stale-while-revalidate keeps the
    // function dormant for popular series. The Redis check above runs
    // in-function, but with this header most viewers never reach it —
    // they hit the edge cache instead.
    //
    // Browser window widened 60s → 5 min: the watch page re-requests this on
    // every episode change, and each repeat inside a session was a billed Edge
    // Request for a list that only moves when an episode airs. Still far below
    // the 30 min (RELEASING) edge window, so nothing gets staler.
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader(
      "CDN-Cache-Control",
      `public, s-maxage=${edgeSmaxage}, stale-while-revalidate=86400`,
    );
    return res.status(200).json(filteredData.filter((i) => i.episodes.length > 0));
  }

  // Fetch from AniList and build episode list. AniList has multi-day
  // outages from time to time — fall back to the persistent Turso cache
  // so the episode list still renders (without per-episode thumbs).
  let media = await fetchAniListEpisodes(id as string);
  if (!media) {
    try {
      const cached = await getCachedAnime(Number(id));
      if (cached?.data) media = cached.data;
    } catch (e) {
      console.warn("[episode] DB fallback failed:", (e as Error)?.message);
    }
  }

  if (!media) {
    return res.status(404).json({ error: "Anime not found" });
  }

  /* Real per-episode stills and titles. Only on the cache-miss path — a Redis
     hit returns above and never reaches these.

     THREE PROVIDERS, IN COVERAGE ORDER, each filling what the previous left
     empty. They differ only in what they can be keyed by, and that is what
     decides the order:

       1. ani.zip  — keyed on the ANILIST ID itself. Nothing to map, nothing to
                     miss. This is the source Hayase uses, and it is first for
                     the reason it is theirs: it cannot fail on a title that is
                     merely new.
       2. Simkl    — keyed on Fribb's `simkl_id`, which covers ~34% of entries
                     and skews against airing shows; `resolveSimklId` rescues
                     some of the rest with a direct lookup.
       3. TMDB     — needs a season, the weakest link of all (see
                     lib/tmdb/episodeStills.ts), so it only ever writes into
                     episodes the first two left empty.

     Where none has an image the row falls back to the client's fanart pool,
     exactly as before.

     ani.zip and Simkl run CONCURRENTLY: neither depends on the other and both
     are usually a single cached Turso read, so serialising them would double
     the latency of the common case for nothing. TMDB comes after because it
     needs to know which episodes are still missing.

     Timeboxed: the episode list is the site's hot path. Past the budget we
     drop what hasn't arrived and let the pool cover those rows; the result
     still lands in the cache on a later request. */
  const displayed = displayedEpisodeCount(media);
  const [anizip, simkl] = await Promise.race([
    Promise.all([
      getAniZipEpisodes(Number(id), displayed || null).catch(() => ({
        stills: {},
        titles: {},
      })),
      getSimklEpisodeStills(Number(id), displayed || null).catch(() => ({
        stills: {},
        titles: {},
      })),
    ]),
    new Promise<[AniZipEpisodeData, SimklEpisodeData]>((r) =>
      setTimeout(
        () => r([
          { stills: {}, titles: {} },
          { stills: {}, titles: {} },
        ]),
        3000,
      ),
    ),
  ]);

  /* Spread order IS the precedence: later keys win, so the earlier provider
     must be spread last. */
  const merged = { ...simkl.stills, ...anizip.stills };
  const mergedTitles = { ...simkl.titles, ...anizip.titles };

  /* TMDB fills what's left, on its own timebox rather than inside the race
     above — otherwise a slow first round would eat the whole budget and the
     fill would never get a turn, while a slow TMDB could push the total past
     what the episode list is allowed to spend. Costs nothing when the first
     two came back complete (fillStillGaps returns without a call) or when
     TMDB_API_KEY is unset. 2s, not 3s: this is strictly a bonus on top of an
     answer we already have. */
  const stills = await Promise.race([
    fillStillGaps(Number(id), displayed || null, merged).catch(() => merged),
    new Promise<Record<number, string>>((r) => setTimeout(() => r(merged), 2000)),
  ]);

  const rawData = buildEpisodeList(id as string, media, stills, mergedTitles);

  // Cache
  if (redis && cacheTime !== null && rawData.length > 0) {
    await redis.set(
      `episode:v5:${id}`,
      JSON.stringify(rawData),
      "EX",
      cacheTime
    );
  }

  const subDub = dub ? "dub" : "sub";
  const data = filterData(rawData, subDub);

  if (redis) {
    res.setHeader("X-RateLimit-Limit", refresh ? 1 : 50);
    res.setHeader("X-RateLimit-Remaining", headers.remainingPoints);
    res.setHeader("X-RateLimit-BeforeReset", headers.msBeforeNext);
  }

  // Same 5 min browser window as the cached branch above — kept in sync so the
  // two exit paths don't disagree about how long a client may hold the list.
  res.setHeader("Cache-Control", "public, max-age=300");
  res.setHeader(
    "CDN-Cache-Control",
    "public, s-maxage=1800, stale-while-revalidate=86400",
  );
  return res.status(200).json(data.filter((i) => i.episodes.length > 0));
}

function getTimeFromMs(time: number) {
  const timeInSeconds = time / 1000;
  if (timeInSeconds >= 3600) {
    const hours = Math.floor(timeInSeconds / 3600);
    return `${hours} hour${hours > 1 ? "s" : ""}`;
  } else if (timeInSeconds >= 60) {
    const minutes = Math.floor(timeInSeconds / 60);
    return `${minutes} minute${minutes > 1 ? "s" : ""}`;
  } else {
    return `${timeInSeconds} second${timeInSeconds > 1 ? "s" : ""}`;
  }
}
