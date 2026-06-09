import type { NextApiRequest, NextApiResponse } from "next";
import { getSeasonEpisodeScores, tmdbEnabled } from "@/lib/tmdb/episodeScores";

/**
 * GET /api/v2/episode-scores/[id]?seasons=<json>
 *
 * Returns real per-episode scores (TMDB vote_average /10) for each season in
 * the franchise so the info-page Scores grid can paint true per-episode cells
 * instead of repeating the season average.
 *
 * `seasons` is a URL-encoded JSON array of:
 *   { aniId, title:{romaji,english}, year, episodeCount }
 * — exactly the season chain the info page already resolved at SSR, passed
 * straight through so this route does zero AniList work.
 *
 * Degrades gracefully: when TMDB has no key / no match, a season's `episodes`
 * comes back empty with source:"none" and the client falls back to the AniList
 * season score for that column.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  let seasons: Array<{
    aniId: number;
    title?: { romaji?: string | null; english?: string | null } | null;
    year?: number | null;
    episodeCount?: number | null;
  }> = [];

  try {
    const raw = String(req.query.seasons || "[]");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) seasons = parsed.filter((s) => s && s.aniId);
  } catch {
    return res.status(400).json({ error: "Invalid `seasons` parameter" });
  }

  // Cap the fan-out — a franchise with dozens of entries shouldn't fire dozens
  // of TMDB chains in one request. The grid only shows a handful of columns.
  seasons = seasons.slice(0, 12);

  if (!tmdbEnabled()) {
    // No key configured — tell the client so it can skip the fetch next time
    // and just render season scores. Cache briefly at the edge.
    res.setHeader("Cache-Control", "public, s-maxage=3600");
    return res.status(200).json({ enabled: false, seasons: [] });
  }

  try {
    const results = await Promise.all(
      seasons.map((s) =>
        getSeasonEpisodeScores({
          aniId: Number(s.aniId),
          title: s.title,
          year: s.year ?? null,
          episodeCount: s.episodeCount ?? null,
        }),
      ),
    );
    // Long edge cache — episode scores barely change and the lib already
    // caches in Redis. SWR keeps it warm without blocking.
    res.setHeader(
      "Cache-Control",
      "public, s-maxage=86400, stale-while-revalidate=604800",
    );
    return res.status(200).json({ enabled: true, seasons: results });
  } catch (e: any) {
    console.error("[episode-scores] error:", e?.message);
    // Never fail the grid — return an empty (fallback) payload.
    return res.status(200).json({ enabled: true, seasons: [] });
  }
}
