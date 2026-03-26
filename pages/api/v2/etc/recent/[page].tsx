import { rateLimitStrict, redis } from "@/lib/redis";
import { NextApiRequest, NextApiResponse } from "next";

// Fetches recently updated anime from AniList (replaces dead api.anify.tv)
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
        coverImage { extraLarge color }
      }
    }
  }
`;

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
    if (redis) {
      const cache = await redis.get(`recent-episode`);
      if (cache) {
        return res.status(200).json({ results: JSON.parse(cache) });
      }
    }

    // ── Fetch from AniList ───────────────────────────────────
    const page = Number(req.query.page) || 1;

    const response = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: ANILIST_QUERY,
        variables: { page, perPage: 45 },
      }),
    });

    if (!response.ok) {
      throw new Error(`AniList responded with ${response.status}`);
    }

    const json = await response.json();
    const mediaList = json?.data?.Page?.media ?? [];

    const results = mediaList.map((i: any) => {
      // nextAiringEpisode.episode is the NEXT one, so current = episode - 1
      const nextEp = i.currentEpisode?.episode ?? null;
      const currentEpisode = nextEp ? nextEp - 1 : i.episodes ?? null;

      return {
        id: i.id,
        slug: null, // no gogoanime slug from AniList; consumers should use id
        title: i.title,
        currentEpisode,
        coverImage: i.coverImage?.extraLarge ?? null,
      };
    });

    // ── Cache for 1 hour ─────────────────────────────────────
    if (redis) {
      await redis.set(`recent-episode`, JSON.stringify(results), "EX", 60 * 60);
    }

    return res.status(200).json({ results });
  } catch (error) {
    console.error("[recent] error:", error);
    return res.status(500).json({ error: "Failed to fetch recent episodes" });
  }
}