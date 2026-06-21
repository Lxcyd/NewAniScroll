/**
 * Server-side AniList metadata fetch for the recommendation engine.
 *
 * Pulls the per-anime fields the engine needs (genres, tags, studios, format,
 * scores, recommendations) in batched Page queries. Uses the shared anilistFetch
 * which already does Redis response-caching + rate-limiting, so popular anime
 * metadata is shared across all users and rarely re-fetched.
 */

import { anilistFetch } from "@/lib/anilist/anilistFetch";
import type { AnimeMeta } from "./types";

const META_FIELDS = `
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

/** Fetch metadata for a set of media ids, in batches of 50 (AniList page cap). */
export async function fetchMetaByIds(
  ids: number[],
): Promise<Map<number, MetaWithRelations>> {
  const out = new Map<number, MetaWithRelations>();
  const unique = Array.from(new Set(ids.filter((n) => Number.isFinite(n))));
  const BATCH = 50;

  for (let i = 0; i < unique.length; i += BATCH) {
    const slice = unique.slice(i, i + BATCH);
    const query = `query ($ids: [Int]) {
      Page(perPage: ${BATCH}) {
        media(id_in: $ids, type: ANIME) { ${META_FIELDS} }
      }
    }`;
    const json = await anilistFetch({
      query,
      variables: { ids: slice },
      label: "recommend:meta",
      cacheSeconds: 60 * 60, // anime metadata is stable; cache an hour
    });
    const media = json?.data?.Page?.media || [];
    for (const m of media) {
      const parsed = parseWithRelations(m);
      out.set(parsed.id, parsed);
    }
  }
  return out;
}

/** Fetch a page of highly-rated candidates filtered by genres (content-based
 *  candidate generation), excluding adult content. */
export async function fetchCandidatesByGenres(
  genres: string[],
  page = 1,
): Promise<MetaWithRelations[]> {
  if (!genres.length) return [];
  const query = `query ($genres: [String], $page: Int) {
    Page(page: $page, perPage: 50) {
      media(
        type: ANIME, genre_in: $genres, sort: [SCORE_DESC, POPULARITY_DESC],
        isAdult: false, averageScore_greater: 65
      ) { ${META_FIELDS} }
    }
  }`;
  const json = await anilistFetch({
    query,
    variables: { genres: genres.slice(0, 4), page },
    label: "recommend:candidates",
    cacheSeconds: 30 * 60,
  });
  return (json?.data?.Page?.media || []).map(parseWithRelations);
}
