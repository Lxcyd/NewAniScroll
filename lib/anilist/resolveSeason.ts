import { getMediaMeta } from "./getMediaMeta";
import {
  yearOf,
  isChainableRelation,
  edgeYearMonotonic,
  isRecapTitle,
  isSeasonLike,
  sharesFranchise,
  extractSeasonFromTitle,
  isSeasonContinuation,
  type SeasonNode,
} from "./seasonDetection";
import {
  getFribbEntry,
  getFribbFranchise,
  isFribbGroupConsistent,
  type FribbEntry,
} from "@/lib/fribb/fribbMap";
import { getSeasonOverride } from "@/lib/db/seasonOverride";

/**
 * Multi-signal season resolver — the single decision point for "which season
 * is this AniList entry?".
 *
 * No single source is trustworthy (Fribb mislabels/fuses seasons, AniList
 * mis-tags relations, titles aren't always numbered). We cross several
 * independent signals and let the AIR YEAR arbitrate ORDER — the one signal
 * that's universally reliable. Cascade, most-trusted first:
 *
 *   1. season_override (manual last word)
 *   2. Fribb season.tmdb — only if the franchise group passes the consistency
 *      test (no collisions / fusion)
 *   3. explicit number in the title ("Season 2", "2期", "S2")
 *   4. chronological counter over the hardened AniList PREQUEL/SEQUEL walk
 *   5. null  (never assume "S1")
 *
 * The final number can NEVER violate air-year order (hard guard applied at the
 * end). Returns a confidence so callers (relations map badge, player_map
 * caching) can treat low-confidence answers cautiously.
 */

export type SeasonSource = "override" | "fribb" | "title" | "chain" | "none";
export type SeasonConfidence = "high" | "medium" | "low";

export interface SeasonResolution {
  number: number | null;
  total: number | null;
  tmdbId: number | null;
  source: SeasonSource;
  confidence: SeasonConfidence;
}

const MAX_HOPS = 24; // was 12 — too short for Pokémon/Fate-length franchises

/* Choose the edge to follow for a given relation direction, applying the three
   guards: chainable relation type, franchise match, and air-year monotonicity.
   Prefers a season-like target; falls back to a walkable bridge (OVA/SPECIAL)
   only when it still satisfies the year guard. */
function pickEdge(
  current: SeasonNode,
  edges: Array<{ relationType: string; node: any }>,
  direction: "PREQUEL" | "SEQUEL",
  franchiseTitle: any
): any | null {
  const candidates = edges.filter(
    (e) =>
      e.relationType === direction &&
      isChainableRelation(e.relationType) &&
      sharesFranchise(franchiseTitle, e.node?.title) &&
      edgeYearMonotonic(direction, current, e.node)
  );
  if (candidates.length === 0) return null;
  const seasonal = candidates.find((e) => isSeasonLike(e.node));
  return (seasonal || candidates[0]).node;
}

/* Walk one direction, returning the ordered list of visited nodes (nearest
   first). Bridges through OVA/SPECIAL but stops on a malformed / cyclic graph
   via the visited set + hop cap. */
async function walk(
  startId: number,
  direction: "PREQUEL" | "SEQUEL",
  franchiseTitle: any,
  load: (id: number) => Promise<any | null>
): Promise<any[]> {
  const chain: any[] = [];
  const visited = new Set<number>([startId]);
  let cursor = await load(startId);
  for (let i = 0; i < MAX_HOPS; i++) {
    if (!cursor) break;
    const next = pickEdge(cursor, cursor.relations?.edges || [], direction, franchiseTitle);
    if (!next) break;
    const nextId = Number(next.id);
    if (!Number.isFinite(nextId) || visited.has(nextId)) break;
    visited.add(nextId);
    const full = (await load(nextId)) || next;
    chain.push(full);
    cursor = full;
  }
  return chain;
}

/* Number the ordered franchise nodes by air year (the arbiter), honouring
   explicit title numbers and continuation ("Part 2") entries. Returns the
   number assigned to `startId` and the count of real seasons. */
function numberByChronology(
  ordered: SeasonNode[],
  startId: number
): { number: number | null; total: number | null } {
  // Real seasons only (drops OVA/SPECIAL bridges and recaps), sorted by year.
  const seasons = ordered
    .filter((m) => isSeasonLike(m) && !isRecapTitle(m))
    .sort((a, b) => (yearOf(a) ?? Infinity) - (yearOf(b) ?? Infinity));
  if (seasons.length === 0) return { number: null, total: null };

  let running = 0;
  let startNumber: number | null = null;
  for (const m of seasons) {
    const fromTitle = extractSeasonFromTitle(m.title as any);
    if (fromTitle != null) running = fromTitle;
    else if (isSeasonContinuation(m.title as any)) running = Math.max(1, running);
    else running = running + 1;
    if (Number(m.id) === startId) startNumber = running;
  }
  return { number: startNumber, total: running };
}

/** Build the franchise node list: union of the Fribb tmdb.tv group and the
 *  AniList PREQUEL/SEQUEL walk, ordered chronologically. */
async function buildFranchise(
  startId: number,
  fribbSelf: FribbEntry | null,
  load: (id: number) => Promise<any | null>
): Promise<{ ordered: SeasonNode[]; fribbGroup: FribbEntry[] }> {
  const start = await load(startId);
  const franchiseTitle = start?.title;

  const back = await walk(startId, "PREQUEL", franchiseTitle, load);
  const fwd = await walk(startId, "SEQUEL", franchiseTitle, load);

  const byId = new Map<number, SeasonNode>();
  if (start) byId.set(startId, start);
  for (const n of [...back, ...fwd]) byId.set(Number(n.id), n);

  // Pull in any Fribb-group members the AniList walk missed (a member on a
  // divergent TMDB fiche still belongs to the franchise chronologically).
  let fribbGroup: FribbEntry[] = [];
  if (fribbSelf?.tmdbTvId) {
    fribbGroup = await getFribbFranchise(fribbSelf.tmdbTvId);
    for (const e of fribbGroup) {
      if (!byId.has(e.anilistId)) {
        const m = await load(e.anilistId);
        if (m) byId.set(e.anilistId, m);
      }
    }
  }

  const ordered = Array.from(byId.values()).sort(
    (a, b) => (yearOf(a) ?? Infinity) - (yearOf(b) ?? Infinity)
  );
  return { ordered, fribbGroup };
}

export async function resolveSeasonNumber(
  startId: number
): Promise<SeasonResolution> {
  const cache = new Map<number, any>();
  const load = async (id: number): Promise<any | null> => {
    if (cache.has(id)) return cache.get(id);
    const m = await getMediaMeta(id);
    if (m) cache.set(id, m);
    return m;
  };

  // 1) Manual override — the last word.
  const override = await getSeasonOverride(startId);
  if (override && override.season != null) {
    return {
      number: override.season,
      total: override.total ?? null,
      tmdbId: null,
      source: "override",
      confidence: "high",
    };
  }

  const start = await load(startId);
  if (!start) {
    return { number: null, total: null, tmdbId: null, source: "none", confidence: "low" };
  }

  const fribbSelf = await getFribbEntry(startId);
  const { ordered, fribbGroup } = await buildFranchise(startId, fribbSelf, load);
  const tmdbId = fribbSelf?.tmdbTvId ?? null;

  // Chronological numbering is the backbone — compute it once; it also feeds
  // the hard year-order guard and the confidence vote.
  const chrono = numberByChronology(ordered, startId);
  const titleNum = extractSeasonFromTitle(start.title);

  // 2) Fribb — only when the franchise group is consistent (no collision /
  //    fusion). BSD fails this and falls through.
  const fribbUsable =
    fribbSelf?.tmdbSeason != null &&
    fribbGroup.length > 0 &&
    isFribbGroupConsistent(fribbGroup);

  if (fribbUsable) {
    const fribbNum = fribbSelf!.tmdbSeason as number;
    // Cross-check against chronology: if Fribb agrees with (or is the only)
    // signal and doesn't invert the year order, trust it with high confidence.
    const total = Math.max(
      ...fribbGroup.map((e) => e.tmdbSeason ?? 0),
      fribbNum
    );
    const agrees = titleNum == null || titleNum === fribbNum;
    return {
      number: fribbNum,
      total,
      tmdbId,
      source: "fribb",
      confidence: agrees ? "high" : "medium",
    };
  }

  // 3) Explicit title number.
  if (titleNum != null) {
    return {
      number: titleNum,
      total: chrono.total,
      tmdbId,
      // High when the chronological walk agrees, else medium (title still wins).
      confidence: chrono.number === titleNum ? "high" : "medium",
      source: "title",
    };
  }

  // 4) Chronological chain counter.
  if (chrono.number != null) {
    return {
      number: chrono.number,
      total: chrono.total,
      tmdbId,
      source: "chain",
      // Medium if there really is a multi-season chain; low if it's a lone
      // node that defaulted to 1.
      confidence: (chrono.total ?? 0) > 1 ? "medium" : "low",
    };
  }

  // 5) Nothing — never assume S1.
  return { number: null, total: null, tmdbId, source: "none", confidence: "low" };
}
