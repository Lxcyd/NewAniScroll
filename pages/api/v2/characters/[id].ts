import type { NextApiRequest, NextApiResponse } from "next";
import { getMediaMeta } from "@/lib/anilist/getMediaMeta";

/**
 * GET /api/v2/characters/[id]  ->  { characters: { edges: [...] } | null }
 *
 * Serves the Characters tab of the anime info page.
 *
 * `info.characters` used to ride along in the page's __NEXT_DATA__ — 11.8 KB of
 * a 292 KB HTML response for One Piece, shipped to every visitor even though
 * <Tabs> only mounts the Characters body once its tab is clicked. The SSR now
 * sends just the edge count for the tab badge and this endpoint supplies the
 * rows on demand.
 *
 * Cheap by construction: getMediaMeta reads the same warm three-layer cache
 * (memory -> AniList -> Turso) the info page already primed on this request, so
 * a click almost always resolves from process memory without touching AniList
 * or spending a Turso row read. Cast list membership effectively never changes
 * for an aired show, hence the long edge window — a HIT never reaches here.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }
  const id = Number(req.query.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Missing or invalid id" });
  }

  const media = await getMediaMeta(id);
  if (!media) {
    return res.status(404).json({ error: "Anime not found" });
  }

  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader(
    "CDN-Cache-Control",
    "public, s-maxage=86400, stale-while-revalidate=604800",
  );
  return res.status(200).json({ characters: media.characters ?? null });
}
