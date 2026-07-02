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
  // Exclude the same films the season LIST excludes so the season NUMBER badge
  // can't disagree with it: compilation variants (Mugen Train) AND bonus/
  // SIDE_STORY films (HxH: Phantom Rouge). Must mirror resolveFranchiseSeasons.
  const excludedFilmIds = new Set<number>();
  for (const m of ordered) {
    for (const v of findFilmVariants(m) ?? []) excludedFilmIds.add(v.id);
  }
  for (const f of findBonusFilms(ordered)) excludedFilmIds.add(f.id);
  const seasons = ordered
    .filter(
      (m) =>
        !isRecapTitle(m) &&
        !excludedFilmIds.has(Number(m.id)) &&
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
export function findFilmVariants(
  media: any,
  excludeIds?: Set<number>
): FilmVariant[] | null {
  const edges = media?.relations?.edges || [];
  const seen = new Set<number>();
  const films = edges
    .filter(
      (e: any) =>
        !(excludeIds && excludeIds.has(Number(e.node?.id))) &&
        // SUMMARY = an AniList recap-film edge (Attack on Titan: The Roar of
        // Awakening recaps S2). It's the same content as the season re-cut into a
        // film — exactly a dual-format variant — but was previously matched by no
        // helper, so recap films silently vanished. A whole-franchise digest
        // (~Chronicle~, SUMMARY of 4 seasons) is filtered out downstream by the
        // multi-season guard in resolveFranchiseSeasons and shown as a bonus film.
        (e.relationType === "COMPILATION" ||
          e.relationType === "ALTERNATIVE" ||
          e.relationType === "PARENT" ||
          e.relationType === "SUMMARY") &&
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
  /** What KIND of film this is, so the UI can group them:
   *  - "movie"       — a genuine standalone film (AniList SIDE_STORY): original
   *                    story, not a re-cut of episodes.
   *  - "compilation" — a recap MOVIE of an arc / season (AniList
   *                    SUMMARY / COMPILATION): condenses existing episodes.
   *  Absent on per-season dual-format variants (findFilmVariants), which are
   *  already contextually "the film of THIS season". */
  kind?: "movie" | "compilation";
  label?: string | null;
  year?: number | null;
  episodes?: number | null;
  index?: number | null;
  /** Runtime (minutes) — shown in the Films dropdown. Enriched for bonus films
   *  (resolveFranchiseBonusFilms); absent for season dual-format variants. */
  duration?: number | null;
  /** AniList averageScore (0-100), for the film row. */
  averageScore?: number | null;
  /** Cover art URLs for the film row thumbnail. */
  coverImage?: { extraLarge?: string | null; large?: string | null } | null;
}

/** Franchise-level BONUS films — original side films that are NOT a season and
 *  NOT a re-cut of one (so not a dual-format variant either). AniList links them
 *  to the main series as SIDE_STORY MOVIE edges (Hunter × Hunter: Phantom Rouge,
 *  The Last Mission). We collect them across every franchise node, dedupe, and
 *  order chronologically so the UI can offer a SEPARATE "Films" dropdown.
 *
 *  Deliberately NOT SEQUEL (a sequel film is new canonical content = its own
 *  season, e.g. Chainsaw Man: Reze-hen) and NOT COMPILATION/ALTERNATIVE/PARENT
 *  (those are dual-format re-cuts, handled by findFilmVariants). Returns [] when
 *  none — callers spread it, so an empty array is the natural "no films" signal. */
export function findBonusFilms(nodes: any[]): FilmVariant[] {
  const seen = new Set<number>();
  const films: any[] = [];
  for (const m of nodes) {
    const franchiseTitle = m?.title;
    for (const e of m?.relations?.edges || []) {
      if (
        e.relationType === "SIDE_STORY" &&
        e.node?.type === "ANIME" &&
        e.node?.format === "MOVIE" &&
        sharesFranchise(franchiseTitle, e.node?.title)
      ) {
        const id = Number(e.node.id);
        if (seen.has(id)) continue;
        seen.add(id);
        films.push(e.node);
      }
    }
  }
  films.sort(
    (a, b) =>
      (a.seasonYear ?? a.startDate?.year ?? Infinity) -
      (b.seasonYear ?? b.startDate?.year ?? Infinity)
  );
  const multiple = films.length > 1;
  return films.map((n, i) => ({
    id: Number(n.id),
    format: "MOVIE",
    kind: "movie" as const, // SIDE_STORY = genuine standalone film
    label: n.title?.english || n.title?.romaji || null,
    year: n.seasonYear ?? n.startDate?.year ?? null,
    episodes: n.episodes ?? null,
    index: multiple ? i + 1 : null,
    // coverImage rides along on the relation node (fullMediaQuery selects it);
    // duration/year/score are NOT on the edge — resolveFranchiseBonusFilms
    // enriches those from each film's own meta.
    coverImage: n.coverImage
      ? { extraLarge: n.coverImage.extraLarge ?? null, large: n.coverImage.large ?? null }
      : null,
  }));
}

/** Arc-recap films: MOVIEs that condense part of the series (AniList SUMMARY or
 *  COMPILATION edges), e.g. One Piece's "…Alabasta" / "Episode of Chopper" arc
 *  digests. Only used for SINGLE-season anime (One Piece), where there's no
 *  per-season dropdown for them to live in — so they surface in the Films panel's
 *  "Compilations" section. Multi-season franchises route their single-season
 *  recaps to the season dropdown instead (see resolveFranchiseBonusFilms).
 *  `excludeIds` drops any film already classified as a standalone / digest. */
export function findRecapFilms(
  nodes: any[],
  excludeIds?: Set<number>
): FilmVariant[] {
  const RECAP_TYPES = new Set(["SUMMARY", "COMPILATION"]);
  const seen = new Set<number>();
  const films: any[] = [];
  for (const m of nodes) {
    const franchiseTitle = m?.title;
    for (const e of m?.relations?.edges || []) {
      if (
        RECAP_TYPES.has(e.relationType) &&
        e.node?.type === "ANIME" &&
        e.node?.format === "MOVIE" &&
        sharesFranchise(franchiseTitle, e.node?.title)
      ) {
        const id = Number(e.node.id);
        if (seen.has(id) || excludeIds?.has(id)) continue;
        seen.add(id);
        films.push(e.node);
      }
    }
  }
  films.sort(
    (a, b) =>
      (a.seasonYear ?? a.startDate?.year ?? Infinity) -
      (b.seasonYear ?? b.startDate?.year ?? Infinity)
  );
  const multiple = films.length > 1;
  return films.map((n, i) => ({
    id: Number(n.id),
    format: "MOVIE",
    kind: "compilation" as const,
    label: n.title?.english || n.title?.romaji || null,
    year: n.seasonYear ?? n.startDate?.year ?? null,
    episodes: n.episodes ?? null,
    index: multiple ? i + 1 : null,
    coverImage: n.coverImage
      ? { extraLarge: n.coverImage.extraLarge ?? null, large: n.coverImage.large ?? null }
      : null,
  }));
}

/** Whole-franchise digest films: a recap MOVIE that AniList links (SUMMARY /
 *  COMPILATION) to MORE THAN ONE season of the franchise (Attack on Titan
 *  ~Chronicle~ recaps S1..S3P2). Attaching it to every season would clutter each
 *  season's Films toggle, so it belongs in the separate bonus-films dropdown.
 *  We count, across all franchise nodes, how many DISTINCT season nodes reference
 *  each recap film; those referenced by ≥2 are digests. */
export function findMultiSeasonDigestFilms(nodes: any[]): FilmVariant[] {
  const refCount = new Map<number, number>();
  const nodeById = new Map<number, any>();
  const RECAP_TYPES = new Set(["SUMMARY", "COMPILATION"]);
  for (const m of nodes) {
    // Only genuine TV seasons count as "referencing" nodes (not the films
    // themselves), so a film's own back-edges don't inflate the count.
    if (!isSeasonLike(m)) continue;
    const franchiseTitle = m?.title;
    const seenHere = new Set<number>();
    for (const e of m?.relations?.edges || []) {
      if (
        RECAP_TYPES.has(e.relationType) &&
        e.node?.type === "ANIME" &&
        e.node?.format === "MOVIE" &&
        sharesFranchise(franchiseTitle, e.node?.title)
      ) {
        const id = Number(e.node.id);
        if (seenHere.has(id)) continue;
        seenHere.add(id);
        refCount.set(id, (refCount.get(id) ?? 0) + 1);
        nodeById.set(id, e.node);
      }
    }
  }
  const digests = Array.from(refCount.entries())
    .filter(([, n]) => n >= 2)
    .map(([id]) => nodeById.get(id))
    .sort(
      (a, b) =>
        (a.seasonYear ?? a.startDate?.year ?? Infinity) -
        (b.seasonYear ?? b.startDate?.year ?? Infinity)
    );
  const multiple = digests.length > 1;
  return digests.map((n, i) => ({
    id: Number(n.id),
    format: "MOVIE",
    kind: "compilation" as const, // whole-franchise recap = a compilation too
    label: n.title?.english || n.title?.romaji || null,
    year: n.seasonYear ?? n.startDate?.year ?? null,
    episodes: n.episodes ?? null,
    index: multiple ? i + 1 : null,
    coverImage: n.coverImage
      ? { extraLarge: n.coverImage.extraLarge ?? null, large: n.coverImage.large ?? null }
      : null,
  }));
}

/** When the page's start node is a WHOLE-FRANCHISE digest MOVIE viewed on its
 *  own (Attack on Titan ~Chronicle~), it hangs off the franchise only via PARENT
 *  season edges — it has no PREQUEL/SEQUEL chain, so a walk from the movie
 *  collapses to just itself and the season dropdown vanishes. Re-anchor franchise
 *  resolution to the OLDEST parent season so the season list + bonus films come
 *  out against the real franchise (and the digest itself surfaces as a bonus
 *  film). Requires ≥2 season PARENTs so a normal movie sequel (one PARENT) or a
 *  single-season recap (Roar of Awakening → only S2) is left untouched. Returns
 *  the original id when no re-anchor applies. */
async function franchiseAnchorId(
  startId: number,
  load: (id: number) => Promise<any | null>,
  startMedia?: any
): Promise<number> {
  const start = startMedia ?? (await load(startId));
  if (!start || start.format !== "MOVIE") return startId;
  const parents = (start.relations?.edges || [])
    .filter(
      (e: any) =>
        e.relationType === "PARENT" &&
        e.node?.type === "ANIME" &&
        isSeasonLike(e.node) &&
        sharesFranchise(start.title, e.node?.title)
    )
    .map((e: any) => e.node);
  if (parents.length < 2) return startId;
  parents.sort(
    (a: any, b: any) => (yearOf(a) ?? Infinity) - (yearOf(b) ?? Infinity)
  );
  return Number(parents[0]?.id) || startId;
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

  const start0 = await load(startId);
  if (!start0) return [];

  // Digest-movie pages (Chronicle) re-anchor to their franchise's oldest season
  // so the season dropdown lists the real seasons instead of just the movie.
  const anchorId = await franchiseAnchorId(startId, load, start0);
  const start = anchorId === startId ? start0 : (await load(anchorId)) || start0;

  const fribbSelf = await getFribbEntry(anchorId);
  const { ordered } = await buildFranchise(anchorId, fribbSelf, load);

  // Meta-franchise (Gundam &co): present the current entry on its own, with its
  // films attached — no misleading "Season 1..N" over unrelated works.
  if (await isMetaFranchise(ordered)) {
    return [toSeasonEntry(start, 1)];
  }

  // A chained sequel FILM (Chainsaw Man: Reze-hen) is new content that follows
  // a TV season — treat it as a full SEASON of its own (S2), numbered in the
  // chronology. The films we DON'T count as seasons are:
  //   • compilation variants (same content re-cut — Demon Slayer's Mugen Train,
  //     matched via findFilmVariants = COMPILATION/ALTERNATIVE/PARENT), which
  //     stay attached to their season as a dual-format option; and
  //   • BONUS / SIDE_STORY films (HxH: Phantom Rouge, The Last Mission — an
  //     original side film, not a season), which are surfaced in a SEPARATE
  //     "Films" dropdown instead. The distinguishing signal is the relationType:
  //     SEQUEL → real season; SIDE_STORY → bonus film. Reze is a SEQUEL so it
  //     stays S2; Phantom Rouge is a SIDE_STORY so it drops out of the count.
  const excludedFilmIds = new Set<number>();
  for (const m of ordered) {
    for (const v of findFilmVariants(m) ?? []) excludedFilmIds.add(v.id);
  }
  for (const f of findBonusFilms(ordered)) excludedFilmIds.add(f.id);

  const seasonLike = ordered
    .filter(
      (m) =>
        !isRecapTitle(m) &&
        !excludedFilmIds.has(Number(m.id)) &&
        (isSeasonLike(m) || m?.format === "MOVIE") &&
        (!m?.type || m.type === "ANIME")
    )
    .sort((a, b) => (yearOf(a) ?? Infinity) - (yearOf(b) ?? Infinity));
  if (seasonLike.length === 0) return [];

  // A recap film that variants MULTIPLE seasons (Attack on Titan ~Chronicle~ is
  // a SUMMARY of S1..S3P2) is a whole-franchise digest, not a variant of one
  // season — attaching it to every season would clutter each dropdown. Detect
  // those (appear as a variant on ≥2 seasons) and drop them from the per-season
  // variants; they surface in the bonus-films dropdown instead.
  const variantSeasonCount = new Map<number, number>();
  for (const m of seasonLike) {
    for (const v of findFilmVariants(m) ?? []) {
      variantSeasonCount.set(v.id, (variantSeasonCount.get(v.id) ?? 0) + 1);
    }
  }
  const multiSeasonFilmIds = new Set<number>();
  variantSeasonCount.forEach((n, id) => {
    if (n >= 2) multiSeasonFilmIds.add(id);
  });

  // A SINGLE-season anime (One Piece — one continuous TV node) isn't "split into
  // seasons", so a per-season "Watch in: Episodes / Films" dropdown makes no
  // sense: its arc-recap films belong in the Films panel's Compilations section
  // instead (see resolveFranchiseBonusFilms). Suppress the dual-format variants
  // here so the same recap isn't offered in two places. Multi-season franchises
  // keep their per-season recap (Roar of Awakening on SnK S2) as before.
  const singleSeason = seasonLike.length === 1;
  let excludeVariantIds = multiSeasonFilmIds;
  if (singleSeason) {
    excludeVariantIds = new Set<number>(multiSeasonFilmIds);
    for (const v of findFilmVariants(seasonLike[0]) ?? []) {
      excludeVariantIds.add(v.id);
    }
  }

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
    return toSeasonEntry(m, running, `Season ${running}${part}`, excludeVariantIds);
  });
}

/**
 * Franchise BONUS films for the separate "Films" dropdown (Hunter × Hunter:
 * Phantom Rouge + The Last Mission). Uses the SAME buildFranchise() as the
 * season resolver so the film list is canonical and franchise-restricted (a
 * remake's side films don't bleed in). Returns [] when the franchise has no
 * bonus films — the UI hides the second dropdown in that case (Demon Slayer,
 * Chainsaw Man). These are the SIDE_STORY movies excluded from season numbering.
 */
export async function resolveFranchiseBonusFilms(
  startId: number
): Promise<FilmVariant[]> {
  const cache = new Map<number, any>();
  const load = async (id: number): Promise<any | null> => {
    if (cache.has(id)) return cache.get(id);
    const m = await getMediaMeta(id);
    if (m) cache.set(id, m);
    return m;
  };
  const start0 = await load(startId);
  if (!start0) return [];
  // Re-anchor a whole-franchise digest movie (Chronicle) to its franchise so it
  // resolves against the real seasons — findMultiSeasonDigestFilms then re-adds
  // the digest itself as a bonus film (referenced by ≥2 seasons via SUMMARY).
  const anchorId = await franchiseAnchorId(startId, load, start0);
  const start = anchorId === startId ? start0 : (await load(anchorId)) || start0;
  const fribbSelf = await getFribbEntry(anchorId);
  const { ordered } = await buildFranchise(anchorId, fribbSelf, load);
  // Meta-franchise: the "season list" collapses to the lone entry, but its own
  // side films are still worth surfacing.
  const nodes = (await isMetaFranchise(ordered)) ? [start] : ordered;

  // How many REAL seasons does this franchise have? A single-continuous-anime
  // (One Piece — one long TV node) has 1; SnK / Demon Slayer have several. This
  // decides where arc-recap films belong (see below).
  const realSeasonCount = nodes.filter(
    (m) => !isRecapTitle(m) && isSeasonLike(m) && (!m?.type || m.type === "ANIME"),
  ).length;
  const multiSeason = realSeasonCount > 1;

  // Films panel content:
  //   • genuine standalone films — SIDE_STORY (findBonusFilms), kind "movie";
  //   • whole-franchise digests — a SUMMARY/COMPILATION recapping ≥2 seasons
  //     (Attack on Titan ~Chronicle~), kind "compilation".
  const movieish = findBonusFilms(nodes).concat(findMultiSeasonDigestFilms(nodes));

  // Arc-recap films (SUMMARY/COMPILATION of one season) are handled by season
  // count:
  //   • MULTI-season anime (SnK): a single-season recap (Roar of Awakening → S2)
  //     already appears as that season's dual-format variant in the season
  //     dropdown, so we KEEP it out of the panel to avoid duplicating it.
  //   • SINGLE-season anime (One Piece — not split into seasons): there is no
  //     per-season dropdown for it to live in, so its arc digests (Alabasta,
  //     Chopper) belong right here, in the "Compilations" section.
  let compilations: FilmVariant[] = [];
  if (!multiSeason) {
    const already = new Set(movieish.map((f) => f.id));
    compilations = findRecapFilms(nodes, already);
  }
  const merged = movieish.concat(compilations);
  const byId = new Map<number, FilmVariant>();
  for (const f of merged) if (!byId.has(f.id)) byId.set(f.id, f);
  // Sort by year, but keep genuine films before compilations so the panel's
  // primary content leads and recaps trail — the UI still renders them in two
  // labelled sections, this just makes an unsectioned consumer sane too.
  const films = Array.from(byId.values()).sort((a, b) => {
    const ka = a.kind === "compilation" ? 1 : 0;
    const kb = b.kind === "compilation" ? 1 : 0;
    if (ka !== kb) return ka - kb;
    return (a.year ?? Infinity) - (b.year ?? Infinity);
  });

  // Enrich each film with the fields the relation edge doesn't carry (duration,
  // air year, score) so the dropdown can show a rich row. Films are few (1-3)
  // and getMediaMeta is cached, so this is cheap. coverImage already came from
  // the edge; we only backfill missing pieces.
  return Promise.all(
    films.map(async (f) => {
      const m = await load(f.id);
      if (!m) return f;
      return {
        ...f,
        year: f.year ?? m.seasonYear ?? m.startDate?.year ?? null,
        episodes: f.episodes ?? m.episodes ?? null,
        duration: m.duration ?? null,
        averageScore: m.averageScore ?? null,
        coverImage:
          f.coverImage ||
          (m.coverImage
            ? { extraLarge: m.coverImage.extraLarge ?? null, large: m.coverImage.large ?? null }
            : null),
      };
    })
  );
}

/** Build one SeasonEntry from a media node. `label` defaults to "Season N";
 *  callers pass the anime's own title for a standalone/meta-franchise entry. */
function toSeasonEntry(
  m: any,
  number: number,
  label?: string,
  excludeFilmIds?: Set<number>
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
    variants: findFilmVariants(m, excludeFilmIds),
  };
}
