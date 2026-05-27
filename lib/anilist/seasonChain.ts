import { getMediaMeta } from "./getMediaMeta";
import { redis } from "@/lib/redis";
import {
  computeSeasonInfo,
  extractSeasonFromTitle,
  isSeasonLike,
  sharesFranchise,
  SeasonInfo,
} from "@/components/anime/v2/helpers";

/* Redis cache for the walker results. Each SSR of an info page used to
   trigger 10-30 getCachedAnime() calls (one per node in the relation
   chain × 2 for chain+list), which is the dominant Turso read source.
   Caching the resolved output sidesteps the walk entirely on warm
   reads. 7-day TTL: the only thing that invalidates a season chain is
   AniList publishing a brand-new sequel, which is rare and tolerates
   a week of staleness. */
const REDIS_KEY_CHAIN = (id: number) => `seasonChain:v1:${id}`;
const REDIS_KEY_LIST = (id: number) => `seasonList:v1:${id}`;
const TTL_SECONDS = 7 * 24 * 60 * 60;

async function redisGetJson<T>(key: string): Promise<T | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

async function redisSetJson(key: string, value: unknown): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), "EX", TTL_SECONDS);
  } catch {
    /* non-fatal */
  }
}

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
  const cached = await redisGetJson<SeasonInfo>(REDIS_KEY_CHAIN(startId));
  if (cached) return cached;
  const result = await resolveSeasonChainUncached(startId);
  // Only cache positive resolutions to avoid pinning a "no info" answer
  // for 7 days when the underlying issue was a transient AniList blip.
  if (result.number != null) await redisSetJson(REDIS_KEY_CHAIN(startId), result);
  return result;
}

async function resolveSeasonChainUncached(startId: number): Promise<SeasonInfo> {
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

/** Lightweight entry exposed to the Episodes tab's season switcher. */
export type SeasonEntry = {
  id: number;
  /** Position in the chain, 1-based. */
  number: number;
  /** Display label (e.g. "Season 2 Part 2"). */
  label: string;
  /** Air year if known — used as secondary line in the dropdown. */
  year: number | null;
  /** Total episodes if known. */
  episodes: number | null;
  /** AniList format, used to filter out movies / OVAs from the
   *  switcher (we only want TV-like seasons there). */
  format: string | null;
  /** Full localised titles — present so the Relations widget can render
   *  proper cards (with cover + title) directly from the season list. */
  title?: {
    english?: string | null;
    romaji?: string | null;
    userPreferred?: string | null;
    native?: string | null;
  } | null;
  /** Cover image URLs from AniList. Optional because the walker uses
   *  getMediaMeta() which may return a thinned-out cache row. */
  coverImage?: {
    extraLarge?: string | null;
    large?: string | null;
  } | null;
};

/* Same walk as resolveSeasonChain but returns the ordered list of every
   season-like anime in the franchise (with id + label + air year).
   Powers the season picker in the Episodes tab so a viewer on Slime S1
   can jump straight to S2 or S2 Part 2. */
export async function resolveSeasonList(
  startId: number
): Promise<SeasonEntry[]> {
  const cached = await redisGetJson<SeasonEntry[]>(REDIS_KEY_LIST(startId));
  if (cached) return cached;
  const result = await resolveSeasonListUncached(startId);
  // Cache even empty arrays — an anime with no season siblings is a
  // stable fact; recomputing it every page render wastes the walk.
  await redisSetJson(REDIS_KEY_LIST(startId), result);
  return result;
}

async function resolveSeasonListUncached(
  startId: number
): Promise<SeasonEntry[]> {
  const map = new Map<number, any>();

  async function load(id: number): Promise<any | null> {
    if (map.has(id)) return map.get(id);
    const m = await getMediaMeta(id);
    if (m) map.set(id, m);
    return m;
  }

  const start = await load(startId);
  if (!start) return [];
  const startTitle = start.title;

  // Collect ancestors (walk PREQUEL) — closest first; we'll reverse so
  // the chain is chronological at the end.
  const backIds: number[] = [];
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
    backIds.push(nextId);
    cursor = nextId;
  }

  // Collect descendants (walk SEQUEL).
  const fwdIds: number[] = [];
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
    fwdIds.push(nextId);
    cursor = nextId;
  }

  // Build the full chain in chronological order: [oldest…current…newest]
  const chainIds = [...backIds.slice().reverse(), startId, ...fwdIds];

  // Only emit season-like nodes (TV/TV_SHORT/ONA) — drop OVA bridges.
  // For each kept node, derive a friendly label.
  const seasonLike = chainIds
    .map((id) => map.get(id))
    .filter((m) => m && isSeasonLike(m));

  return seasonLike.map((m, i) => {
    const fromTitle = extractSeasonFromTitle(m.title);
    const partMatch = String(
      m.title?.english || m.title?.romaji || ""
    ).match(/\b(?:Part|Cour)\s+(\d+|[IVX]+)\b/i);
    const part = partMatch ? ` Part ${partMatch[1].toUpperCase()}` : "";
    return {
      id: Number(m.id),
      number: fromTitle ?? i + 1,
      label: `Season ${fromTitle ?? i + 1}${part}`,
      year: m.seasonYear ?? m.startDate?.year ?? null,
      episodes: m.episodes ?? null,
      format: m.format ?? null,
      // Pulled from the same Media payload getMediaMeta already returned —
      // costs nothing extra but lets the Relations widget render full
      // poster cards without re-fetching per-id on the client.
      title: m.title || null,
      coverImage: m.coverImage || null,
    };
  });
}
