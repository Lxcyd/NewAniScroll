import type { NextApiRequest, NextApiResponse } from "next";
import { fetchRelationsBatch } from "@/lib/anilist/relationsBatch";

/**
 * GET /api/v2/relations/batch?ids=1,2,3
 *
 * The same answer as `/api/v2/relations/[id]`, for a wave of nodes at once.
 *
 * The graph walks a franchise level by level, and every node on a level needs
 * its own relations before the next level can be drawn — one round trip each.
 * Sword Art Online cost 19 of them, in enough waves that the board visibly grew
 * under the viewer; asking for a whole level in one request turns that into 3.
 *
 * Static file beats the sibling dynamic route in Next's resolution, so "batch"
 * never lands in `[id].ts` as an id.
 *
 * One request in, one AniList query out: `fetchRelationsBatch` resolves the
 * whole wave together rather than fanning out per id, which is what made the
 * first opening of a franchise take seconds.
 *
 * A missing or failing id yields no entry rather than a 500 — one dead node
 * must not cost the caller its whole level. The caller reads the map by id and
 * treats an absent key as "no relations", exactly as it treats a 404 today.
 */

const TTL_S = 24 * 60 * 60;
/** One dagre level of an ordinary franchise. Past this the URL stops being
 *  cacheable in practice (every caller assembles a different list), so the
 *  caller splits instead. */
const MAX_IDS = 30;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const raw = String(req.query.ids || "");
  const ids = Array.from(
    new Set(
      raw
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
    )
  )
    // Sorted so the same level asked twice produces the same URL, and the edge
    // cache sees one key instead of one per permutation.
    .sort((a, b) => a - b)
    .slice(0, MAX_IDS);

  if (ids.length === 0) {
    return res.status(400).json({ error: "Missing or invalid ids" });
  }

  // ONE upstream query for the wave, not one per id — see `fetchRelationsBatch`.
  const items = await fetchRelationsBatch(ids);

  // Every id missing means the upstream is unreachable, not that all of them
  // are unknown — don't let that answer sit in a cache for a day.
  if (items.length === 0) {
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(200).json({ items });
  }

  res.setHeader("Cache-Control", "public, max-age=600");
  res.setHeader("CDN-Cache-Control", `public, s-maxage=${TTL_S}, stale-while-revalidate=86400`);
  return res.status(200).json({ items });
}
