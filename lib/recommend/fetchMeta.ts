/**
 * Server-side AniList metadata fetch for the recommendation engine.
 *
 * Pulls the per-anime fields the engine needs (genres, tags, studios, format,
 * scores, recommendations) in batched Page queries. Uses the shared anilistFetch
 * which already does Redis response-caching + rate-limiting, so popular anime
 * metadata is shared across all users and rarely re-fetched.
 *
 * Two field-sets keep AniList bandwidth (and our Upstash/Vercel egress) low:
 *   • LIGHT — profile + franchise walk over the WHOLE list (can be 300+ ids).
 *     No description / banner / recommendations: those are heavy and useless for
 *     scoring. Just enough to build the taste vector and exclude franchises.
 *   • FULL  — only the handful of candidates we actually display, hydrated once
 *     at the end with description, banner and community recommendations.
 */

import { anilistFetch } from "@/lib/anilist/anilistFetch";
import type { AnimeMeta } from "./types";

/** Heavy display fields — only fetched for the ~few candidates we show. */
const FULL_FIELDS = `
  id
  title { romaji english native userPreferred }
  coverImage { extraLarge large color }
  bannerImage
  description(asHtml: false)
  genres
  tags { name rank category isMediaSpoiler }
  studios(isMain: true) { nodes { name } }
  format
  episodes
  duration
  averageScore
  popularity
  seasonYear
  season
  status
  relations { edges { relationType node { id type format } } }
  recommendations(sort: RATING_DESC, perPage: 8) {
    nodes { mediaRecommendation { id } }
  }
`;

/** Lightweight fields — enough to profile + franchise-exclude the whole list,
 *  without the heavy description/banner/recommendations payload. */
const LIGHT_FIELDS = `
  id
  title { romaji english native userPreferred }
  coverImage { large color }
  genres
  tags { name rank category isMediaSpoiler }
  studios(isMain: true) { nodes { name } }
  format
  episodes
  duration
  averageScore
  popularity
  seasonYear
  season
  status
  relations { edges { relationType node { id type format } } }
`;

function parseMedia(m: any): AnimeMeta {
  const recs: number[] = (m?.recommendations?.nodes || [])
    .map((n: any) => n?.mediaRecommendation?.id)
    .filter((x: any) => Number.isFinite(x));
  return {
    id: Number(m.id),
    title: m.title || {},
    coverImage: m.coverImage || undefined,
    bannerImage: m.bannerImage ?? null,
    description: m.description ?? null,
    genres: Array.isArray(m.genres) ? m.genres : [],
    tags: Array.isArray(m.tags)
      ? m.tags.map((t: any) => ({
          name: t.name,
          rank: Number(t.rank) || 0,
          category: t.category ?? undefined,
          isMediaSpoiler: !!t.isMediaSpoiler,
        }))
      : [],
    studios: (m?.studios?.nodes || []).map((n: any) => n?.name).filter(Boolean),
    format: m.format ?? null,
    episodes: m.episodes ?? null,
    duration: m.duration ?? null,
    averageScore: m.averageScore ?? null,
    popularity: m.popularity ?? null,
    seasonYear: m.seasonYear ?? null,
    season: m.season ?? null,
    status: m.status ?? null,
    recommendations: recs,
  };
}

/** Side-channel: relations (sequels) discovered while fetching, keyed by the
 *  source media id → list of {id, relationType}. Stored on the returned metas. */
export type MetaWithRelations = AnimeMeta & {
  relations?: { id: number; relationType: string; format: string | null }[];
};

function parseWithRelations(m: any): MetaWithRelations {
  const base = parseMedia(m) as MetaWithRelations;
  base.relations = (m?.relations?.edges || [])
    .map((e: any) => ({
      id: Number(e?.node?.id),
      relationType: e?.relationType,
      format: e?.node?.format ?? null,
    }))
    .filter((r: any) => Number.isFinite(r.id));
  return base;
}

const BATCH = 50; // AniList Page cap

/** Fetch metadata for a set of media ids. Batches of 50 run in PARALLEL so a
 *  300-anime list resolves in one round-trip's latency, not six in series.
 *  `full=false` (default) uses the lightweight field-set to keep payloads small. */
export async function fetchMetaByIds(
  ids: number[],
  full = false,
): Promise<Map<number, MetaWithRelations>> {
  const out = new Map<number, MetaWithRelations>();
  const unique = Array.from(new Set(ids.filter((n) => Number.isFinite(n))));
  if (!unique.length) return out;

  const fields = full ? FULL_FIELDS : LIGHT_FIELDS;
  const slices: number[][] = [];
  for (let i = 0; i < unique.length; i += BATCH) {
    slices.push(unique.slice(i, i + BATCH));
  }

  const results = await Promise.all(
    slices.map((slice) =>
      anilistFetch({
        query: `query ($ids: [Int]) {
          Page(perPage: ${BATCH}) {
            media(id_in: $ids, type: ANIME) { ${fields} }
          }
        }`,
        variables: { ids: slice },
        label: full ? "recommend:meta:full" : "recommend:meta:light",
        cacheSeconds: 60 * 60, // anime metadata is stable; cache an hour
      }),
    ),
  );

  for (const json of results) {
    for (const m of json?.data?.Page?.media || []) {
      const parsed = parseWithRelations(m);
      out.set(parsed.id, parsed);
    }
  }
  return out;
}

/** Relation types that point BACK toward the start of a franchise — following
 *  these walks us toward Season 1 / the original work. */
const ROOT_RELATIONS = new Set(["PREQUEL", "PARENT", "FULL_STORY"]);

/** Formats we treat as a real "season" the user would start from. We skip
 *  movies/music/specials as roots — a recap movie isn't where you begin. */
const SEASON_FORMATS = new Set(["TV", "TV_SHORT", "ONA", "OVA"]);

function isSeasonStart(m: MetaWithRelations | undefined): boolean {
  return !!m && (m.format == null || SEASON_FORMATS.has(m.format));
}

/**
 * Walk a candidate back to the FIRST season of its franchise.
 *
 * Discover should always present a never-seen anime by its entry point — if the
 * collaborative / genre sources surface "Attack on Titan S4" we want to show
 * S1 instead. We follow PREQUEL/PARENT edges to the root, fetching only the
 * relation chain ids we don't already have cached.
 *
 * `cache` is reused/extended across calls so a batch of candidates sharing a
 * franchise only resolves the chain once. Returns the root id (which may equal
 * the input id if it has no prequel).
 */
export async function rootSeasonOf(
  startId: number,
  cache: Map<number, MetaWithRelations>,
): Promise<number> {
  let cursor = startId;
  const visited = new Set<number>([startId]);

  for (let hop = 0; hop < 12; hop++) {
    let meta = cache.get(cursor);
    if (!meta) {
      const fetched = await fetchMetaByIds([cursor], false);
      meta = fetched.get(cursor);
      if (meta) cache.set(cursor, meta);
    }
    if (!meta) break;

    // Prefer a season-like prequel; bridge through OVA/SPECIAL prequels if
    // that's all AniList records, but never step onto a movie/off-format root.
    const prequels = (meta.relations || []).filter((r) =>
      ROOT_RELATIONS.has(r.relationType),
    );
    if (!prequels.length) break;

    // Make sure we have metadata for the prequel targets to inspect format.
    const need = prequels.map((r) => r.id).filter((id) => !cache.has(id));
    if (need.length) {
      const fetched = await fetchMetaByIds(need, false);
      fetched.forEach((m, id) => cache.set(id, m));
    }

    const seasonLike = prequels.find((r) => isSeasonStart(cache.get(r.id)));
    const chosen = seasonLike ?? prequels[0];
    if (!chosen || visited.has(chosen.id)) break;
    visited.add(chosen.id);
    cursor = chosen.id;
  }

  return cursor;
}

/** Fetch highly-rated candidates filtered by genres (content-based candidate
 *  generation), excluding adult content. Lightweight field-set; multiple genre
 *  combinations run in parallel. `genreSets` is a list of genre arrays — each is
 *  ANDed inside AniList, so passing tighter combos yields more on-taste results
 *  than one broad OR over the top genres. */
export async function fetchCandidatesByGenres(
  genreSets: string[][],
  page = 1,
): Promise<MetaWithRelations[]> {
  const sets = genreSets.filter((g) => g.length).slice(0, 5);
  if (!sets.length) return [];

  const pages = await Promise.all(
    sets.map((genres) =>
      anilistFetch({
        query: `query ($genres: [String], $page: Int) {
          Page(page: $page, perPage: 50) {
            media(
              type: ANIME, genre_in: $genres, sort: [SCORE_DESC, POPULARITY_DESC],
              isAdult: false, averageScore_greater: 65
            ) { ${LIGHT_FIELDS} }
          }
        }`,
        variables: { genres: genres.slice(0, 3), page },
        label: "recommend:candidates",
        cacheSeconds: 30 * 60,
      }),
    ),
  );

  const out: MetaWithRelations[] = [];
  const seen = new Set<number>();
  for (const json of pages) {
    for (const m of json?.data?.Page?.media || []) {
      const parsed = parseWithRelations(m);
      if (!seen.has(parsed.id)) {
        seen.add(parsed.id);
        out.push(parsed);
      }
    }
  }
  return out;
}
