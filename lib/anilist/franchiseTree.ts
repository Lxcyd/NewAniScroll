import { fetchRelationsBatch } from "./relationsBatch";
import type { RelationsPayload } from "./relationsPayload";

/**
 * The franchise graph's walk, run on the server.
 *
 * It used to live in the browser, in `RelationsGraph`, and that is what made
 * the board reorganise itself under the reader. Not because the walk was
 * wrong — because it PUBLISHED twice and the two pictures disagree by design:
 * the traversal order decides the direction of a disputed pair (Sword Art
 * Online II calls Fatal Bullet's pilot a PARENT, the pilot calls II an OTHER),
 * dagre ranks on direction, and the walk is run a second time from the
 * franchise's root so that every page of a franchise draws the same board. The
 * first picture was therefore a draft, shown for a second and a half, and every
 * card moved when the real one arrived (measured: 13/13 on SAO, 23/23 on Fate,
 * 54/54 on One Piece).
 *
 * Moving it here fixes that at the source — there is one answer, so there is
 * one picture — and it is also, on its own, the biggest speed-up available. The
 * walk is breadth-first and each level needs the previous one's answer, so in
 * the browser it cost six to eight SEQUENTIAL round trips to the edge. Here the
 * levels are resolved next to AniList and the browser makes ONE request, which
 * the CDN then answers for everybody else.
 *
 * The traversal below is the browser's, transcribed rather than paraphrased:
 * an equivalent-looking rewrite lands on a different picture. Their rules, in
 * their order:
 *
 *  - Only ANIME nodes, never a CHARACTER relation. Both exclusions sit on the
 *    EDGE, so the manga a series adapts is never drawn AND never expanded —
 *    expanding it is what used to drag unrelated shows onto the board, the
 *    light novel being a franchise's hub.
 *
 *  - One edge per PAIR. A pair already drawn is skipped whole — no second edge
 *    and no recursion through it — unless it is a PARENT, which is a broad term
 *    worth replacing by any more specific relation that turns up.
 *
 *  - PREQUEL is drawn reversed and relabelled SEQUEL, so chains point one way.
 *
 * Depth 2 ends a pass, not the walk: nodes reached at that limit are queued,
 * re-fetched, and processed as new roots until nothing new appears.
 */

/** What a card needs to be drawn. */
export type FranchiseNode = {
  id: number;
  type?: string | null;
  format?: string | null;
  status?: string | null;
  episodes?: number | null;
  title?: any;
  cover?: string | null;
};

export type FranchiseEdge = { from: number; to: number; label: string };

export type FranchiseTree = {
  nodes: FranchiseNode[];
  edges: FranchiseEdge[];
  /** The walk ran out of budget — see WALK_BUDGET_MS. Never cached for a day. */
  partial?: boolean;
};

/**
 * How long the walk may keep asking AniList for more.
 *
 * This is the one thing the move to the server made riskier, and it has to be
 * said plainly. In the browser the walk was six to eight SEPARATE requests, so
 * each level got its own function timeout and a slow franchise merely trickled;
 * here it is ONE call, and a cold franchise on a contended rate limiter (28
 * queries/minute, fleet-wide) can take far longer than a function is allowed to
 * live — measured at 45s for One Piece and 80s for Fate against a cold cache
 * with no Redis at all.
 *
 * So the walk stops expanding when the budget is gone and answers with what it
 * has, flagged `partial`. A partial answer is cached for minutes rather than a
 * day, so the next visitor — walking a cache the first one warmed — gets the
 * complete franchise and that is what settles in for the day.
 */
const WALK_BUDGET_MS = 15_000;

/**
 * Walk bounds. A franchise like Gundam or Fate is a web without them, and the
 * cap only ever removes the outermost, least relevant entries (Sword Art Online
 * is ~19 nodes, Fate ~42, One Piece ~60).
 */
const MAX_NODES = 60;
const MAX_ROUNDS = 8;
/** Matches MAX_IDS in the batch route and AniList's own page size. */
const BATCH_MAX = 30;

/** A character is not a work. */
const EXCLUDED_RELATIONS = new Set(["CHARACTER"]);

const isAnime = (m: any) => (m?.type ?? "ANIME") === "ANIME";

type Walked = { nodes: Map<number, FranchiseNode>; edges: Map<string, FranchiseEdge> };

/**
 * One franchise, in one call.
 *
 * `id` is only where the walk STARTS. It ends up re-rooted on the franchise's
 * oldest entry, so every member of a franchise gets a byte-identical answer —
 * which is also why the memo below is keyed on the root rather than on `id`.
 */
export async function buildFranchiseTree(id: number): Promise<FranchiseTree> {
  /**
   * One request per WAVE, not per node.
   *
   * The walk asks for a whole level in one synchronous burst and then awaits it
   * node by node. Registering each id and flushing on the microtask that
   * follows the burst turns that level into a single AniList query, while every
   * caller still gets its own promise — so the traversal ORDER, which decides
   * the picture, is untouched.
   */
  const relCache = new Map<number, Promise<RelationsPayload | null>>();
  const waiting = new Map<number, (v: RelationsPayload | null) => void>();
  let flushQueued = false;

  const deadline = Date.now() + WALK_BUDGET_MS;
  let partial = false;

  const flush = () => {
    flushQueued = false;
    const wave = Array.from(waiting.entries());
    waiting.clear();
    for (let i = 0; i < wave.length; i += BATCH_MAX) {
      const slice = wave.slice(i, i + BATCH_MAX);
      fetchRelationsBatch(slice.map(([wid]) => wid))
        .then((items) => {
          const byId = new Map<number, RelationsPayload>();
          for (const item of items) byId.set(Number(item?.id), item);
          // An id upstream couldn't resolve becomes null, which the caller
          // already treats as "no relations".
          for (const [wid, resolve] of slice) resolve(byId.get(wid) ?? null);
        })
        .catch(() => {
          for (const [, resolve] of slice) resolve(null);
        });
    }
  };

  const getRelations = (nid: number) => {
    let p = relCache.get(nid);
    if (!p) {
      // Past the budget the walk stops REACHING, but it keeps reading: anything
      // already fetched still answers, which is what lets the re-rooting pass
      // below run to completion off the cache and keep the board identical from
      // every page of the franchise.
      if (Date.now() > deadline) {
        partial = true;
        return Promise.resolve(null);
      }
      p = new Promise<RelationsPayload | null>((resolve) => {
        waiting.set(nid, resolve);
        if (!flushQueued) {
          flushQueued = true;
          Promise.resolve().then(flush);
        }
      });
      relCache.set(nid, p);
    }
    return p;
  };

  /** ONE walk, from one root — its node map and edge map local to the call. */
  const walkFrom = async (root: FranchiseNode): Promise<Walked> => {
    const nodes = new Map<number, FranchiseNode>();
    const edges = new Map<string, FranchiseEdge>();
    const frontier = new Set<number>();

    /** A node's own edges, and the fuller metadata that comes with them. */
    const edgesOf = async (nid: number): Promise<any[]> => {
      const data = await getRelations(nid);
      if (!data) return [];
      const known = nodes.get(nid);
      if (known) {
        // The fetch knows more than the edge did — status, episode count.
        nodes.set(nid, {
          ...known,
          title: data.title ?? known.title,
          format: data.format ?? known.format,
          status: data.status ?? known.status,
          episodes: data.episodes ?? known.episodes,
          cover: data.cover ?? known.cover ?? null,
        });
      }
      return data.edges || [];
    };

    const processEdges = async (m: any, depth = 0): Promise<void> => {
      if (!m) return;
      if (!isAnime(m)) return;
      const nid = Number(m.id);
      if (!Number.isFinite(nid) || nid <= 0) return;

      if (!nodes.has(nid)) {
        if (nodes.size >= MAX_NODES) return;
        if (depth >= 2) frontier.add(nid);
        nodes.set(nid, {
          ...m,
          cover: m.cover ?? m.coverImage?.large ?? m.coverImage?.extraLarge ?? null,
        });
      }
      if (depth >= 2) return;

      const list = await edgesOf(nid);

      // Every child we are about to walk into needs its own relations. Asking
      // for them together turns a level into one wave instead of a queue of
      // them; the traversal order is untouched.
      if (depth + 1 < 2) {
        for (const e of list) {
          const n = e?.node;
          if (n?.id && isAnime(n) && !EXCLUDED_RELATIONS.has(e.relationType)) {
            getRelations(Number(n.id));
          }
        }
      }

      for (const e of list) {
        const node = e?.node;
        if (!node?.id) continue;
        if (!isAnime(node) || EXCLUDED_RELATIONS.has(e.relationType)) continue;
        const oid = Number(node.id);

        const key = [oid, nid].sort((a, b) => a - b).join("-");
        const existing = edges.get(key);
        if (existing) {
          if (existing.label === "PARENT") edges.delete(key);
          else continue;
        }
        const isPrequel = e.relationType === "PREQUEL";
        edges.set(key, {
          from: isPrequel ? oid : nid,
          to: isPrequel ? nid : oid,
          label: isPrequel ? "SEQUEL" : e.relationType || "OTHER",
        });

        await processEdges(node, depth + 1);
      }
    };

    await processEdges(root);

    for (let round = 0; round < MAX_ROUNDS && frontier.size > 0; round++) {
      // AniList returns their batched Page in id order; same order here, so the
      // same end of a disputed pair is the one visited first.
      const ids = Array.from(frontier).sort((a, b) => a - b);
      frontier.clear();

      // Await the round's payloads up front so everything they point at can be
      // registered in one further burst — by the time the sequential walk
      // starts, every fetch it needs is already in flight. Prefetching decides
      // nothing about order.
      const payloads = await Promise.all(ids.map((rid) => getRelations(rid)));
      for (const data of payloads) {
        for (const e of data?.edges || []) {
          const n = e?.node;
          if (n?.id && isAnime(n) && !EXCLUDED_RELATIONS.has(e.relationType)) {
            getRelations(Number(n.id));
          }
        }
      }

      for (const rid of ids) {
        await processEdges(nodes.get(rid) ?? { id: rid, type: "ANIME" });
      }
    }
    return { nodes, edges };
  };

  /**
   * The franchise's own starting point: its oldest entry, by AniList id.
   *
   * Any rule would do as long as it names the SAME node from every page — that
   * is the whole job. The oldest is also the one that gives the walk the
   * picture it was designed for, a franchise read outwards from where it began.
   */
  const rootOf = (walked: Walked) =>
    Array.from(walked.nodes.keys()).reduce((a, b) => (b < a ? b : a), Infinity);

  let result = await walkFrom({ id, type: "ANIME" });

  /**
   * Then the same walk again from the root, and THAT is the answer.
   *
   * It costs no upstream request: the first walk has already pulled every
   * node's relations into `relCache`, so the second reads them from memory. The
   * loop is for the case where re-rooting brings in an older entry the first
   * walk never reached; it settles in one round in practice.
   */
  let usedRoot = id;
  for (let attempt = 0; attempt < 3; attempt++) {
    const root = rootOf(result);
    if (!Number.isFinite(root) || root === usedRoot) break;
    result = await walkFrom(result.nodes.get(root) ?? { id: root, type: "ANIME" });
    usedRoot = root;
  }

  return {
    nodes: Array.from(result.nodes.values()),
    edges: Array.from(result.edges.values()),
    ...(partial ? { partial: true } : null),
  };
}

/**
 * Franchise-level memo, per warm instance.
 *
 * The CDN already answers the second visitor of the SAME page for a day; this
 * catches the other half — the second page of the same franchise, which
 * re-roots onto the identical tree and would otherwise re-walk it in full. One
 * entry per franchise, and the map is small enough that a plain size cap beats
 * pulling in an LRU.
 */
const memo = new Map<number, { at: number; tree: FranchiseTree }>();
const MEMO_TTL_MS = 60 * 60 * 1000;
const MEMO_MAX = 200;

export async function getFranchiseTree(id: number): Promise<FranchiseTree> {
  const hit = memo.get(id);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.tree;

  const tree = await buildFranchiseTree(id);

  // A truncated walk must not be what the next hour serves — the point of
  // flagging it is that the following request, against a warmer cache, gets
  // further.
  if (tree.partial) return tree;

  // Keyed on every member, not just the root: the answer is the same from any
  // page of the franchise, so the next one of them is a map lookup.
  if (memo.size > MEMO_MAX) memo.clear();
  const at = Date.now();
  for (const n of tree.nodes) memo.set(n.id, { at, tree });
  memo.set(id, { at, tree });

  return tree;
}
