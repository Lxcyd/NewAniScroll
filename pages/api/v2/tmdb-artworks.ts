import type { NextApiRequest, NextApiResponse } from "next";
import { getTmdbArtworks } from "@/lib/tmdb/artworks";
import { loadFanarts } from "@/lib/db/fanarts";
import { collectArtworks } from "@/components/anime/v2/helpers";

/**
 * GET /api/v2/tmdb-artworks?anime=<anilist_id>
 *
 * TMDB's image library for the info page's Artworks tab. Deliberately a
 * SEPARATE endpoint from /api/v2/fanarts rather than a field added to it:
 *
 *  - fanart.tv rows come from Turso and are always cheap; TMDB's may cost an
 *    upstream call on a cold key. Merging them would make the fanart response
 *    as slow as the slowest provider, on a tab that already renders fine with
 *    just one of them.
 *  - the tab can therefore paint fanart.tv immediately and let TMDB arrive
 *    after, instead of holding both back.
 *
 * Same edge-cache policy as /api/v2/fanarts: the answer is identical for every
 * visitor, so an hour at the edge with a day of stale-while-revalidate keeps
 * this off the function almost entirely.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const animeId = Number(req.query.anime);
  if (!Number.isFinite(animeId)) {
    return res
      .status(400)
      .json({ error: "Missing or invalid `anime` query parameter" });
  }

  /* Load the fanart.tv side here, server-side, so TMDB images that merely
     duplicate one can be dropped before they ever reach the client. The gallery
     shows both libraries, and the same official poster lives in both under
     different hosts and different dimensions — only a content comparison can
     see it, and only the server can afford one. `collectArtworks` is reused
     verbatim so we compare against exactly what the tab renders, not against
     rows it filters out. */
  const fanarts = await loadFanarts(animeId).catch(() => null);
  const fanartUrls = collectArtworks(fanarts).map((a) => a.url);

  // Never throws — an unmapped title or a missing key is an empty list, which
  // the tab renders as "just the fanart.tv rows", i.e. what it did before.
  const arts = await getTmdbArtworks(animeId, fanartUrls);

  res.setHeader(
    "Cache-Control",
    "public, s-maxage=3600, stale-while-revalidate=86400",
  );
  return res.status(200).json({ animeId, arts });
}
