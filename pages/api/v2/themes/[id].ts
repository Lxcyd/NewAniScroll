import type { NextApiRequest, NextApiResponse } from "next";
import { themesForAnime, type Theme } from "@/lib/animethemes/themes";
import { seasonCacheGet, seasonCacheSet } from "@/lib/db/seasonCache";

/**
 * OP/ED themes proxy — powers the info-page "Opening / Ending" dropdown.
 *
 *   GET /api/v2/themes/{anilistId}?malId={malId}
 *
 * Returns the anime's openings & endings from AnimeThemes.moe, each with the
 * song/artists and a clean (NC) playable clip URL. `malId` is preferred for the
 * slug lookup (AnimeThemes maps 1:1 on MAL); the AniList id is the fallback.
 *
 * Caching is two-tier:
 *   • Turso (server) — the slow part is TWO sequential AnimeThemes calls
 *     (resolve slug → fetch themes). On a cold serverless invocation with no CDN
 *     hit that latency made the OP/ED tab pop in "after the whole page" (and time
 *     out for the user). A persistent Turso row makes warm reads instant and
 *     removes the upstream round-trips entirely. Reuses the season_cache table.
 *   • CDN (Cache-Control) — still set so the edge re-serves without hitting us.
 * A miss/DB error just recomputes from AnimeThemes; the cache never blocks.
 */
const THEMES_KEY = (anilistId: number | null, malId: number | null) =>
  `themes:v1:${malId ? `mal${malId}` : `al${anilistId}`}`;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }
  const anilistId = Number(req.query.id) || null;
  const malId = Number(req.query.malId) || null;
  if (!anilistId && !malId) {
    return res.status(400).json({ error: "id (AniList) or malId required" });
  }

  const cacheKey = THEMES_KEY(anilistId, malId);
  const cached = await seasonCacheGet<Theme[]>(cacheKey);
  if (cached) {
    res.setHeader(
      "Cache-Control",
      "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800",
    );
    return res.status(200).json({ themes: cached });
  }

  let themes: Theme[] = [];
  try {
    themes = await themesForAnime({ anilistId, malId });
  } catch (e: any) {
    console.warn(`[themes] lookup failed for ${anilistId ?? malId}:`, e?.message);
    // Fail soft — an upstream hiccup shouldn't 500 the info page, and we DON'T
    // cache the failure (so a genuine outage recovers on the next view).
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
    return res.status(200).json({ themes: [] });
  }

  // Persist the resolved result (including a legitimately-empty list — "this
  // anime has no themes" is a stable fact worth caching so we stop re-hitting
  // the upstream on every page view).
  await seasonCacheSet(cacheKey, themes);

  res.setHeader(
    "Cache-Control",
    themes.length
      ? "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800"
      : // Empty (anime not on AnimeThemes, or no themes yet) — cache modestly so
        // a newly-added anime picks up its themes within a day.
        "public, max-age=3600, s-maxage=3600",
  );
  return res.status(200).json({ themes });
}
