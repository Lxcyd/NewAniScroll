import type { NextApiRequest, NextApiResponse } from "next";
import { getMediaMeta } from "@/lib/anilist/getMediaMeta";

/**
 * GET /api/v2/media/[id]
 *
 * Client-side Media fetch for the watch page's instant SPA navigation. The
 * watch page navigates with `router.push` (SPA — React tree stays mounted, no
 * full reload) and renders the player as soon as it has `info`. To avoid the
 * blocking SSR re-fetch on every navigation, the page mounts with whatever
 * `info` is in the shared client cache (primed by the anime info page) and
 * falls back to this endpoint when it's a cold/direct hit.
 *
 * `info` (FULL_MEDIA_FIELDS) is served from the warm three-layer cache
 * (memory → AniList → Turso) — almost always a memory hit because the info
 * page primed it.
 *
 * SHAREABLE, DELIBERATELY. This used to read the session and merge the
 * signed-in user's `mediaListEntry` into the payload, which made the whole
 * ~30 kB response per-user and forced `private, no-store` — measured
 * 2026-08-22 as the only endpoint on the site that never reached the edge
 * cache (every other /api/v2 route probed came back HIT on a second request).
 * The per-user field moved to its own tiny endpoint, GET
 * /api/v2/list-entry/[id], so the heavy metadata is identical for everyone and
 * the CDN serves it. Same split the anime info page and the watch SSR already
 * made for their per-user bits.
 *
 * `mediaListEntry: null` stays in the shape so callers that spread this
 * response keep the field they expect; the watch page's backfill effect fills
 * it in for signed-in viewers.
 */

const TTL_S = 30 * 60;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = Number(req.query.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Missing or invalid id" });
  }

  const media = await getMediaMeta(id);
  if (!media) {
    // Cache the miss briefly too — a bad id in a shared link would otherwise
    // re-invoke the function (and the whole three-layer lookup) on every hit.
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(404).json({ error: "Anime not found" });
  }

  //  - `Cache-Control`     → browser, 5 min.
  //  - `CDN-Cache-Control` → Vercel's edge. 30 min + a day of
  //    stale-while-revalidate, matching the watch page's own SSR window:
  //    episodes can appear on an airing show while a copy is cached, and this
  //    payload is the same metadata that page serves.
  res.setHeader("Cache-Control", "public, max-age=300");
  res.setHeader(
    "CDN-Cache-Control",
    `public, s-maxage=${TTL_S}, stale-while-revalidate=86400`,
  );
  return res.status(200).json({ ...media, mediaListEntry: null });
}
