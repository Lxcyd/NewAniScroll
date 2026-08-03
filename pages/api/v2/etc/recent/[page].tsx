import { rateLimitStrict, redis } from "@/lib/redis";
import { NextApiRequest, NextApiResponse } from "next";
import { anilistFetch } from "@/lib/anilist/anilistFetch";

// Fetches recently updated anime from AniList (replaces dead api.anify.tv).
// We pull a larger recently-updated pool, then sort it by popularity so the
// "Freshly Added" rail leads with titles people recognise instead of obscure
// donghua / ONAs (e.g. "Shen Mu 3") that happen to have pushed an episode.
const ANILIST_QUERY = `
  query ($page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      media(
        type: ANIME
        sort: UPDATED_AT_DESC
        status: RELEASING
        isAdult: false
      ) {
        id
        title { romaji english native }
        currentEpisode: nextAiringEpisode { episode }
        episodes
        popularity
        coverImage { extraLarge color }
      }
    }
  }
`;

// Drop the long tail of near-zero-popularity entries entirely — that's where
// the obscure donghua sit. 5000 keeps niche-but-real seasonal anime while
// cutting the noise.
const MIN_POPULARITY = 5000;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    // ── Rate limiting ────────────────────────────────────────
    if (redis) {
      try {
        const ipAddress: any = req.socket.remoteAddress;
        await rateLimitStrict?.consume(ipAddress);
      } catch (error: any) {
        return res.status(429).json({
          error: `Too Many Requests, retry after ${error.msBeforeNext / 1000}`,
        });
      }
    }

    // ── Cache check ──────────────────────────────────────────
    // Key bumped to v2 — the sort order + popularity filter changed, so
    // the old cached payload would serve the obscure-first ordering.
    // Edge-cache this response: the "Freshly Added" rail is identical for every
    // visitor and loads on the homepage, so without an edge cache every visitor
    // spent a Redis GET here. s-maxage matches the 1 h Redis TTL — an edge HIT
    // never reaches the function, so that steady-state GET disappears entirely.
    // 5 min in the browser, against the same 1 h edge/Redis TTL: the rail sits
    // on the homepage, so a visitor bouncing back to it re-requested it every
    // minute — each one a billed Edge Request for a payload that changes hourly.
    const setEdgeCache = () => {
      res.setHeader("Cache-Control", "public, max-age=300");
      res.setHeader(
        "CDN-Cache-Control",
        "public, s-maxage=3600, stale-while-revalidate=86400",
      );
    };

    if (redis) {
      // A dead Redis must degrade to a live AniList fetch, not 500 the rail.
      const cache = await redis.get(`recent-episode-v2`).catch(() => null);
      if (cache) {
        setEdgeCache();
        return res.status(200).json({ results: JSON.parse(cache) });
      }
    }

    // ── Fetch from AniList ───────────────────────────────────
    const page = Number(req.query.page) || 1;

    const json = await anilistFetch({
      query: ANILIST_QUERY,
      variables: { page, perPage: 50 },
      label: "recent",
    });
    if (!json) {
      throw new Error("AniList unreachable");
    }

    const mediaList = json?.data?.Page?.media ?? [];

    const results = mediaList
      // Cut the obscure long tail before sorting.
      .filter((i: any) => (i.popularity ?? 0) >= MIN_POPULARITY)
      // Popular titles first so the rail leads with recognisable shows.
      .sort((a: any, b: any) => (b.popularity ?? 0) - (a.popularity ?? 0))
      .map((i: any) => {
        // nextAiringEpisode.episode is the NEXT one, so current = episode - 1
        const nextEp = i.currentEpisode?.episode ?? null;
        const currentEpisode = nextEp ? nextEp - 1 : i.episodes ?? null;

        return {
          id: i.id,
          slug: null, // no gogoanime slug from AniList; consumers should use id
          title: i.title,
          currentEpisode,
          popularity: i.popularity ?? 0,
          coverImage: i.coverImage?.extraLarge ?? null,
        };
      });

    // ── Cache for 1 hour ─────────────────────────────────────
    if (redis) {
      // Best-effort cache write — a failing Redis must not sink the response.
      await redis
        .set(`recent-episode-v2`, JSON.stringify(results), "EX", 60 * 60)
        .catch(() => {});
    }

    setEdgeCache();
    return res.status(200).json({ results });
  } catch (error) {
    console.error("[recent] error:", error);
    return res.status(500).json({ error: "Failed to fetch recent episodes" });
  }
}