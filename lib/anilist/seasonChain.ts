import { getMediaMeta } from "./getMediaMeta";
import {
  resolveSeasonNumber,
  resolveFranchiseSeasons,
  resolveFranchiseBonusFilms,
  findFilmVariants,
  type FilmVariant,
} from "./resolveSeason";
import { seasonCacheGet, seasonCacheSet } from "@/lib/db/seasonCache";
import {
  computeSeasonInfo,
  extractSeasonFromTitle,
  isSeasonContinuation,
  continuesSameWork,
  isSeasonLike,
  sharesFranchise,
  SeasonInfo,
} from "@/components/anime/v2/helpers";
import {
  edgeYearMonotonic,
  isChainableRelation,
  isRecapTitle,
  yearOf,
} from "./seasonDetection";

/* Persistent (Turso) cache for the walker results. Each SSR of an info page
   used to trigger 10-30 getCachedAnime() calls (one per node in the relation
   chain × 2 for chain+list); caching the resolved output sidesteps the walk
   entirely on warm reads. 7-day TTL (enforced in lib/db/seasonCache.ts): the
   only thing that invalidates a season chain is AniList publishing a brand-new
   sequel, which is rare and tolerates a week of staleness.

   Was Redis — moved to Turso because a slow/unreachable Redis blocked the
   resolver ~90 s per request AND its stale values served the WRONG season. On
   Turso a miss/error just recomputes from AniList; it can never serve a wrong
   season. The cache_key strings keep their version tags (below) unchanged. */
// v2: numbering now goes through the multi-signal resolver (Fribb + air-year
//     arbitration + hardened walk) instead of the pure PREQUEL/SEQUEL count,
//     which mis-ordered remakes (Gundam Origin 2019 vs 1979).
// v3: meta-franchise guard — Gundam &co report {number:1,total:1} so the Hero
//     drops the "· S<n>" badge (was numbering unrelated works in one universe).
// v4: chained sequel films count as seasons (mirrors seasonList v9).
// v5: SIDE_STORY bonus films (HxH: Phantom Rouge) are excluded from season
//     numbering, so the "· S<n>" badge no longer over-counts them. Bumped to
//     drop pre-fix cached numbers (Phantom Rouge was cached as S2).
// v6: le numero d'une saison ne se lit plus dans un titre qui continue le
//     precedent (le titre natif de War of Underworld Part 2 dit "(2nd Season)",
//     ce qui ramenait le compteur de 4 a 2).
// v7: le film enchaine compte desormais comme une saison, donc le numero et
//     le total changent (Alicization passe de S3 a S4).
const REDIS_KEY_CHAIN = (id: number) => `seasonChain:v7:${id}`;
// v3: SeasonEntry gained `idMal` (feeds Jikan per-episode score lookups).
// v4: numbering now uses a running counter so split-cours + unnumbered
//     "Final Season" entries get the right S<n> (AoT Final Season = S4, not S5).
// v5: SeasonEntry gained `status` (flags not-yet-released seasons in the UI).
// v6: chain walk now applies the air-year monotonicity + relation-type guards
//     (drops ALTERNATIVE remakes) and sorts chronologically before numbering.
// v7: season list now comes from the unified resolver (resolveFranchiseSeasons)
//     — canonical (rebased on franchise root, same list from any page) and
//     TMDB-restricted (a remake no longer bleeds the original's timeline in),
//     plus deduped + numbered film variants.
// v8: meta-franchise guard (Gundam &co: 8+ tmdb.tv fiches → present the entry
//     standalone, no misleading "Season 1..N").
// v9: a chained sequel FILM now counts as a season (Chainsaw Man Reze = S2);
//     only compilation-film variants stay attached as format variants.
// v10: SIDE_STORY bonus films (HxH: Phantom Rouge, The Last Mission) are pulled
//      out of the season list into the separate Films dropdown. Bumped to evict
//      pre-fix cached lists that still numbered them as seasons.
// v11: SUMMARY recap films now attach as dual-format variants of their season
//      (Attack on Titan: The Roar of Awakening → S2); multi-season digests
//      (~Chronicle~) route to the bonus-films dropdown. Changes season variants.
// v12: SINGLE-season anime (One Piece) no longer attach arc-recap films as
//      per-season dual-format variants (no season split to host them) — those
//      recaps move to the Films panel's Compilations section. Changes variants.
// v13: whole-franchise digest MOVIE pages (Attack on Titan ~Chronicle~) re-anchor
//      to their franchise's oldest season, so the season list now resolves to the
//      real seasons instead of the lone movie. Changes the list for those ids.
// v14: PREQUEL movies (Jujutsu Kaisen 0) no longer counted as a numbered season
//      — they're bonus films now. Bump to evict lists that had them as "Season N".
// v15: meme correction que seasonChain v6 — "Season 2 Part 2" s'affichait
//      apres "Season 4" sur Sword Art Online.
// v16: une variante "film" d'une saison n'accepte plus que les aretes de
//      digest (SUMMARY, COMPILATION). ALTERNATIVE presentait Progressive -
//      Aria of a Starless Night comme "saison 1, en film" alors que c'est
//      une re-adaptation ; elle passe dans le panneau Films.
// v17: un film au milieu de la chaine n'est plus classe en film bonus. La
//      regle PREQUEL (pour Jujutsu Kaisen 0) sortait Ordinal Scale de la
//      chronologie, qui sautait de 2014 a 2018.
const REDIS_KEY_LIST = (id: number) => `seasonList:v17:${id}`;

// Cache accessors now hit Turso (see lib/db/seasonCache.ts) instead of Redis.
// The cache_key strings keep their version tag, so a version bump still evicts
// stale rows. A miss or DB error returns null → the caller recomputes from
// AniList, so a slow/unreachable store can never serve the WRONG season (the
// bug we're fixing) and never blocks the request for the Redis connect timeout.
async function cacheGetJson<T>(key: string): Promise<T | null> {
  return seasonCacheGet<T>(key);
}

async function cacheSetJson(key: string, value: unknown): Promise<void> {
  await seasonCacheSet(key, value);
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
  currentTitle?: any,
  currentNode?: any
): { node: any } | null {
  // Only PREQUEL/SEQUEL are chainable — ALTERNATIVE/PARENT link remakes /
  // versions (Gundam Origin ↔ 1979), which must never chain as seasons.
  // Air-year monotonicity rejects a mis-tagged edge that jumps the wrong way
  // in time (AniList tags the 1979 Gundam as a SEQUEL of the 2019 remake).
  const sameType = edges.filter(
    (e) =>
      e.relationType === relationType &&
      isChainableRelation(e.relationType) &&
      edgeYearMonotonic(relationType, currentNode, e.node)
  );
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
  const cached = await cacheGetJson<SeasonInfo>(REDIS_KEY_CHAIN(startId));
  if (cached) return cached;
  // Route through the multi-signal resolver (Fribb + air-year arbitration +
  // hardened walk). It returns richer data; we project it to SeasonInfo here.
  // Falls back to the legacy walk only if the resolver throws (e.g. Fribb DB
  // unreachable in a way getMediaMeta still tolerates).
  let result: SeasonInfo;
  try {
    const r = await resolveSeasonNumber(startId);
    result = { number: r.number, total: r.total };
  } catch {
    result = await resolveSeasonChainUncached(startId);
  }
  // Only cache positive resolutions to avoid pinning a "no info" answer
  // for 7 days when the underlying issue was a transient AniList blip.
  if (result.number != null) await cacheSetJson(REDIS_KEY_CHAIN(startId), result);
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
    const edge = pickEdge(media.relations?.edges || [], "PREQUEL", startTitle, media);
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
    const edge = pickEdge(media.relations?.edges || [], "SEQUEL", startTitle, media);
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
  /** MyAnimeList id for this season — used to fetch precise per-episode
   *  scores from Jikan (each AniList season maps 1:1 to its MAL entry). */
  idMal?: number | null;
  /** Position in the chain, 1-based. */
  number: number;
  /** Display label (e.g. "Season 2 Part 2"). */
  label: string;
  /** Air year if known — used as secondary line in the dropdown. */
  year: number | null;
  /** Total episodes if known. */
  episodes: number | null;
  /** AniList averageScore (0-100) for this season — drives the colour of
   *  the per-season score grid on the info page. Null when unscored. */
  averageScore?: number | null;
  /** AniList format, used to filter out movies / OVAs from the
   *  switcher (we only want TV-like seasons there). */
  format: string | null;
  /** AniList release status (FINISHED / RELEASING / NOT_YET_RELEASED / …).
   *  Lets the UI flag a season that hasn't aired yet instead of showing a
   *  bare "TV" with no year / episode count. */
  status?: string | null;
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
  /** Alternate FORMATS of this same season position (Part 4 — dual-format).
   *  A season that also exists as a compilation film (Demon Slayer S2) carries
   *  the film here so the picker can offer "Episodes" + "Film" side by side.
   *  Empty/absent when the season has only one format. Paired via Fribb TMDB
   *  ids (tv vs movie) + AniList COMPILATION/ALTERNATIVE relations. */
  variants?: Array<{
    id: number;
    format: string; // "MOVIE" | "TV" | …
    label?: string | null;
    year?: number | null;
    episodes?: number | null;
    /** 1-based film number within this season (Film 1 / Film 2) when the season
     *  has more than one compilation film; undefined for a lone film. */
    index?: number | null;
  }> | null;
};

/* Same walk as resolveSeasonChain but returns the ordered list of every
   season-like anime in the franchise (with id + label + air year).
   Powers the season picker in the Episodes tab so a viewer on Slime S1
   can jump straight to S2 or S2 Part 2. */
export async function resolveSeasonList(
  startId: number
): Promise<SeasonEntry[]> {
  const cached = await cacheGetJson<SeasonEntry[]>(REDIS_KEY_LIST(startId));
  if (cached) return cached;
  // Unified path: the season list now comes from the same franchise builder as
  // the season-number resolver (canonical + Fribb TMDB-restricted). Falls back
  // to the legacy walk only if the resolver throws.
  let result: SeasonEntry[];
  try {
    result = (await resolveFranchiseSeasons(startId)) as SeasonEntry[];
  } catch {
    result = await resolveSeasonListUncached(startId);
  }
  // Cache even empty arrays — an anime with no season siblings is a
  // stable fact; recomputing it every page render wastes the walk.
  await cacheSetJson(REDIS_KEY_LIST(startId), result);
  return result;
}

/* Franchise BONUS films (HxH: Phantom Rouge, The Last Mission) for the separate
   "Films" dropdown. Shares buildFranchise() with the season resolver, so it's
   cheap on top of the season list (same getMediaMeta cache). Cached alongside
   the list — an empty array (no bonus films: Demon Slayer, Chainsaw Man) is a
   stable fact and hides the second dropdown. */
// v2: FilmVariant enriched with duration / averageScore / coverImage for the
//     richer Films dropdown rows (cover + runtime).
// v3: multi-season SUMMARY digests (Attack on Titan ~Chronicle~) now join the
//     bonus-films list alongside SIDE_STORY films.
// v4: FilmVariant tagged with `kind` ("movie" | "compilation") and arc recap
//     films (SUMMARY/COMPILATION) now included so the UI can split them into a
//     "Compilations" section. Bump to drop pre-tag cached lists.
// v5: single-season recaps (Roar of Awakening → S2, One Piece Alabasta/Chopper)
//     are EXCLUDED from the panel — they belong to the season dropdown only, so
//     the Compilations section holds multi-season digests (~Chronicle~) alone.
//     Bump to evict v4 lists that double-listed single-season recaps.
// v6: SINGLE-season anime (One Piece) DO include their arc recaps here as
//     "compilation" (there's no season dropdown for them); multi-season keep the
//     season-dropdown-only rule. Bump to recompute with the season-count split.
// v7: digest-movie pages (Chronicle) re-anchor to their franchise, so the digest
//     now resolves as a bonus film on its OWN page (was empty). Changes those ids.
// v8: PREQUEL movies (Jujutsu Kaisen 0) are now surfaced as bonus films.
// v9: recompilation movies with a PARENT-to-TV edge (JJK: Execution) are
//     re-classified kind="compilation" so they land in the Compilations section.
const REDIS_KEY_FILMS = (id: number) => `bonusFilms:v9:${id}`;
export async function resolveBonusFilms(startId: number): Promise<FilmVariant[]> {
  const cached = await cacheGetJson<FilmVariant[]>(REDIS_KEY_FILMS(startId));
  if (cached) return cached;
  let result: FilmVariant[];
  try {
    result = await resolveFranchiseBonusFilms(startId);
  } catch {
    result = [];
  }
  await cacheSetJson(REDIS_KEY_FILMS(startId), result);
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
    const edge = pickEdge(media.relations?.edges || [], "PREQUEL", startTitle, media);
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
    const edge = pickEdge(media.relations?.edges || [], "SEQUEL", startTitle, media);
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

  // Only emit season-like nodes (TV/TV_SHORT/ONA) — drop OVA bridges and
  // recap/digest entries (which must never be a numbered season). Then SORT
  // chronologically by air year: a safety net so the displayed order can't
  // invert (S2 older than S1) even if a mis-tagged edge slipped through the
  // walk's year guard.
  const seasonLike = chainIds
    .map((id) => map.get(id))
    .filter((m) => m && isSeasonLike(m) && !isRecapTitle(m))
    .sort((a, b) => (yearOf(a) ?? Infinity) - (yearOf(b) ?? Infinity));

  // Number the chain with a running counter rather than the raw index. The
  // index over-counts whenever a season is split across multiple broadcast
  // runs: AoT's chain is [S1, S2, S3, S3 Part 2, The Final Season, …]. "S3
  // Part 2" must stay S3, and "The Final Season" — which carries no number in
  // its title — is the *next* distinct season (S4), not index+1 (S5).
  //
  // Rule per entry, walking chronologically:
  //   - explicit number in the title  → trust it; it anchors the counter.
  //   - "Part 2"/"Cour 2"/continuation → inherit the previous season's number.
  //   - otherwise (a fresh, unnumbered season like "The Final Season")
  //                                    → previous distinct season + 1.
  let running = 0;
  return seasonLike.map((m, i) => {
    const fromTitle = extractSeasonFromTitle(m.title);
    const continuation = isSeasonContinuation(m.title);
    // A number in the title anchors the counter only for a NEW work. When the
    // entry continues the previous one, that number counts within THAT work:
    // "War of Underworld Part 2" is titled "(2nd Season)" natively — the second
    // season of War of Underworld — and anchoring on it reset the franchise
    // counter from 4 to 2, listing "Season 2 Part 2" after "Season 4".
    const continuesPrev = i > 0 && continuesSameWork(seasonLike[i - 1]?.title, m.title);
    if (continuesPrev) {
      running = Math.max(1, running);
    } else if (fromTitle != null) {
      running = fromTitle;
    } else if (continuation) {
      running = Math.max(1, running); // inherit current season (don't bump)
    } else {
      running = running + 1; // a new, unnumbered season
    }
    const partMatch = String(
      m.title?.english || m.title?.romaji || ""
    ).match(/\b(?:Part|Cour)\s+(\d+|[IVX]+)\b/i);
    const part = partMatch ? ` Part ${partMatch[1].toUpperCase()}` : "";
    return {
      id: Number(m.id),
      idMal: m.idMal ?? null,
      number: running,
      label: `Season ${running}${part}`,
      year: m.seasonYear ?? m.startDate?.year ?? null,
      episodes: m.episodes ?? null,
      averageScore: m.averageScore ?? null,
      format: m.format ?? null,
      status: m.status ?? null,
      // Pulled from the same Media payload getMediaMeta already returned —
      // costs nothing extra but lets the Relations widget render full
      // poster cards without re-fetching per-id on the client.
      title: m.title || null,
      coverImage: m.coverImage || null,
      // Part 4 — dual-format: attach a compilation film of THIS season if one
      // exists. A recap movie that re-tells a season is linked on AniList via a
      // COMPILATION (or ALTERNATIVE) edge to a MOVIE node. We surface it so the
      // Episodes picker can offer "Episodes" + "Film" for the same slot. We do
      // NOT invent a pairing — only edges AniList actually asserts.
      variants: findFilmVariants(m),
    };
  });
}

