import type { NextApiRequest, NextApiResponse } from "next";
import { getMediaMeta } from "@/lib/anilist/getMediaMeta";

/**
 * GET /api/v2/relations/[id]
 *
 * One node's relation edges, and nothing else — for the franchise graph, which
 * needs the SECOND level of the tree: the info page carries an entry's own
 * relations, so the graph can draw its neighbours, but not how those neighbours
 * connect to each other. Without this, Sword Art Online's map stops at its five
 * direct relations and never reaches Alicization or Gun Gale, which is most of
 * the franchise (Hayase walks two levels for the same reason —
 * `_generateRelationsTree` in their anilist client).
 *
 * Deliberately NOT /api/v2/media/[id]: that route reads the session to merge
 * the caller's list entry, so its answer is per-user and cannot be shared at
 * the edge. This one is the same for everybody and a franchise's shape changes
 * about once a season, so it caches for a day and a warm graph costs the
 * browser one round trip per node, most of them 304s.
 *
 * The underlying `getMediaMeta` is the warm three-layer cache (memory →
 * AniList → Turso), so a miss here is usually a Turso read, not an AniList
 * call.
 */

const TTL_S = 24 * 60 * 60;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = Number(req.query.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "Missing or invalid id" });
  }

  let media: any = null;
  try {
    media = await getMediaMeta(id);
  } catch {
    /* treated as a miss */
  }

  if (!media) {
    // A short window: a miss is usually AniList being unreachable rather than a
    // permanently unknown id.
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(404).json({ error: "Anime not found" });
  }

  const edges = (media.relations?.edges || [])
    .filter((e: any) => e?.node?.id && e.node.type !== "MANGA")
    .map((e: any) => ({
      relationType: e.relationType,
      node: {
        id: Number(e.node.id),
        type: e.node.type ?? null,
        format: e.node.format ?? null,
        status: e.node.status ?? null,
        episodes: e.node.episodes ?? null,
        title: e.node.title ?? null,
      },
    }));

  res.setHeader("Cache-Control", "public, max-age=600");
  res.setHeader("CDN-Cache-Control", `public, s-maxage=${TTL_S}, stale-while-revalidate=86400`);
  return res.status(200).json({
    id: media.id,
    format: media.format ?? null,
    status: media.status ?? null,
    episodes: media.episodes ?? null,
    title: media.title ?? null,
    edges,
  });
}
