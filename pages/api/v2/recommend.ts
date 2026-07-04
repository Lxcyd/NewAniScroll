import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";
import { redis } from "@/lib/redis";
import {
  buildProfile,
  scoreCandidate,
  diversify,
  topKeys,
  genreCombos,
} from "@/lib/recommend/engine";
import {
  fetchMetaByIds,
  fetchCandidatesByGenres,
  rootSeasonOf,
  MetaWithRelations,
} from "@/lib/recommend/fetchMeta";
import type {
  ListEntry,
  Recommendation,
  RecommendMode,
  TasteProfile,
} from "@/lib/recommend/types";

/**
 * POST /api/v2/recommend
 *
 * Body: { list: ListEntry[], mode: "all" | "planning", exclude?, round? }
 *   - list   : the caller's whole AniList list (from the client cache)
 *   - mode   : "all" = recommend anime NOT in the list; "planning" = re-rank
 *              the user's PLANNING entries by affinity (what to watch next).
 *
 * Returns the top recommendations (diversified) with structured reasons.
 *
 * Cost discipline (Vercel/Upstash/AniList):
 *   • The whole list is fetched with the LIGHT field-set, in PARALLEL batches.
 *   • The taste profile + franchise-exclusion set are derived once and cached in
 *     Redis keyed by the list signature (TTL 6h) so every reroll/regenerate of
 *     the same list skips that whole pass.
 *   • Heavy display fields (description/banner/recommendations) are fetched
 *     FULL only for the ~10 candidates we actually return.
 */

const RESULT_TTL_S = 15 * 60;
const PROFILE_TTL_S = 6 * 60 * 60; // taste profile is stable for the session
const TOP_N = 10;

const FRANCHISE_RELATIONS = new Set([
  "SEQUEL",
  "PREQUEL",
  "SIDE_STORY",
  "PARENT",
  "ALTERNATIVE",
  "ALTERNATIVE_VERSION",
  "SPIN_OFF",
  "SUMMARY",
  "FULL_STORY",
]);

function listSignature(list: ListEntry[]): string {
  // Only the fields that affect the result, sorted for stability.
  const sig = list
    .map((e) => `${e.mediaId}:${e.status}:${e.score ?? 0}:${e.repeat}`)
    .sort()
    .join("|");
  return crypto.createHash("sha1").update(sig).digest("hex").slice(0, 16);
}

/** The per-list groundwork shared by every reroll/regenerate of the same list:
 *  the taste profile, the franchise-exclusion id set, and the loved-anime
 *  community recommendation map. Cached in Redis so we build it once. */
type Groundwork = {
  profile: TasteProfile;
  excludedIds: number[];
  // candidate id → {hits, viaTitles} from AniList community recommendations
  community: Record<number, { hits: number; via: string[] }>;
};

async function buildGroundwork(list: ListEntry[]): Promise<Groundwork> {
  const inListIds = new Set(list.map((e) => e.mediaId));
  // LIGHT metadata for the WHOLE list (parallel batches) → profile + relations.
  const listMeta = await fetchMetaByIds(list.map((e) => e.mediaId), false);
  const profile = buildProfile(list, listMeta);

  // ── Franchise-exclusion set via transitive BFS over the relation graph. ──
  // AniList only links adjacent seasons (S1↔S2, S2↔S3); we walk to closure so a
  // 2-hop sequel (S3 of a watched S1) is still excluded. Most relations are
  // already in listMeta, so this rarely fetches anything extra.
  const excludedIds = new Set<number>(inListIds);
  const relCache = new Map<number, MetaWithRelations>(listMeta);
  let frontier = Array.from(inListIds);
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const missing = frontier.filter((id) => !relCache.has(id));
    if (missing.length) {
      const fetched = await fetchMetaByIds(missing, false);
      fetched.forEach((m, id) => relCache.set(id, m));
    }
    const next: number[] = [];
    for (const id of frontier) {
      const meta = relCache.get(id);
      if (!meta) continue;
      for (const rel of meta.relations || []) {
        if (!FRANCHISE_RELATIONS.has(rel.relationType)) continue;
        if (excludedIds.has(rel.id)) continue;
        excludedIds.add(rel.id);
        next.push(rel.id);
      }
    }
    frontier = next;
  }

  // ── Community recommendations from EVERY anime the user liked. ──
  // Not just score≥8: anything clearly above the user's mean, or rewatched,
  // contributes its AniList "if you liked this…" picks. Widening the seed set
  // is the single biggest lever on candidate quality, and it's free — the
  // recommendations already rode along in listMeta.
  const community: Record<number, { hits: number; via: string[] }> = {};
  for (const e of list) {
    const liked =
      (e.score ?? 0) >= Math.max(7.5, profile.meanScore + 0.5) || e.repeat > 0;
    if (!liked) continue;
    const meta = listMeta.get(e.mediaId);
    if (!meta) continue;
    const tt = meta.title.english || meta.title.romaji || meta.title.userPreferred;
    for (const recId of meta.recommendations) {
      if (excludedIds.has(recId)) continue;
      const slot = (community[recId] ??= { hits: 0, via: [] });
      slot.hits += 1;
      if (tt && slot.via.length < 2 && !slot.via.includes(tt)) slot.via.push(tt);
    }
  }

  return { profile, excludedIds: Array.from(excludedIds), community };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const list: ListEntry[] = Array.isArray(req.body?.list) ? req.body.list : [];
  const mode: RecommendMode = req.body?.mode === "planning" ? "planning" : "all";
  // ids the client has already been shown — excluded so "regenerate" returns
  // a fresh batch. `round` keys the cache so each regenerate is its own entry.
  const alreadyShown: number[] = Array.isArray(req.body?.exclude)
    ? req.body.exclude.filter((n: any) => Number.isFinite(n))
    : [];
  const round = Number.isFinite(req.body?.round) ? Number(req.body.round) : 0;

  if (list.length === 0) {
    return res.status(200).json({
      recommendations: [],
      profileSummary: { topGenres: [], topStudios: [], sampleSize: 0 },
      reason: "empty-list",
    });
  }

  const sig = listSignature(list);
  const shownSet = new Set<number>(alreadyShown);
  const resultKey = `recommend:v2:${mode}:${sig}:r${round}`;

  // Whole-result cache (per round) — instant rerolls/repeat opens.
  if (redis) {
    try {
      const cached = await redis.get(resultKey);
      if (cached) {
        res.setHeader("X-Cache", "HIT");
        return res.status(200).json(JSON.parse(cached));
      }
    } catch {
      /* fall through */
    }
  }

  // ── 1. Groundwork (profile + franchise set + community), cached per list ──
  const groundKey = `recommend:ground:v2:${sig}`;
  let ground: Groundwork | null = null;
  if (redis) {
    try {
      const cached = await redis.get(groundKey);
      if (cached) ground = JSON.parse(cached) as Groundwork;
    } catch {
      /* fall through */
    }
  }
  if (!ground) {
    ground = await buildGroundwork(list);
    if (redis) {
      try {
        await redis.set(groundKey, JSON.stringify(ground), "EX", PROFILE_TTL_S);
      } catch {
        /* non-fatal */
      }
    }
  }

  const { profile } = ground;
  const excludedIds = new Set<number>(ground.excludedIds);
  shownSet.forEach((id) => excludedIds.add(id));

  // ── 2. Candidate id generation (LIGHT — no display payload yet) ──
  // community map id → strength; lovedVia id → titles for the "because you loved"
  const communityHits = new Map<number, number>();
  const lovedVia = new Map<number, string[]>();
  let candidates = new Map<number, MetaWithRelations>();

  if (mode === "planning") {
    const planningIds = list
      .filter((e) => e.status === "PLANNING")
      .map((e) => e.mediaId);
    candidates = await fetchMetaByIds(planningIds, false);
  } else {
    // a) Collaborative — AniList community recommendations from loved anime.
    const collabIds: number[] = [];
    for (const [idStr, slot] of Object.entries(ground.community)) {
      const id = Number(idStr);
      if (excludedIds.has(id)) continue;
      communityHits.set(id, slot.hits);
      lovedVia.set(id, slot.via);
      collabIds.push(id);
    }

    // b) Content-based — targeted genre combos (ANDed) for on-taste candidates.
    const combos = genreCombos(profile.genres, 5);

    const [collabMeta, byGenre] = await Promise.all([
      fetchMetaByIds(collabIds, false),
      fetchCandidatesByGenres(combos),
    ]);

    collabMeta.forEach((m, id) => {
      if (isDiscoverable(m, excludedIds)) candidates.set(id, m);
    });
    for (const m of byGenre) {
      if (isDiscoverable(m, excludedIds)) candidates.set(m.id, m);
    }

    // ── Normalise every candidate to the FIRST season of its franchise. ──
    // Discover must present a never-seen anime by its entry point: if a source
    // surfaced "Gintama Season 2" we show Gintama (S1) instead. We walk PREQUEL/
    // PARENT to the root, carry the candidate's community signal onto the root,
    // and drop it if the root is itself excluded (already watched / wrong-format).
    const rootCache = new Map<number, MetaWithRelations>(candidates);
    const normalised = new Map<number, MetaWithRelations>();
    const entries = Array.from(candidates.entries());
    for (const [id, meta] of entries) {
      const rootId = await rootSeasonOf(id, rootCache);
      if (rootId !== id) {
        // Move the collaborative signal from the sequel onto the root season.
        if (communityHits.has(id)) {
          communityHits.set(rootId, (communityHits.get(rootId) ?? 0) + communityHits.get(id)!);
          communityHits.delete(id);
        }
        if (lovedVia.has(id) && !lovedVia.has(rootId)) {
          lovedVia.set(rootId, lovedVia.get(id)!);
        }
      }
      if (excludedIds.has(rootId)) continue; // S1 already in list/franchise → skip
      const rootMeta = rootCache.get(rootId) ?? meta;
      if (!isDiscoverable(rootMeta, excludedIds)) continue;
      normalised.set(rootId, rootMeta);
    }
    candidates = normalised;
  }

  // ── 3. Score every candidate ──
  const maxCommunity = Math.max(1, ...Array.from(communityHits.values()));
  const scored: Recommendation[] = [];
  Array.from(candidates.entries()).forEach(([id, meta]) => {
    if (mode === "all" && excludedIds.has(id)) return;
    if (shownSet.has(id)) return;
    scored.push(
      scoreCandidate(profile, meta, {
        communityStrength: (communityHits.get(id) ?? 0) / maxCommunity,
        lovedSimilarTitles: lovedVia.get(id),
      }),
    );
  });

  // ── 4. Diversify + trim, THEN hydrate only the survivors with FULL fields ──
  const picked = diversify(scored, TOP_N);
  const recommendations = await hydrate(picked);

  const payload = {
    recommendations,
    profileSummary: {
      topGenres: topKeys(profile.genres, 3),
      topStudios: topKeys(profile.studios, 2),
      sampleSize: profile.sampleSize,
    },
  };

  if (redis && recommendations.length > 0) {
    try {
      await redis.set(resultKey, JSON.stringify(payload), "EX", RESULT_TTL_S);
    } catch {
      /* non-fatal */
    }
  }

  res.setHeader("X-Cache", "MISS");
  return res.status(200).json(payload);
}

/** A candidate is discoverable if it isn't excluded and none of its own
 *  franchise relations point back to anything excluded (catches one-sided
 *  AniList links). */
function isDiscoverable(m: MetaWithRelations, excludedIds: Set<number>): boolean {
  return (
    !excludedIds.has(m.id) &&
    !(m.relations || []).some(
      (r) => FRANCHISE_RELATIONS.has(r.relationType) && excludedIds.has(r.id),
    )
  );
}

/** Hydrate the final picks with FULL display fields (description, banner,
 *  community recommendations) in one parallel batch — the only heavy fetch, and
 *  only for what we actually show. Keeps the engine's score/reasons intact. */
async function hydrate(picks: Recommendation[]): Promise<Recommendation[]> {
  if (!picks.length) return picks;
  const full = await fetchMetaByIds(
    picks.map((p) => p.anime.id),
    true,
  );
  return picks.map((p) => {
    const rich = full.get(p.anime.id);
    return rich ? { ...p, anime: { ...rich } } : p;
  });
}
