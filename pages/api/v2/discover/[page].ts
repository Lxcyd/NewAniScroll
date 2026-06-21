import type { NextApiRequest, NextApiResponse } from "next";
import { redis } from "@/lib/redis";
import { anilistFetch } from "@/lib/anilist/anilistFetch";

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

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        res.setHeader("X-Cache", "HIT");
        res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=600");
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
  const payload = { media };

  if (redis && media.length > 0) {
    try {
      await redis.set(cacheKey, JSON.stringify(payload), "EX", TTL_S);
    } catch {
      /* non-fatal */
    }
  }

  res.setHeader("X-Cache", "MISS");
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=600");
  return res.status(200).json(payload);
}
