/**
 * Cache headers for the public, anonymous JSON endpoints.
 *
 * The same closure was redefined inside three handlers (/api/v2/catalog/[sort],
 * /api/v2/discover/[page], /api/v2/etc/recent/[page]) with only the s-maxage
 * differing. These headers are the difference between a request billed as a
 * Vercel Edge Request and no request at all, so they are worth having in one
 * place where a change applies everywhere rather than in two of three copies.
 *
 * The split is deliberate:
 *   - `Cache-Control` targets the BROWSER. Short (5 min), because a hard
 *     refresh should still feel live.
 *   - `CDN-Cache-Control` targets Vercel's edge, and carries the real TTL plus
 *     a day of stale-while-revalidate so an expiry never costs a visitor a
 *     slow response.
 */

import type { NextApiResponse } from "next";

/** How long the BROWSER may reuse the response without asking again. */
const BROWSER_MAX_AGE_S = 300;
/** How long the edge may serve a stale copy while it refreshes behind us. */
const STALE_WHILE_REVALIDATE_S = 86400;

export function setEdgeCache(res: NextApiResponse, edgeTtlSeconds: number) {
  res.setHeader("Cache-Control", `public, max-age=${BROWSER_MAX_AGE_S}`);
  res.setHeader(
    "CDN-Cache-Control",
    `public, s-maxage=${edgeTtlSeconds}, stale-while-revalidate=${STALE_WHILE_REVALIDATE_S}`,
  );
}
