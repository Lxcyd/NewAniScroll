import type { NextApiRequest, NextApiResponse } from "next";
import { getSeasonEpisodeScores } from "@/lib/jikan/episodeScores";

/**
 * GET /api/v2/episode-meta/{idMal}
 *
 * Per-episode facts AniList has no equivalent of, for ONE season: the MAL
 * filler / recap flags, the episode title and its first air date. Feeds the
 * info-page episode list (badges, and a title when the provider has none).
 *
 * Same Jikan page and same Redis entry as the Scores grid
 * (lib/jikan/episodeScores.ts) — a season fetched for one feeds the other.
 * Keyed on the MAL id alone, so every page and season pointing at it shares
 * one edge-cache entry.
 *
 * Response: { episodes: [{ n, t?, a?, f?, r? }] } — short keys, because a
 * thousand-episode show makes this list long. Never fails: an unknown id or a
 * Jikan outage returns an empty list and the list renders without badges.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const idMal = Number(req.query.idMal);
  if (!Number.isInteger(idMal) || idMal <= 0) {
    return res.status(400).json({ error: "idMal required" });
  }
  try {
    const season = await getSeasonEpisodeScores({ aniId: 0, idMal });
    const episodes = season.episodes.map((e) => ({
      n: e.number,
      ...(e.title ? { t: e.title } : {}),
      ...(e.aired ? { a: e.aired } : {}),
      ...(e.filler ? { f: 1 } : {}),
      ...(e.recap ? { r: 1 } : {}),
    }));
    // An empty answer may be a Jikan blip (not cached in Redis) — keep it short
    // at the edge so the next visitor retries; a real list keeps a week.
    res.setHeader(
      "Cache-Control",
      episodes.length
        ? "public, s-maxage=604800, stale-while-revalidate=604800"
        : "public, s-maxage=3600",
    );
    return res.status(200).json({ episodes });
  } catch (e: any) {
    console.error("[episode-meta] error:", e?.message);
    res.setHeader("Cache-Control", "public, s-maxage=600");
    return res.status(200).json({ episodes: [] });
  }
}
