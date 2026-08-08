import type { NextApiRequest, NextApiResponse } from "next";
import { redis } from "@/lib/redis";
import { anilistFetch } from "@/lib/anilist/anilistFetch";
import { setEdgeCache } from "@/lib/http/edgeCache";
import { getTmdbAnimeImagesMany } from "@/lib/tmdb/animeImages";

/**
 * GET /api/v2/discover/<page>
 *
 * Server-cached feed for the /en/discover swipe deck. Each visitor
 * normally swipes through dozens of cards and triggers a new AniList
 * page every ~3 swipes — moving this server-side lets thousands of
 * visitors share one upstream call per (page) per cache window.
 *
 * Cache TTL is 30 minutes — long enough to cover most session lengths
 * while keeping trending data reasonably fresh.
 */

const TTL_S = 30 * 60;

const QUERY = `
  query Discover($page: Int!) {
    Page(page: $page, perPage: 20) {
      media(type: ANIME, sort: [TRENDING_DESC, POPULARITY_DESC], isAdult: false) {
        id
        title { romaji english native }
        coverImage { extraLarge large color }
        bannerImage
        description(asHtml: false)
        genres episodes averageScore seasonYear season status format duration
        nextAiringEpisode { episode }
      }
    }
  }
`;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const page = Math.max(1, Math.min(50, Number(req.query.page) || 1));
  const cacheKey = `discover:${page}`;

  // Edge-cache the response: the discover deck is identical for every visitor
  // and each session swipes a new page every ~3 cards, so without a real edge
  // window every few swipes spent a Redis GET. s-maxage matches the 30 min
  // Redis TTL — an edge HIT never reaches the function. (The old `s-maxage=60`
  // gave only a 60 s window, after which every request revalidated through the
  // function anyway.)
  // 5 min in the browser rather than 60s: a swipe session pulls a new page
  // every few cards, and re-requesting one already in the browser cache costs a
  // billed Edge Request even though it HITs the CDN. Well inside the 30 min
  // edge/Redis TTL, so no added staleness.

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        res.setHeader("X-Cache", "HIT");
        setEdgeCache(res, TTL_S);
        return res.status(200).json(JSON.parse(cached));
      }
    } catch {
      /* fall through */
    }
  }

  const json = await anilistFetch({
    query: QUERY,
    variables: { page },
    label: `discover:${page}`,
  });
  const media = json?.data?.Page?.media || [];

  /* Swap in TMDB backdrops before caching, so the 20 lookups happen once per
     page per 30-minute window rather than per request — and never on the
     Redis-HIT path above, which returns already-enriched cards.

     ScrollCard blows `bannerImage` up as the full-card background behind the
     portrait cover, which is the worst possible use of AniList's 1900×400 crop:
     filling a tall card from it means scaling a 400 px-high strip to ~700 px.
     A 720 px-high TMDB backdrop is the fix. Falls through to the AniList banner
     for everything TMDB doesn't have. */
  const backdrops = await getTmdbAnimeImagesMany(
    media.map((m: any) => Number(m?.id)),
  ).catch(() => new Map());
  const enriched = media.map((m: any) => {
    const backdrop = backdrops.get(Number(m?.id))?.backdrop;
    return backdrop ? { ...m, bannerImage: backdrop } : m;
  });
  const payload = { media: enriched };

  if (redis && media.length > 0) {
    try {
      await redis.set(cacheKey, JSON.stringify(payload), "EX", TTL_S);
    } catch {
      /* non-fatal */
    }
  }

  res.setHeader("X-Cache", "MISS");
  setEdgeCache(res, TTL_S);
  return res.status(200).json(payload);
}
