import type { NextApiRequest, NextApiResponse } from "next";
import {
  getSeasonEpisodeScores,
  getCachedSeasonScoresBatch,
  episodeScoresEnabled,
} from "@/lib/jikan/episodeScores";

/**
 * GET /api/v2/episode-scores/[id]?seasons=<json>
 *
 * Returns real per-episode scores for each season in the franchise so the
 * info-page Scores grid can paint true per-episode cells.
 *
 * Scores come from Jikan (MyAnimeList) keyed on each season's MAL id, which
 * maps 1:1 to that AniList entry's episodes — no season-number guessing.
 *
 * `seasons` is a URL-encoded JSON array of `{ aniId, idMal }` — the season
 * chain the info page already resolved at SSR, passed straight through so this
 * route does zero AniList work.
 *
 * Degrades gracefully: a season with no MAL id (or a Jikan miss) comes back
 * empty with source:"none" and the grid shows grey cells for it.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  let seasons: Array<{ aniId: number; idMal?: number | null }> = [];

  try {
    const raw = String(req.query.seasons || "[]");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) seasons = parsed.filter((s) => s && s.aniId);
  } catch {
    return res.status(400).json({ error: "Invalid `seasons` parameter" });
  }

  // Cap the fan-out — a franchise with dozens of entries shouldn't fire dozens
  // of Jikan chains in one request. The grid only shows a handful of columns.
  seasons = seasons.slice(0, 12);

  if (!episodeScoresEnabled()) {
    res.setHeader("Cache-Control", "public, s-maxage=3600");
    return res.status(200).json({ enabled: false, seasons: [] });
  }

  try {
    const inputs = seasons.map((s) => ({
      aniId: Number(s.aniId),
      idMal: s.idMal ?? null,
    }));

    // Fast path: one Redis MGET pulls every season that's already cached. Once
    // an anime has been seen, ALL seasons are warm, so the whole grid resolves
    // from this single round-trip — no per-season serial GET, no Jikan calls.
    const cached = await getCachedSeasonScoresBatch(inputs);
    const results = [...cached];

    // Only the cache MISSES hit Jikan, and those stay SEQUENTIAL: Jikan rate-
    // limits aggressively (~3 req/s) and firing all at once gets the later ones
    // 429'd → cached as a miss (AoT S2/S3 came back empty). One at a time stays
    // under the limit; the fetch also re-checks the cache so this is safe.
    let didFetch = false;
    for (let i = 0; i < inputs.length; i++) {
      if (results[i]) continue; // already warm from the MGET
      results[i] = await getSeasonEpisodeScores(inputs[i]);
      didFetch = true;
    }

    // Long edge cache — episode scores barely change and the lib already caches
    // in Redis. SWR keeps it warm without blocking. When everything was warm we
    // can cache even more aggressively at the edge (nothing left to revalidate).
    res.setHeader(
      "Cache-Control",
      didFetch
        ? "public, s-maxage=86400, stale-while-revalidate=604800"
        : "public, s-maxage=604800, stale-while-revalidate=604800",
    );
    return res.status(200).json({ enabled: true, seasons: results });
  } catch (e: any) {
    console.error("[episode-scores] error:", e?.message);
    // Never fail the grid — return an empty (fallback) payload.
    return res.status(200).json({ enabled: true, seasons: [] });
  }
}
