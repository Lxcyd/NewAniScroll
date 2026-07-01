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
   number assigned to `startId` and the count of real seasons. A chained sequel
   film counts as a season (S2); compilation-film variants do not. Must mirror
   the same filter as resolveFranchiseSeasons. */
function numberByChronology(
  ordered: SeasonNode[],
  startId: number
): { number: number | null; total: number | null } {
  const compilationFilmIds = new Set<number>();
  for (const m of ordered) {
    for (const v of findFilmVariants(m) ?? []) compilationFilmIds.add(v.id);
  }
  const seasons = ordered
    .filter(
      (m) =>
        !isRecapTitle(m) &&
        !compilationFilmIds.has(Number(m.id)) &&
        (isSeasonLike(m) || (m as any)?.format === "MOVIE") &&
        (!(m as any)?.type || (m as any).type === "ANIME")
    )
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

/** Walk PREQUEL as far back as possible from `startId` and return the id of the
 *  oldest ancestor reached (the franchise "root"). Makes the franchise build
 *  CANONICAL: whatever entry (S1, S2, a movie…) the user lands on, we rebase to
 *  the same root so the resulting season list is identical across pages. */
async function findRoot(
  startId: number,
  franchiseTitle: any,
  load: (id: number) => Promise<any | null>
): Promise<number> {
  const back = await walk(startId, "PREQUEL", franchiseTitle, load);
  if (back.length === 0) return startId;
  return Number(back[back.length - 1].id);
}

/** Build the franchise node list: union of the Fribb tmdb.tv group and the
 *  AniList PREQUEL/SEQUEL walk, ordered chronologically.
 *
 *  Two robustness passes on top of the raw walk:
 *   • CANONICAL — rebase to the franchise root (oldest ancestor) then walk
 *     forward, so the list doesn't depend on which page you started from.
 *   • TMDB-RESTRICTED — when Fribb is available and the group is consistent,
 *     drop any walked node that lives on a DIFFERENT tmdb.tv fiche. This is
 *     what pulls a remake out of the original's timeline (Gundam Origin, tmdb
 *     88865, no longer chains into the UC timeline tmdb 21731). Nodes with no
 *     Fribb entry are KEPT (we only drop nodes proven to be another fiche). */
async function buildFranchise(
  startId: number,
  fribbSelf: FribbEntry | null,
  load: (id: number) => Promise<any | null>
): Promise<{ ordered: SeasonNode[]; fribbGroup: FribbEntry[] }> {
  const start = await load(startId);
  const franchiseTitle = start?.title;

  // Rebase on the franchise root, then walk the whole thing forward from there.
  const rootId = await findRoot(startId, franchiseTitle, load);
  const rootMedia = (await load(rootId)) || start;
  const rootTitle = rootMedia?.title ?? franchiseTitle;
  const fwd = await walk(rootId, "SEQUEL", rootTitle, load);

  const byId = new Map<number, SeasonNode>();
  if (rootMedia) byId.set(rootId, rootMedia);
  for (const n of fwd) byId.set(Number(n.id), n);
  // Always keep the entry the user is actually on, even if the canonical walk
  // didn't reach it (e.g. a side movie hanging off the chain).
  if (start && !byId.has(startId)) byId.set(startId, start);

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

  // TMDB-RESTRICTED pass: drop walked nodes proven to sit on ANOTHER tmdb.tv
  // fiche than the start entry (remakes / alternate franchises). Only when
  // Fribb is trustworthy for this group.
  if (fribbSelf?.tmdbTvId && isFribbGroupConsistent(fribbGroup)) {
    const keepTv = fribbSelf.tmdbTvId;
    const entries = await Promise.all(
      Array.from(byId.keys()).map(async (id) => [id, await getFribbEntry(id)] as const)
    );
    for (const [id, fe] of entries) {
      if (id === startId) continue; // never drop the current entry
      if (fe?.tmdbTvId != null && fe.tmdbTvId !== keepTv) byId.delete(id);
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

  // Meta-franchise (Gundam &co) — not a season chain. Report a standalone entry
  // so the Hero label drops the misleading "· S3" badge (total <= 1), matching
  // the standalone season LIST returned by resolveFranchiseSeasons.
  if (await isMetaFranchise(ordered)) {
    return { number: 1, total: 1, tmdbId, source: "chain", confidence: "low" };
  }

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

// ── Franchise season LIST (feeds the Episodes selector + relations map) ───────

/** MOVIE nodes AniList links to a season as a COMPILATION / alternate version
 *  of the SAME content (the arc re-released as a film — Demon Slayer's Mugen
 *  Train). This is the only "dual-format" case: same story, two formats. A
 *  SEQUEL/PREQUEL film is NEW content (Chainsaw Man: Reze-hen) — it is NOT a
 *  format variant of this season and is deliberately excluded. Deduped by id
 *  and numbered (1-based) when a season has >1 film → "Film 1" / "Film 2".
 *  Returns null when none (undefined breaks SSR serialization). Kept here (not
 *  seasonChain.ts) to avoid an import cycle. */
export function findFilmVariants(media: any): FilmVariant[] | null {
  const edges = media?.relations?.edges || [];
  const seen = new Set<number>();
  const films = edges
    .filter(
      (e: any) =>
        (e.relationType === "COMPILATION" ||
          e.relationType === "ALTERNATIVE" ||
          e.relationType === "PARENT") &&
        e.node?.type === "ANIME" &&
        e.node?.format === "MOVIE" &&
        sharesFranchise(media?.title, e.node?.title)
    )
    .filter((e: any) => {
      const id = Number(e.node.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort(
      (a: any, b: any) =>
        (a.node.seasonYear ?? a.node.startDate?.year ?? Infinity) -
        (b.node.seasonYear ?? b.node.startDate?.year ?? Infinity)
    );
  if (films.length === 0) return null;
  const multiple = films.length > 1;
  return films.map((e: any, i: number) => ({
    id: Number(e.node.id),
    format: "MOVIE",
    label: e.node.title?.english || e.node.title?.romaji || null,
    year: e.node.seasonYear ?? e.node.startDate?.year ?? null,
    episodes: e.node.episodes ?? null,
    index: multiple ? i + 1 : null,
  }));
}

export interface FilmVariant {
  id: number;
  format: string;
  label?: string | null;
  year?: number | null;
  episodes?: number | null;
  index?: number | null;
}

export interface FranchiseSeasonEntry {
  id: number;
  idMal: number | null;
  number: number;
  label: string;
  year: number | null;
  episodes: number | null;
  averageScore: number | null;
  format: string | null;
  status: string | null;
  title: any;
  coverImage: any;
  variants: FilmVariant[] | null;
}

/** Video formats that count toward "is this one continuous show?". Manga /
 *  novels / one-shots are ignored — a franchise can spawn dozens of them
 *  without being multi-season. */
const VIDEO_FORMATS = new Set(["TV", "TV_SHORT", "ONA", "OVA", "MOVIE", "SPECIAL"]);

/**
 * Is this a META-FRANCHISE (many independent works in one universe: Gundam,
 * Fate, Precure) rather than a single show with sequential seasons (SNK,
 * Demon Slayer, Chainsaw Man)?
 *
 * Measured on real data: SNK / Demon Slayer / Chainsaw Man each map their whole
 * TV chain to ONE tmdb.tv fiche; Gundam spreads across 8–9 distinct tmdb.tv
 * fiches. So: count the DISTINCT tmdb.tv fiches among the franchise's video
 * nodes. ≥2 → not a season chain. When Fribb is unavailable we can't decide,
 * so we default to false (behave as a normal season chain).
 */
async function isMetaFranchise(nodes: SeasonNode[]): Promise<boolean> {
  const videoIds = nodes
    .filter((m) => VIDEO_FORMATS.has(String(m.format)))
    .map((m) => Number(m.id));
  if (videoIds.length <= 1) return false;
  const tvFiches = new Set<number>();
  let sawFribb = false;
  for (const id of videoIds) {
    const fe = await getFribbEntry(id);
    if (fe?.tmdbTvId != null) {
      sawFribb = true;
      tvFiches.add(fe.tmdbTvId);
    }
  }
  // Only trust the verdict when Fribb actually covered the franchise.
  if (!sawFribb) return false;
  return tvFiches.size >= 2;
}

/**
 * Canonical, franchise-restricted season LIST for the Episodes selector and the
 * relations map. Uses the SAME buildFranchise() as the number resolver — so the
 * selector can't disagree with the info-page label, and a remake (Gundam
 * Origin) no longer bleeds the original's timeline into the dropdown.
 *
 * Numbering mirrors the legacy running-counter rule (explicit title number
 * anchors; "Part 2"/continuation inherits; otherwise +1), applied over the
 * chronologically-ordered season-like nodes.
 *
 * META-FRANCHISE guard: if the franchise is really many independent works in a
 * shared universe (Gundam — 8+ tmdb.tv fiches), we DON'T present it as seasons.
 * We return just the current entry (autonomous, like a standalone anime) with
 * its own films attached — the other works stay reachable via the relations map.
 */
export async function resolveFranchiseSeasons(
  startId: number
): Promise<FranchiseSeasonEntry[]> {
  const cache = new Map<number, any>();
  const load = async (id: number): Promise<any | null> => {
    if (cache.has(id)) return cache.get(id);
    const m = await getMediaMeta(id);
    if (m) cache.set(id, m);
    return m;
  };

  const start = await load(startId);
  if (!start) return [];

  const fribbSelf = await getFribbEntry(startId);
  const { ordered } = await buildFranchise(startId, fribbSelf, load);

  // Meta-franchise (Gundam &co): present the current entry on its own, with its
  // films attached — no misleading "Season 1..N" over unrelated works.
  if (await isMetaFranchise(ordered)) {
    return [toSeasonEntry(start, 1)];
  }

  // A chained sequel FILM (Chainsaw Man: Reze-hen) is new content that follows
  // a TV season — treat it as a full SEASON of its own (S2), numbered in the
  // chronology. Neither AniList nor Fribb distinguishes it from a compilation
  // film reliably, so we don't try: the only films we DON'T count as seasons
  // are compilation variants (same content re-cut, matched via findFilmVariants
  // = COMPILATION/ALTERNATIVE/PARENT), which stay attached as format variants.
  const compilationFilmIds = new Set<number>();
  for (const m of ordered) {
    for (const v of findFilmVariants(m) ?? []) compilationFilmIds.add(v.id);
  }

  const seasonLike = ordered
    .filter(
      (m) =>
        !isRecapTitle(m) &&
        !compilationFilmIds.has(Number(m.id)) &&
        (isSeasonLike(m) || m?.format === "MOVIE") &&
        (!m?.type || m.type === "ANIME")
    )
    .sort((a, b) => (yearOf(a) ?? Infinity) - (yearOf(b) ?? Infinity));
  if (seasonLike.length === 0) return [];

  let running = 0;
  return seasonLike.map((m: any) => {
    const fromTitle = extractSeasonFromTitle(m.title);
    if (fromTitle != null) running = fromTitle;
    else if (isSeasonContinuation(m.title)) running = Math.max(1, running);
    else running = running + 1;
    const partMatch = String(m.title?.english || m.title?.romaji || "").match(
      /\b(?:Part|Cour)\s+(\d+|[IVX]+)\b/i
    );
    const part = partMatch ? ` Part ${partMatch[1].toUpperCase()}` : "";
    return toSeasonEntry(m, running, `Season ${running}${part}`);
  });
}

/** Build one SeasonEntry from a media node. `label` defaults to "Season N";
 *  callers pass the anime's own title for a standalone/meta-franchise entry. */
function toSeasonEntry(
  m: any,
  number: number,
  label?: string
): FranchiseSeasonEntry {
  return {
    id: Number(m.id),
    idMal: m.idMal ?? null,
    number,
    label:
      label ?? m.title?.english ?? m.title?.romaji ?? `Season ${number}`,
    year: m.seasonYear ?? m.startDate?.year ?? null,
    episodes: m.episodes ?? null,
    averageScore: m.averageScore ?? null,
    format: m.format ?? null,
    status: m.status ?? null,
    title: m.title || null,
    coverImage: m.coverImage || null,
    variants: findFilmVariants(m),
  };
}
