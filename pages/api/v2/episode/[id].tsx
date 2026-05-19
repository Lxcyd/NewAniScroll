// @ts-nocheck

import { rateLimiterRedis, rateSuperStrict, redis } from "@/lib/redis";
import { NextApiRequest, NextApiResponse } from "next";
import { anilistFetch } from "@/lib/anilist/anilistFetch";
import { getCachedAnime } from "@/lib/db/anime";

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

function buildEpisodeList(id: string, media: any) {
  // Determine total episodes: known count, or aired-so-far for ongoing anime
  let totalEpisodes = media?.episodes;
  if (!totalEpisodes && media?.nextAiringEpisode?.episode) {
    totalEpisodes = media.nextAiringEpisode.episode - 1; // aired so far
  }
  if (!totalEpisodes || totalEpisodes <= 0) {
    // Ongoing with no episode count — show at least 1
    totalEpisodes = media?.status === "RELEASING" ? 1 : 0;
  }

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

  const fallbackImg = media?.bannerImage || media?.coverImage?.extraLarge || null;

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
      // Per-episode thumb when AniList exposes one, otherwise the
      // anime's banner / cover so the tile isn't a blank gradient.
      img: streaming?.thumbnail || fallbackImg,
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
      await redis.del(`episode:v3:${id}`);
    } else {
      cached = await redis.get(`episode:v3:${id}`);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (!parsed || parsed.length === 0) {
          await redis.del(`episode:v3:${id}`);
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

  const rawData = buildEpisodeList(id as string, media);

  // Cache
  if (redis && cacheTime !== null && rawData.length > 0) {
    await redis.set(
      `episode:v3:${id}`,
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
