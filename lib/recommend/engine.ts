/**
 * "For You" recommendation engine — pure logic (no network), so it's testable
 * in isolation and runs the same server-side or in tests.
 *
 * Pipeline:
 *   1. buildProfile(list, metaById)  → a weighted taste vector
 *   2. scoreCandidate(profile, meta) → a 0..1-ish affinity score + reasons
 *   3. diversify(scored)             → MMR-style re-rank for variety
 *
 * Signals used: user score (loved/liked/disliked), repeats, watch SPEED
 * (binge vs slow), explicit DROPPED penalty. Aggregated over genres, tags
 * (rank-weighted), studios, format, decade.
 */

import type {
  AnimeMeta,
  ListEntry,
  Recommendation,
  RecReason,
  TasteProfile,
} from "./types";

// ── Tunable weights ─────────────────────────────────────────────────────────
const W = {
  // candidate scoring blend
  content: 0.5,
  community: 0.3,
  quality: 0.2,
  // affinity-from-score curve anchors (score 0..10 → affinity)
  // 10→+1.0, 8→+0.55, 7→+0.2, 5→0, ≤3→negative
  // dimension contributions inside content similarity
  genre: 1.0,
  tag: 0.8,
  studio: 1.2,
  format: 0.4,
  decade: 0.3,
  // penalties
  dislikedGenre: 1.3,
  dislikedTag: 1.0,
  popularityMismatch: 0.5,
  // bonuses
  sequelBonus: 0.45,
  bingeBonus: 0.25,
} as const;

/** Map a user score (0–10) to a signed affinity in roughly [-0.8, +1.0]. */
function scoreToAffinity(score: number): number {
  if (score <= 0) return 0; // unscored
  if (score >= 9) return 1.0;
  if (score >= 8) return 0.65;
  if (score >= 7) return 0.35;
  if (score >= 6) return 0.12;
  if (score >= 5) return 0;
  if (score >= 4) return -0.25;
  if (score >= 3) return -0.5;
  return -0.8;
}

function toDate(d: ListEntry["startedAt"]): number | null {
  if (!d?.year) return null;
  return new Date(d.year, (d.month ?? 1) - 1, d.day ?? 1).getTime();
}

/** Watch-speed bonus: a fast binge (relative to episode count) signals strong
 *  engagement. Returns a small multiplier add-on in [0, 0.3]. */
function bingeBonus(entry: ListEntry, episodes: number | null): number {
  const s = toDate(entry.startedAt);
  const c = toDate(entry.completedAt);
  if (s == null || c == null || !episodes || episodes < 4) return 0;
  const days = Math.max(1, (c - s) / 86_400_000);
  const epsPerDay = episodes / days;
  // ≥2 eps/day ⇒ fast binge; scale up to +0.3.
  if (epsPerDay >= 2) return 0.3;
  if (epsPerDay >= 1) return 0.18;
  if (epsPerDay >= 0.5) return 0.08;
  return 0;
}

function decadeOf(year: number | null): string | null {
  if (!year) return null;
  return `${Math.floor(year / 10) * 10}s`;
}

function bump(map: Record<string, number>, key: string | null, by: number) {
  if (!key) return;
  map[key] = (map[key] ?? 0) + by;
}

/**
 * Build the user's taste profile from their list + metadata of watched anime.
 * Only COMPLETED / CURRENT / REPEATING / DROPPED entries contribute (PLANNING
 * isn't watched yet, PAUSED is ambiguous).
 */
export function buildProfile(
  list: ListEntry[],
  metaById: Map<number, AnimeMeta>,
): TasteProfile {
  const genres: Record<string, number> = {};
  const tags: Record<string, number> = {};
  const studios: Record<string, number> = {};
  const formats: Record<string, number> = {};
  const decades: Record<string, number> = {};

  let scoreSum = 0;
  let scoreCount = 0;
  let lovedPopSum = 0;
  let lovedPopCount = 0;
  let sampleSize = 0;

  for (const entry of list) {
    const meta = metaById.get(entry.mediaId);
    if (!meta) continue;
    const watched =
      entry.status === "COMPLETED" ||
      entry.status === "CURRENT" ||
      entry.status === "REPEATING" ||
      entry.status === "DROPPED";
    if (!watched) continue;

    let affinity = scoreToAffinity(entry.score ?? 0);

    // DROPPED with no/low score = explicit dislike even if unscored.
    if (entry.status === "DROPPED" && affinity >= 0) affinity = -0.35;
    // Rewatched = strong favourite signal.
    if (entry.repeat > 0) affinity += Math.min(0.4, entry.repeat * 0.2);
    // Fast binge bonus.
    affinity += bingeBonus(entry, meta.episodes);

    if (affinity === 0) continue;
    sampleSize++;

    if (entry.score && entry.score > 0) {
      scoreSum += entry.score;
      scoreCount++;
    }
    if (affinity > 0.5 && meta.popularity) {
      lovedPopSum += meta.popularity;
      lovedPopCount++;
    }

    for (const g of meta.genres) bump(genres, g, affinity * W.genre);
    for (const tg of meta.tags) {
      if (tg.isMediaSpoiler) continue;
      // rank 0..100 → weight 0..1
      bump(tags, tg.name, affinity * W.tag * (tg.rank / 100));
    }
    for (const st of meta.studios) bump(studios, st, affinity * W.studio);
    bump(formats, meta.format, affinity * W.format);
    bump(decades, decadeOf(meta.seasonYear), affinity * W.decade);
  }

  return {
    genres,
    tags,
    studios,
    formats,
    decades,
    meanScore: scoreCount ? scoreSum / scoreCount : 7,
    nicheLean: lovedPopCount ? lovedPopSum / lovedPopCount : 0,
    sampleSize,
  };
}

/** Cosine-like dot product of a candidate's dimension against the profile,
 *  normalised by the profile's magnitude so scores are comparable. */
function dimDot(
  profile: Record<string, number>,
  keys: string[],
  perKeyWeight?: (k: string) => number,
): { score: number; matched: string[] } {
  let dot = 0;
  const matched: string[] = [];
  for (const k of keys) {
    const w = profile[k];
    if (!w) continue;
    const kw = perKeyWeight ? perKeyWeight(k) : 1;
    dot += w * kw;
    if (w > 0) matched.push(k);
  }
  return { score: dot, matched };
}

function magnitude(map: Record<string, number>): number {
  let s = 0;
  for (const v of Object.values(map)) s += v * v;
  return Math.sqrt(s) || 1;
}

/**
 * Score a single candidate against the profile, returning the score and the
 * structured reasons that justify it.
 *
 * @param lovedTitlesByDim - for the "because you loved X" reason: titles of the
 *   user's top-affinity anime sharing this candidate's strongest dimension.
 */
export function scoreCandidate(
  profile: TasteProfile,
  meta: AnimeMeta,
  opts: {
    communityStrength?: number; // 0..1 from AniList recommendations overlap
    lovedSimilarTitles?: string[];
    sequelOfTitle?: string;
  } = {},
): Recommendation {
  const reasons: RecReason[] = [];

  // ── Content similarity ──
  const gMag = magnitude(profile.genres);
  const tMag = magnitude(profile.tags);
  const sMag = magnitude(profile.studios);

  const g = dimDot(profile.genres, meta.genres);
  const t = dimDot(
    profile.tags,
    meta.tags.filter((x) => !x.isMediaSpoiler).map((x) => x.name),
    (k) => {
      const tag = meta.tags.find((x) => x.name === k);
      return tag ? tag.rank / 100 : 0.5;
    },
  );
  const s = dimDot(profile.studios, meta.studios);
  const fmt = meta.format ? profile.formats[meta.format] ?? 0 : 0;
  const dec = profile.decades[`${Math.floor((meta.seasonYear ?? 0) / 10) * 10}s`] ?? 0;

  let content =
    (g.score / gMag) * W.genre +
    (t.score / tMag) * W.tag +
    (s.score / sMag) * W.studio +
    Math.sign(fmt) * Math.min(0.4, Math.abs(fmt)) * W.format +
    Math.sign(dec) * Math.min(0.3, Math.abs(dec)) * W.decade;

  // ── Penalties for disliked dimensions ──
  for (const gg of meta.genres) {
    const w = profile.genres[gg];
    if (w && w < -0.3) content -= W.dislikedGenre * Math.abs(w) * 0.2;
  }

  // ── Reasons from matched dimensions ──
  if (opts.sequelOfTitle) {
    content += W.sequelBonus;
    reasons.push({ kind: "sequel", ofTitle: opts.sequelOfTitle });
  }
  if (opts.lovedSimilarTitles?.length) {
    reasons.push({ kind: "lovedSimilar", titles: opts.lovedSimilarTitles.slice(0, 2) });
  }
  if (s.matched.length) {
    reasons.push({ kind: "studio", studio: s.matched[0] });
  }
  if (g.matched.length) {
    reasons.push({ kind: "genres", genres: g.matched.slice(0, 3) });
  }
  if (t.matched.length) {
    reasons.push({ kind: "tags", tags: t.matched.slice(0, 3) });
  }

  // ── Community signal (AniList "if you liked X" overlap) ──
  const community = opts.communityStrength ?? 0;
  if (community > 0.3) reasons.push({ kind: "community" });

  // ── Quality ──
  const quality = (meta.averageScore ?? 0) / 100;
  if ((meta.averageScore ?? 0) >= 80) {
    reasons.push({ kind: "highlyRated", score: meta.averageScore! });
  }

  // ── Niche mismatch penalty: user leans niche but candidate is mega-popular ──
  let nichePenalty = 0;
  if (profile.nicheLean > 0 && meta.popularity) {
    const ratio = meta.popularity / Math.max(1, profile.nicheLean);
    if (ratio > 3) nichePenalty = W.popularityMismatch * 0.15;
  }

  const score =
    W.content * Math.max(0, content) +
    W.community * community +
    W.quality * quality -
    nichePenalty;

  return { anime: meta, score, reasons };
}

/**
 * MMR-style diversification: greedily pick the highest-scoring candidate, then
 * penalise remaining candidates that overlap heavily in genres with what's
 * already picked, so the final list isn't five clones of one genre.
 */
export function diversify(
  scored: Recommendation[],
  limit: number,
  lambda = 0.72,
): Recommendation[] {
  const pool = [...scored].sort((a, b) => b.score - a.score);
  const picked: Recommendation[] = [];
  const usedGenres = new Map<string, number>();

  while (picked.length < limit && pool.length) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      let overlap = 0;
      for (const g of c.anime.genres) overlap += usedGenres.get(g) ?? 0;
      const diversityPenalty = overlap / Math.max(1, c.anime.genres.length);
      const mmr = lambda * c.score - (1 - lambda) * diversityPenalty;
      if (mmr > bestVal) {
        bestVal = mmr;
        bestIdx = i;
      }
    }
    const [chosen] = pool.splice(bestIdx, 1);
    picked.push(chosen);
    for (const g of chosen.anime.genres) {
      usedGenres.set(g, (usedGenres.get(g) ?? 0) + 1);
    }
  }
  return picked;
}

/** Top-N keys of a weight map by value (for the profile summary blurb). */
export function topKeys(map: Record<string, number>, n: number): string[] {
  return Object.entries(map)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}
