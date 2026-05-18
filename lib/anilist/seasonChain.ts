import { getMediaMeta } from "./getMediaMeta";
import {
  computeSeasonInfo,
  isSeasonLike,
  sharesFranchise,
  SeasonInfo,
} from "@/components/anime/v2/helpers";

/* Walk PREQUEL / SEQUEL edges starting from `startId` and resolve every
   ancestor / descendant via the cache-warm getMediaMeta() pipeline. Used
   by the anime info SSR to compute "S2 of 3" without keeping the whole
   chain in the page's hot path.

   AniList sometimes inserts spin-off OVAs between TV seasons in the
   relation graph (e.g. Slime S2's only PREQUEL is the "Visions of
   Coleus" OVA, not Slime S1). We have to walk through those bridges,
   otherwise the chain dead-ends one hop short of the real prior season.

   Hops are capped on each side so a malformed graph (cycle, orphan
   shorts) can't stall the SSR. */
const MAX_HOPS = 12;

const WALKABLE_FORMATS = new Set(["TV", "TV_SHORT", "ONA", "OVA", "SPECIAL"]);

function isWalkable(node: { type?: string; format?: string } | null): boolean {
  if (!node) return false;
  if (node.type && node.type !== "ANIME") return false;
  return WALKABLE_FORMATS.has(node.format || "");
}

/* Choose which edge to follow when chaining a relation.
   Prefers season-like (TV/ONA) nodes; falls back to OVA/SPECIAL so the
   walker can bridge gaps in the official relation graph. When
   `currentTitle` is provided, only follow edges that share at least
   one significant token with the franchise — avoids walking from
   One Piece into MONSTERS (Ryuma one-shot, tagged PREQUEL on AniList). */
function pickEdge(
  edges: Array<{ relationType: string; node: any }>,
  relationType: "PREQUEL" | "SEQUEL",
  currentTitle?: any
): { node: any } | null {
  const sameType = edges.filter((e) => e.relationType === relationType);
  if (sameType.length === 0) return null;

  // When we know the franchise, hard-filter on it before checking the
  // node format. Otherwise a season-like off-franchise edge (like
  // ONA "MONSTERS" tagged as PREQUEL of One Piece) would slip through
  // the seasonal-find branch and bump the season counter.
  if (currentTitle) {
    const sameFranchise = sameType.filter((e) =>
      sharesFranchise(currentTitle, e.node?.title)
    );
    if (sameFranchise.length === 0) return null;
    const seasonal = sameFranchise.find((e) => isSeasonLike(e.node));
    if (seasonal) return seasonal;
    return sameFranchise.find((e) => isWalkable(e.node)) || null;
  }

  const seasonal = sameType.find((e) => isSeasonLike(e.node));
  if (seasonal) return seasonal;
  return sameType.find((e) => isWalkable(e.node)) || null;
}

export async function resolveSeasonChain(startId: number): Promise<SeasonInfo> {
  const map = new Map<number, any>();

  async function load(id: number): Promise<any | null> {
    if (map.has(id)) return map.get(id);
    const m = await getMediaMeta(id);
    if (m) map.set(id, m);
    return m;
  }

  const start = await load(startId);
  if (!start) return { number: null, total: null };
  const startTitle = start.title;

  // Walk back through PREQUEL chain.
  let cursor = startId;
  const visitedBack = new Set<number>([startId]);
  for (let i = 0; i < MAX_HOPS; i++) {
    const media = map.get(cursor);
    if (!media) break;
    const edge = pickEdge(media.relations?.edges || [], "PREQUEL", startTitle);
    if (!edge) break;
    const nextId = Number(edge.node.id);
    if (!Number.isFinite(nextId) || visitedBack.has(nextId)) break;
    visitedBack.add(nextId);
    const next = await load(nextId);
    if (!next) break;
    cursor = nextId;
  }

  // Walk forward through SEQUEL chain.
  cursor = startId;
  const visitedFwd = new Set<number>([startId]);
  for (let i = 0; i < MAX_HOPS; i++) {
    const media = map.get(cursor);
    if (!media) break;
    const edge = pickEdge(media.relations?.edges || [], "SEQUEL", startTitle);
    if (!edge) break;
    const nextId = Number(edge.node.id);
    if (!Number.isFinite(nextId) || visitedFwd.has(nextId)) break;
    visitedFwd.add(nextId);
    const next = await load(nextId);
    if (!next) break;
    cursor = nextId;
  }

  return computeSeasonInfo(startId, map);
}
