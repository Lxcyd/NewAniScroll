import type { NextApiRequest, NextApiResponse } from "next";
import { themesForAnime, type Theme } from "@/lib/animethemes/themes";

/**
 * OP/ED themes proxy — powers the info-page "OP / ED" dropdown.
 *
 *   GET /api/v2/themes/{anilistId}?malId={malId}
 *
 * Returns the anime's openings & endings from AnimeThemes.moe, each with the
 * song/artists and a clean (NC) playable clip URL. `malId` is preferred for the
 * slug lookup (AnimeThemes maps 1:1 on MAL); the AniList id is the fallback.
 *
 * No DB cache: AnimeThemes theme metadata is static, and the long CDN cache
 * below re-serves it for free. An anime absent from AnimeThemes returns an
 * empty list (the dropdown then simply doesn't render), still cached so we
 * don't re-hit the upstream on every page view.
 */
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

  let themes: Theme[] = [];
  try {
    themes = await themesForAnime({ anilistId, malId });
  } catch (e: any) {
    console.warn(`[themes] lookup failed for ${anilistId ?? malId}:`, e?.message);
    // Fail soft — an upstream hiccup shouldn't 500 the info page. A short cache
    // lets a genuine outage recover quickly instead of pinning an empty list.
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
    return res.status(200).json({ themes: [] });
  }

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
