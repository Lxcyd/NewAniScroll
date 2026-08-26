/**
 * The franchise walk's answer shape, as ONE number for every cache in front of
 * it.
 *
 * The tree is held in three places at once — the CDN (24 h, keyed by the request
 * URL), Upstash (24 h, keyed by id) and a per-instance memo (1 h) — and a change
 * to how the walk builds its answer invalidates all of them at the same moment.
 * Two numbers would mean serving yesterday's board from whichever cache was
 * forgotten, which is a bug that only shows up for a day and only for some
 * visitors.
 *
 * So: bump this on any change to the walk's SHAPE — which nodes it keeps, which
 * direction an edge points, what a node carries. Not for a change to how the
 * board is drawn from it, which needs no invalidation at all.
 *
 * History, so the next change knows what counts:
 *   2  manga drawn as leaves rather than dropped
 *   3  SOURCE reversed — the origin ranks before the anime
 *   4  PARENT reversed, to agree with CONTAINS
 *   5  anime and manga given separate node caps
 */
export const FRANCHISE_TREE_V = 5;

/**
 * The route the board reads, with the cache key already on it.
 *
 * `v` is not read by the route: it is the CDN key. The answer holds for a day,
 * so without it a franchise walked under older rules would keep serving that
 * board until tomorrow. The number is shared with the server's own cache — see
 * FRANCHISE_TREE_V above — because the two hold the same answer and must forget
 * it on the same day.
 *
 * It lives next to the version rather than in RelationsGraph, where it used to,
 * because the anime page needs it for a `<link rel=preload>` in <Head> and
 * nothing else: importing it from the component pulled the whole board — dagre,
 * the layout engine, the overlay — into that page's entry chunk to compute a
 * query string.
 */
export const relationsTreeUrl = (id: number) =>
  `/api/v2/relations/tree?id=${id}&v=${FRANCHISE_TREE_V}`;
