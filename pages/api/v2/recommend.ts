import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";
import { redis } from "@/lib/redis";
import {
  buildProfile,
  scoreCandidate,
  diversify,
  topKeys,
} from "@/lib/recommend/engine";
import {
  fetchMetaByIds,
  fetchCandidatesByGenres,
  MetaWithRelations,
} from "@/lib/recommend/fetchMeta";
import type { ListEntry, Recommendation, RecommendMode } from "@/lib/recommend/types";

/**
 * POST /api/v2/recommend
 *
 * Body: { list: ListEntry[], mode: "all" | "planning" }
 *   - list   : the caller's whole AniList list (from the client cache)
 *   - mode   : "all" = recommend anime NOT in the list; "planning" = re-rank
 *              the user's PLANNING entries by affinity (what to watch next).
 *
 * Returns the top recommendations (diversified) with structured reasons.
 * Cached in Redis keyed by a hash of (list signature + mode) so rerolls and
 * repeat visits are instant; the per-anime metadata fetches are themselves
 * shared-cached by anilistFetch.
 */

const RESULT_TTL_S = 15 * 60;
const TOP_N = 10;

function listSignature(list: ListEntry[]): string {
  // Only the fields that affect the result, sorted for stability.
  const sig = list
    .map((e) => `${e.mediaId}:${e.status}:${e.score ?? 0}:${e.repeat}`)
    .sort()
    .join("|");
  return crypto.createHash("sha1").update(sig).digest("hex").slice(0, 16);
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

  const shownSet = new Set<number>(alreadyShown);
  const cacheKey = `recommend:v1:${mode}:${listSignature(list)}:r${round}`;
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        res.setHeader("X-Cache", "HIT");
        return res.status(200).json(JSON.parse(cached));
      }
    } catch {
      /* fall through */
    }
  }

  // ── 1. Metadata for the user's watched anime → taste profile ──
  const watchedIds = list
    .filter(
      (e) =>
        e.status === "COMPLETED" ||
        e.status === "CURRENT" ||
        e.status === "REPEATING" ||
        e.status === "DROPPED",
    )
    .map((e) => e.mediaId);

  const watchedMeta = await fetchMetaByIds(watchedIds);
  const profile = buildProfile(list, watchedMeta);

  // Loved anime (high affinity) drive candidate generation + "because you loved"
  const loved = list
    .filter((e) => (e.score ?? 0) >= 8 || e.repeat > 0)
    .map((e) => ({ entry: e, meta: watchedMeta.get(e.mediaId) }))
    .filter((x) => x.meta) as { entry: ListEntry; meta: MetaWithRelations }[];

  const inListIds = new Set(list.map((e) => e.mediaId));

  // ── Franchise-exclusion set (Discover mode) ──
  // "Discover" must surface genuinely NEW stories — never something already in
  // the list, nor a sequel / prequel / side-story / alt version of anything the
  // user has watched. We build that set from the watched anime's relations.
  // These relation types tie a candidate to a story the user already knows.
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
  const excludedIds = new Set<number>(inListIds);
  // Anything already shown in a previous batch is excluded too, so a
  // "regenerate" call returns a genuinely fresh set.
  shownSet.forEach((id) => excludedIds.add(id));
  for (const e of list) {
    const meta = watchedMeta.get(e.mediaId);
    if (!meta) continue;
    for (const rel of meta.relations || []) {
      if (FRANCHISE_RELATIONS.has(rel.relationType)) excludedIds.add(rel.id);
    }
  }
  const isDiscoverable = (m: MetaWithRelations) =>
    !excludedIds.has(m.id) &&
    // A standalone series, not a continuation: drop entries whose own relations
    // point back to something the user has watched (catches sequels we didn't
    // see in the watched anime's own relation list).
    !(m.relations || []).some(
      (r) => FRANCHISE_RELATIONS.has(r.relationType) && inListIds.has(r.id),
    );

  // ── 2. Candidate generation ──
  let candidates = new Map<number, MetaWithRelations>();
  // community strength: how many loved anime recommend this candidate
  const communityHits = new Map<number, number>();
  // loved-similar: candidate id → titles of loved anime that led to it
  const lovedVia = new Map<number, string[]>();

  if (mode === "planning") {
    // Re-rank the user's PLANNING entries: candidates = planning metadata.
    const planningIds = list
      .filter((e) => e.status === "PLANNING")
      .map((e) => e.mediaId);
    candidates = await fetchMetaByIds(planningIds);
  } else {
    // a) Collaborative: AniList recommendations from loved anime (no sequels —
    //    those are continuations, not discoveries).
    for (const { meta } of loved) {
      for (const recId of meta.recommendations) {
        if (excludedIds.has(recId)) continue;
        communityHits.set(recId, (communityHits.get(recId) ?? 0) + 1);
        if (!lovedVia.has(recId)) lovedVia.set(recId, []);
        const titles = lovedVia.get(recId)!;
        const tt = meta.title.english || meta.title.romaji || meta.title.userPreferred;
        if (tt && titles.length < 2 && !titles.includes(tt)) titles.push(tt);
      }
    }

    const collabIds = Array.from(communityHits.keys());
    const collabMeta = await fetchMetaByIds(collabIds);
    collabMeta.forEach((m, id) => {
      if (isDiscoverable(m)) candidates.set(id, m);
    });

    // b) Content-based: highly-rated anime in the user's top genres.
    const topGenres = topKeys(profile.genres, 4);
    const byGenre = await fetchCandidatesByGenres(topGenres);
    for (const m of byGenre) {
      if (isDiscoverable(m)) candidates.set(m.id, m);
    }
  }

  // ── 3. Score every candidate ──
  const maxCommunity = Math.max(1, ...Array.from(communityHits.values()));
  const scored: Recommendation[] = [];
  Array.from(candidates.entries()).forEach(([id, meta]) => {
    // Discover mode: never score anything in the list or in a watched franchise.
    if (mode === "all" && excludedIds.has(id)) return;
    // Both modes: skip anything already shown in a previous batch (regenerate).
    if (shownSet.has(id)) return;
    const rec = scoreCandidate(profile, meta, {
      communityStrength: (communityHits.get(id) ?? 0) / maxCommunity,
      lovedSimilarTitles: lovedVia.get(id),
    });
    scored.push(rec);
  });

  // ── 4. Diversify + trim ──
  const recommendations = diversify(scored, TOP_N);

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
      await redis.set(cacheKey, JSON.stringify(payload), "EX", RESULT_TTL_S);
    } catch {
      /* non-fatal */
    }
  }

  res.setHeader("X-Cache", "MISS");
  return res.status(200).json(payload);
}
