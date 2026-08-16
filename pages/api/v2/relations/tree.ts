import type { NextApiRequest, NextApiResponse } from "next";
import { getFranchiseTree, type TreeMeta } from "@/lib/anilist/franchiseTree";

/**
 * GET /api/v2/relations/tree?id=N
 *
 * A whole franchise — every node and every labelled edge — in ONE answer.
 *
 * The graph used to assemble this in the browser, level by level, against
 * `/api/v2/relations/batch`. Each level needs the previous one's answer, so it
 * cost six to eight SEQUENTIAL round trips to the edge: measured on a 250ms
 * link, Sword Art Online's board took 4.6s to settle and One Piece's 7.5s, and
 * because the walk published a draft halfway through, every card on the board
 * moved when the real picture arrived.
 *
 * One request replaces that walk. It is also CHEAPER to serve, not just faster:
 * the batch route's cache key is a list of ids, so a franchise spread six ways
 * occupied six entries whose composition shifts with the traversal; this one is
 * a single URL per anime, holds for a day, and the walk behind it reuses the
 * same `fetchRelationsBatch` — one AniList query per level, one rate-limit
 * token, whether it answers one visitor or ten thousand.
 *
 * `/api/v2/relations/batch` stays: it is still the right shape for anything
 * that wants one level, and this route is built on the same function.
 */

const TTL_S = 24 * 60 * 60;
/** A walk that ran out of budget — the next request warms it further. */
const PARTIAL_TTL_S = 5 * 60;

/**
 * The walk is one call now, where it used to be six to eight the browser made
 * in turn — each with a timeout of its own. A cold franchise behind a
 * rate-limited upstream needs more than a default budget, and the walk's own
 * deadline (WALK_BUDGET_MS) keeps it comfortably inside this one.
 */
export const config = { maxDuration: 25 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = Number(req.query.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "Missing or invalid id" });
  }

  let tree: Awaited<ReturnType<typeof getFranchiseTree>> | null = null;
  const meta: TreeMeta = { source: "walk" };
  try {
    tree = await getFranchiseTree(id, meta);
  } catch {
    /* treated as a miss */
  }

  // No node at all means the upstream was unreachable, not that the anime has
  // no relations — an empty franchise still contains the anime itself. Don't
  // let that answer sit in a cache for a day.
  if (!tree || tree.nodes.length === 0) {
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(200).json({ nodes: [], edges: [], partial: true });
  }

  // A franchise's shape changes about once a season, so a complete answer holds
  // for a day. A truncated one holds for minutes: it is still worth serving —
  // most of the board, immediately — but it must not be what everybody sees
  // until tomorrow.
  const ttl = tree.partial ? PARTIAL_TTL_S : TTL_S;
  /*
   * Which cache answered — `memo`, `redis` or `walk`.
   *
   * Diagnostic, and it earns its line: from outside, the shared cache is
   * invisible. Ask twice and the per-instance memo answers the second call, so
   * a fast reply proves nothing about whether the walk is now paid once for
   * everybody or once per lambda. This says which.
   */
  res.setHeader("x-tree-cache", meta.source);
  res.setHeader("Cache-Control", `public, max-age=${tree.partial ? 60 : 600}`);
  res.setHeader("CDN-Cache-Control", `public, s-maxage=${ttl}, stale-while-revalidate=${ttl}`);
  return res.status(200).json(tree);
}
