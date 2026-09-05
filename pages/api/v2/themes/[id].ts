import type { NextApiRequest, NextApiResponse } from "next";
import { themesForAnime, type Theme } from "@/lib/animethemes/themes";
import { seasonCacheGet, seasonCacheSet } from "@/lib/db/seasonCache";
import { resolvedVideoIds } from "@/lib/db/opedYoutube";

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
// v2: the Theme shape gained videoNc/videoCredited (credits toggle). Bumping the
// key retires v1 rows that only had a single `video` URL, so warm caches don't
// serve the old shape without the credited variant.
const THEMES_KEY = (anilistId: number | null, malId: number | null) =>
  `themes:v2:${malId ? `mal${malId}` : `al${anilistId}`}`;

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

  /**
   * Attach the full-length YouTube id to each theme.
   *
   * Done on the way OUT, never folded into the cached payload. The themes cache
   * is a week long — writing the ids into it would mean a freshly resolved batch
   * stayed invisible until that week expired, on an anime nobody re-requests.
   * The lookup is one indexed read on the anime's own rows, and it returns an
   * empty map on any DB trouble, so a failure here costs the full version and
   * nothing else: the 90 s rip is still in `video`.
   *
   * Only `ok` rows come back — resolvedVideoIds filters, deliberately. See
   * lib/db/opedYoutube.ts for why `review` must not be served.
   */
  const withVideoIds = async (themes: Theme[]) => {
    if (!anilistId || !themes.length) return { themes, resolved: false };
    const ids = await resolvedVideoIds(anilistId);
    if (!ids.size) return { themes, resolved: false };
    return {
      themes: themes.map((t) => ({ ...t, youtubeId: ids.get(t.slug) ?? null })),
      resolved: true,
    };
  };

  /**
   * A week at the edge is right for an answer that is finished, and wrong for
   * one that is still waiting on the offline batch.
   *
   * Attaching the ids per request buys nothing if the CDN then serves a copy
   * frozen from before the table was filled — the staleness just moves from our
   * cache to theirs. So the ceiling follows what the response actually carries:
   * ids present, nothing left to wait for, cache long; none yet, cache an hour,
   * and a resolved batch shows up the same day instead of next week.
   *
   * Same reasoning as the empty-themes case below, which already shortens for
   * an anime AnimeThemes has not covered yet.
   */
  const cacheFor = (resolved: boolean) =>
    resolved
      ? "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800"
      : "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400";

  const cacheKey = THEMES_KEY(anilistId, malId);
  const cached = await seasonCacheGet<Theme[]>(cacheKey);
  if (cached) {
    const out = await withVideoIds(cached);
    res.setHeader("Cache-Control", cacheFor(out.resolved));
    return res.status(200).json({ themes: out.themes });
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

  const out = await withVideoIds(themes);
  res.setHeader(
    "Cache-Control",
    themes.length
      ? cacheFor(out.resolved)
      : // Empty (anime not on AnimeThemes, or no themes yet) — cache modestly so
        // a newly-added anime picks up its themes within a day.
        "public, max-age=3600, s-maxage=3600",
  );
  return res.status(200).json({ themes: out.themes });
}
