// @ts-nocheck

import { rateLimiterRedis, rateSuperStrict, redis } from "@/lib/redis";
import { NextApiRequest, NextApiResponse } from "next";
import { anilistFetch } from "@/lib/anilist/anilistFetch";
import { getCachedAnime } from "@/lib/db/anime";
import { getEpisodeStills } from "@/lib/tmdb/episodeStills";
import { getSimklEpisodeStills } from "@/lib/simkl/episodeStills";

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

function buildEpisodeList(
  id: string,
  media: any,
  stills: Record<number, string> = {},
) {
  const totalEpisodes = displayedEpisodeCount(media);

  // AniList provides per-episode thumbnails for Crunchyroll/Funimation
  // titles via `streamingEpisodes`. They come ordered by air date but
  // titles like "Episode 1 - Foo" need a number extracted to map back
  // to an episode index. We try the number out of the title, then fall
  // back to the array index.
  const streamingByNum: Record<number, { thumbnail: string; title: string }> = {};
  if (Array.isArray(media?.streamingEpisodes)) {
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
      title: cleanTitle || `Episode ${num}`,
      number: num,
      /* Only a genuinely per-episode image, or null. We used to fall back to
         the anime's banner here, which handed EVERY row the same image — the
         "10 identical tiles" bug. Null lets the client vary the tile from the
         fanart pool instead (lib/images/episodeImagePool.ts); it has the
         artwork loaded already, and this response is a shared 30-day cache
         blob, so a pick made here would freeze one viewer's choice for all.

         AniList's own thumb wins over TMDB: it belongs to THIS entry, whereas
         a TMDB still is inferred via a season mapping (validated, but still an
         inference — see lib/tmdb/resolveTmdbSeason.ts). */
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
      return {
        ...item,
        episodes: item.episodes[type].map((episode: any) => ({ ...episode })),
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
      await redis.del(`episode:v4:${id}`);
    } else {
      cached = await redis.get(`episode:v4:${id}`);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (!parsed || parsed.length === 0) {
          await redis.del(`episode:v4:${id}`);
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
    res.setHeader("Cache-Control", "public, max-age=60");
    res.setHeader(
      "CDN-Cache-Control",
      "public, s-maxage=1800, stale-while-revalidate=86400",
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

  /* Real per-episode stills. Only on the cache-miss path — a Redis hit returns
     above and never reaches these.

     Two sources, merged with TMDB winning per episode:
       - TMDB is validated against an EXACT episode-count match on a mapped
         season, so where it answers it's the tighter guarantee.
       - Simkl is keyed to this exact AniList entry (no season inference), so it
         covers what TMDB structurally can't — long sagas with no tmdb_season
         (One Piece) and airing shows with no total.
     Merging rather than choosing: TMDB may cover a season Simkl lacks images
     for, and vice versa. Neither is ever the ANIME's banner, so a mixed row set
     is still all real per-episode frames.

     Timeboxed: the episode list is the site's hot path and these make external
     calls. Past the budget we drop the stills and let the client's fanart pool
     cover the rows; the result still lands in the cache on a later request. */
  const displayed = displayedEpisodeCount(media);
  const [tmdbStills, simklStills] = await Promise.race([
    Promise.all([
      getEpisodeStills(Number(id), media?.episodes ?? null).catch(() => ({})),
      getSimklEpisodeStills(Number(id), displayed || null).catch(() => ({})),
    ]),
    new Promise<[Record<number, string>, Record<number, string>]>((r) =>
      setTimeout(() => r([{}, {}]), 3000),
    ),
  ]);
  const stills = { ...simklStills, ...tmdbStills };

  const rawData = buildEpisodeList(id as string, media, stills);

  // Cache
  if (redis && cacheTime !== null && rawData.length > 0) {
    await redis.set(
      `episode:v4:${id}`,
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

  res.setHeader("Cache-Control", "public, max-age=60");
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
