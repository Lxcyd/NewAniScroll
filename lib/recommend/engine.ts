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
  quality: 0.18,
  // Tags are AniList's most granular taste signal (e.g. "Time Loop",
  // "Anti-Hero", "Found Family") — they carry the most "feel" of an anime, so
  // they dominate the content similarity. Genres are broad; studios distinctive.
  genre: 0.7,
  tag: 1.5,
  studio: 1.1,
  format: 0.35,
  decade: 0.25,
  // penalties
  dislikedGenre: 1.3,
  dislikedTag: 1.4,
  popularityMismatch: 0.5,
  // bonuses
  sequelBonus: 0.45,
  bingeBonus: 0.25,
  recency: 0.2,
} as const;

/** Map a user score (0–10) to a signed affinity in roughly [-1.0, +1.2].
 *  Rewards favourites strongly (loving an anime is a much louder signal than
 *  mild approval) and penalises low scores hard so disliked traits are avoided.
 *  Mean-relative: a 7 from someone who averages 6 means more than from a harsh
 *  rater who averages 8 — handled by passing `mean` so the curve recentres. */
function scoreToAffinity(score: number, mean = 7): number {
  if (score <= 0) return 0; // unscored
  // Recentre around the user's own mean: delta in [-x, +x] from their average.
  const delta = score - mean;
  // Sigmoid-ish: strong positive for clearly-above-mean, strong negative below.
  let a: number;
  if (delta >= 2) a = 1.2;
  else if (delta >= 1) a = 0.8;
  else if (delta >= 0.5) a = 0.45;
  else if (delta >= -0.25) a = 0.15;
  else if (delta >= -1) a = -0.2;
  else if (delta >= -2) a = -0.6;
  else a = -1.0;
  // Absolute floor: a 9–10 is always a strong love regardless of mean.
  if (score >= 9) a = Math.max(a, 1.1);
  if (score <= 3) a = Math.min(a, -0.7);
  return a;
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

  const isWatched = (s: string | null) =>
    s === "COMPLETED" || s === "CURRENT" || s === "REPEATING" || s === "DROPPED";

  // ── Pre-pass: the user's own mean score, so affinity is mean-relative.
  let scoreSum = 0;
  let scoreCount = 0;
  for (const e of list) {
    if (e.score && e.score > 0 && isWatched(e.status)) {
      scoreSum += e.score;
      scoreCount++;
    }
  }
  const meanScore = scoreCount ? scoreSum / scoreCount : 7;

  let lovedPopSum = 0;
  let lovedPopCount = 0;
  let sampleSize = 0;

  for (const entry of list) {
    const meta = metaById.get(entry.mediaId);
    if (!meta) continue;
    if (!isWatched(entry.status)) continue;

    let affinity = scoreToAffinity(entry.score ?? 0, meanScore);

    // DROPPED = explicit dislike; never let it read as positive.
    if (entry.status === "DROPPED") affinity = Math.min(affinity, -0.4);
    // Rewatched = strong favourite signal (multiplicative so it amplifies love).
    if (entry.repeat > 0) affinity += Math.min(0.5, entry.repeat * 0.25);
    // Fast binge bonus (only meaningful for liked anime).
    if (affinity > 0) affinity += bingeBonus(entry, meta.episodes);
    // A barely-started CURRENT anime is weak evidence — damp it.
    if (entry.status === "CURRENT" && meta.episodes && meta.episodes > 1) {
      const frac = Math.min(1, entry.progress / meta.episodes);
      affinity *= 0.4 + 0.6 * frac; // 0.4× at ep1 → 1× when caught up
    }

    if (affinity === 0) continue;
    sampleSize++;

    if (affinity > 0.5 && meta.popularity) {
      lovedPopSum += meta.popularity;
      lovedPopCount++;
    }

    for (const g of meta.genres) bump(genres, g, affinity * W.genre);
    for (const tg of meta.tags) {
      if (tg.isMediaSpoiler) continue;
      // rank 0..100 → weight 0..1; only count meaningfully-ranked tags.
      if (tg.rank < 25) continue;
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
    meanScore,
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

  // Tag overlap density: how many of the candidate's strong tags the user
  // actively likes — a dense thematic match is the best "you'll love this" cue.
  const strongTags = meta.tags.filter((x) => !x.isMediaSpoiler && x.rank >= 50);
  const likedTagHits = strongTags.filter((x) => (profile.tags[x.name] ?? 0) > 0).length;
  const tagDensity = strongTags.length ? likedTagHits / strongTags.length : 0;

  let content =
    (g.score / gMag) * W.genre +
    (t.score / tMag) * W.tag * (0.6 + 0.4 * tagDensity) + // reward dense matches
    (s.score / sMag) * W.studio +
    Math.sign(fmt) * Math.min(0.4, Math.abs(fmt)) * W.format +
    Math.sign(dec) * Math.min(0.3, Math.abs(dec)) * W.decade;

  // ── Penalties for disliked dimensions (avoid what you don't like) ──
  for (const gg of meta.genres) {
    const w = profile.genres[gg];
    if (w && w < -0.25) content -= W.dislikedGenre * Math.abs(w) * 0.25;
  }
  for (const tg of strongTags) {
    const w = profile.tags[tg.name];
    if (w && w < -0.2) content -= W.dislikedTag * Math.abs(w) * (tg.rank / 100) * 0.3;
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
  if (t.matched.length) {
    // Tags first — they're the most specific, most compelling reason.
    reasons.push({ kind: "tags", tags: t.matched.slice(0, 3) });
  }
  if (g.matched.length) {
    reasons.push({ kind: "genres", genres: g.matched.slice(0, 3) });
  }

  // ── Community signal (AniList "if you liked X" overlap) — strongest signal. ──
  const community = opts.communityStrength ?? 0;
  if (community > 0.25) reasons.push({ kind: "community" });

  // ── Quality ──
  const quality = (meta.averageScore ?? 0) / 100;
  if ((meta.averageScore ?? 0) >= 80) {
    reasons.push({ kind: "highlyRated", score: meta.averageScore! });
  }

  // ── Recency: lightly favour anime from the decade(s) the user actually
  //    watches, and nudge very recent releases up (discovery skews fresh). ──
  let recency = 0;
  const year = meta.seasonYear ?? 0;
  if (year) {
    const age = new Date().getFullYear() - year;
    if (age <= 2) recency = W.recency; // current-ish seasons
    else if (age <= 5) recency = W.recency * 0.5;
  }

  // ── Niche mismatch penalty: user leans niche but candidate is mega-popular.
  //    Adaptive: the further the candidate's popularity is above what the user
  //    typically loves, the stronger the nudge down — so blockbusters don't
  //    crowd out the on-taste picks for a niche viewer. ──
  let nichePenalty = 0;
  if (profile.nicheLean > 0 && meta.popularity) {
    const ratio = meta.popularity / Math.max(1, profile.nicheLean);
    if (ratio > 2) {
      // ratio 2→0, 4→~0.5, 8+→capped — log-scaled so it grows gracefully.
      nichePenalty = Math.min(0.6, Math.log2(ratio / 2) * 0.25) * W.popularityMismatch;
    }
  }

  // A candidate with NO content match AND no community backing is noise — floor
  // it low so genre-page filler can't outrank a real thematic match.
  const hasSignal = content > 0.05 || community > 0;

  // Missing synopsis usually means a thin/obscure entry — small deprioritise so
  // a fleshed-out title wins ties (never zero it; it's only a tie-breaker).
  const thinPenalty = meta.description && meta.description.length > 40 ? 0 : 0.04;

  const score =
    (W.content * Math.max(0, content) +
      W.community * community +
      W.quality * quality +
      recency -
      nichePenalty -
      thinPenalty) *
    (hasSignal ? 1 : 0.15);

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

/**
 * Targeted genre combinations for content-based candidate generation.
 *
 * AniList ANDs the genres in a single `genre_in` filter, so [Action, Comedy]
 * surfaces anime that are BOTH — far more on-taste than a broad OR over the top
 * genres (which just returns each genre's blockbusters). We emit the top genre
 * alone (broad net) plus a few pairs of the user's strongest genres (tight net).
 * Capped so we never fan out into too many AniList requests.
 */
export function genreCombos(
  genres: Record<string, number>,
  maxSets = 5,
): string[][] {
  const top = topKeys(genres, 4);
  if (!top.length) return [];
  const sets: string[][] = [[top[0]]]; // broad net on the single favourite
  // Tight nets: pair the #1 genre with each of the next ones, then #2+#3.
  for (let i = 1; i < top.length && sets.length < maxSets; i++) {
    sets.push([top[0], top[i]]);
  }
  if (top.length >= 3 && sets.length < maxSets) sets.push([top[1], top[2]]);
  return sets.slice(0, maxSets);
}
