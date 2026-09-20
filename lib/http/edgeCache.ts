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

/** Browser TTL for a failure. Short: a visitor retrying by hand should get a
 *  real attempt, not their own cached error. */
const ERROR_BROWSER_MAX_AGE_S = 10;
/** Edge TTL for a failure. Long enough to absorb a crowd, short enough that a
 *  recovery reaches everyone within the minute. */
const ERROR_EDGE_TTL_S = 60;
const ERROR_STALE_WHILE_REVALIDATE_S = 300;

/**
 * Cache headers for an ERROR response (upstream down, 404, 5xx).
 *
 * An error is a result, and it needs a TTL like any other. Without this, the
 * failure paths of these routes carried either nothing at all or a bare
 * `Cache-Control: max-age=60` — and a bare `Cache-Control` only ever reaches
 * the BROWSER. Vercel's edge reads `s-maxage` / `CDN-Cache-Control`, so during
 * the 02/09/2026 AniList outage — when the error branch WAS the site's majority
 * response — nothing was absorbed at the edge: every client request became a
 * billed edge request plus a function invocation plus a Redis GET that could
 * only miss. That is what took edge requests from ~10k to ~130k a day.
 *
 * Deliberately shorter than any success TTL: a stuck error costs more than a
 * stale success, so recovery must be visible fast.
 */
export function setEdgeErrorCache(res: NextApiResponse, edgeTtlSeconds = ERROR_EDGE_TTL_S) {
  res.setHeader("Cache-Control", `public, max-age=${ERROR_BROWSER_MAX_AGE_S}`);
  res.setHeader(
    "CDN-Cache-Control",
    `public, s-maxage=${edgeTtlSeconds}, stale-while-revalidate=${ERROR_STALE_WHILE_REVALIDATE_S}`,
  );
}
