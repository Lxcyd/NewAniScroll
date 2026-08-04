import type { NextApiRequest, NextApiResponse } from "next";
import { redis } from "@/lib/redis";
import { anilistFetch } from "@/lib/anilist/anilistFetch";
import { setEdgeCache } from "@/lib/http/edgeCache";

/**
 * Server-cached catalog list for the /en/anime/popular and /trending
 * pages. Previously each page hit AniList directly from the browser on
 * every navigation and pagination scroll — multiplying our visitors
 * by AniList's 30 req/min IP limit. By moving the fetch server-side
 * and caching it in Redis (1h), N concurrent visitors share one
 * upstream call.
 *
 * GET /api/v2/catalog/popular?page=1
 * GET /api/v2/catalog/trending?page=1
 */

const SORT_MAP: Record<string, string> = {
  popular: "POPULARITY_DESC",
  trending: "TRENDING_DESC",
  recent: "UPDATED_AT_DESC",
};

const PER_PAGE = 20;
const TTL_S = 60 * 60;

const QUERY = `
  query ($page: Int, $perPage: Int, $sort: [MediaSort]) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { total currentPage lastPage hasNextPage perPage }
      media(sort: $sort, type: ANIME, isAdult: false) {
        id idMal status episodes averageScore description
        title { romaji english }
        coverImage { large extraLarge color }
        bannerImage
      }
    }
  }
`;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const sortKey = String(req.query.sort || "").toLowerCase();
  const sort = SORT_MAP[sortKey];
  if (!sort) return res.status(404).json({ error: "Unknown sort" });

  const page = Math.max(1, Math.min(50, Number(req.query.page) || 1));
  const cacheKey = `catalog:${sortKey}:${page}`;

  // Edge-cache the response: a catalog page is identical for every visitor and
  // gets hammered by pagination scroll, so without a real edge window each
  // scroll spent a Redis GET here. s-maxage matches the 1 h Redis TTL — an edge
  // HIT never reaches the function, so that steady-state GET disappears. (The
  // old `s-maxage=60` gave a 60 s window, after which every request revalidated
  // through the function anyway.)
  // The BROWSER window was 60s, which meant a visitor scrolling the catalog for
  // ten minutes re-requested every page ~10 times. Those all HIT the edge, but
  // an Edge Request is billed on a HIT exactly like a MISS, so the only way to
  // not pay for them is to not send them. 5 min against a 1 h edge/Redis TTL
  // adds no staleness a catalog listing would ever notice.

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
    variables: { page, perPage: PER_PAGE, sort: [sort] },
    label: `catalog:${sortKey}:${page}`,
  });
  if (!json?.data?.Page) {
    return res.status(503).json({ error: "AniList unavailable" });
  }

  const payload = {
    media: json.data.Page.media || [],
    hasNextPage: !!json.data.Page.pageInfo?.hasNextPage,
  };

  if (redis) {
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
