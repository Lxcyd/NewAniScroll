import type { NextApiRequest, NextApiResponse } from "next";
import { redis } from "@/lib/redis";
import { anilistFetch } from "@/lib/anilist/anilistFetch";
import { setEdgeCache } from "@/lib/http/edgeCache";

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
      media(type: ANIME, status: RELEASING, sort: [TRENDING_DESC, POPULARITY_DESC], isAdult: false) {
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
  /* v2 (2026-08-08): the query gained `status: RELEASING` (user decision — the
     deck is for what's airing now). Bumping is mandatory, not tidiness: the
     v1 pages already in Redis were built WITHOUT that filter and would keep
     serving finished shows for the rest of their 30-minute window, and the
     same omission has already cost two debugging rounds today (the TMDB
     artwork rows and the episode lists). A cache never notices that the
     question changed. */
  const cacheKey = `discover:v2:${page}`;

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
  /* No TMDB enrichment here, deliberately: TMDB backdrops are scoped to the
     home page's recommendation hero (user decision, 2026-08-08). The discover
     deck keeps AniList's banner. */
  const payload = { media };

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
