import type { NextApiRequest, NextApiResponse } from "next";
import { loadFanarts } from "@/lib/db/fanarts";

/**
 * GET /api/v2/fanarts?anime=<anilist_id>[&include_nsfw=1][&min_likes=N]
 *
 * Thin HTTP wrapper around lib/db/fanarts.loadFanarts. The SSR path in
 * pages/en/anime/[...id].tsx hits the lib directly so the first paint
 * already includes the clearart, and this endpoint stays available for
 * any client-side caller.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const animeId = Number(req.query.anime);
  if (!Number.isFinite(animeId)) {
    return res.status(400).json({ error: "Missing or invalid `anime` query parameter" });
  }

  const includeNsfw =
    req.query.include_nsfw === "1" || req.query.include_nsfw === "true";
  const minLikesRaw = Number(req.query.min_likes);
  const minLikes = Number.isFinite(minLikesRaw) && minLikesRaw >= 0 ? minLikesRaw : 0;

  const payload = await loadFanarts(animeId, { includeNsfw, minLikes });
  if (!payload) return res.status(503).json({ error: "DB unavailable" });

  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
  return res.status(200).json(payload);
}
