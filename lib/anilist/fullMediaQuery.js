/**
 * Tier-1 Media query — every field a streaming UI needs at runtime.
 *
 * Kept here as a single source of truth so SSR, the cache bootstrap script,
 * the cron refresh, and `getMediaMeta` all fetch the same shape. Adding a
 * field anywhere means adding it here and re-bootstrapping (or letting the
 * TTL refresh roll it in over a few days).
 *
 * Excluded by design:
 *   • mediaListEntry  — per-user, never cached
 *   • characters/staff/recommendations — Tier-2, not yet wired into the UI
 *   • reviews/stats   — Tier-3, very heavy and rarely viewed
 */

export const FULL_MEDIA_FIELDS = `
  id
  idMal
  type
  format
  status
  description(asHtml: false)
  season
  seasonYear
  episodes
  duration
  startDate { year month day }
  endDate   { year month day }
  countryOfOrigin
  source
  hashtag
  isAdult
  averageScore
  meanScore
  popularity
  favourites
  trending
  genres
  synonyms
  title       { romaji english native userPreferred }
  coverImage  { extraLarge large medium color }
  bannerImage
  trailer     { id site thumbnail }
  tags        { id name rank category isMediaSpoiler }
  studios     { edges { isMain node { id name } } }
  externalLinks { id url site type language color icon }
  streamingEpisodes { title thumbnail url site }
  nextAiringEpisode { airingAt episode timeUntilAiring }
  rankings    { id rank type format year season allTime context }
  relations {
    edges {
      id
      relationType(version: 2)
      node {
        id format type status(version: 2) episodes
        title { romaji english native userPreferred }
        bannerImage
        coverImage { extraLarge large color }
      }
    }
  }
  characters {
    edges {
      role
      node {
        id
        image { large medium }
        name { full userPreferred }
      }
    }
  }
  recommendations {
    nodes {
      mediaRecommendation {
        id
        title { romaji userPreferred }
        coverImage { extraLarge large }
      }
    }
  }
  updatedAt
`;

export const FULL_MEDIA_QUERY = `query($id:Int){Media(id:$id){${FULL_MEDIA_FIELDS}}}`;

export const FULL_PAGE_QUERY = `
  query($page:Int,$perPage:Int,$sort:[MediaSort]){
    Page(page:$page, perPage:$perPage){
      pageInfo { hasNextPage currentPage lastPage perPage total }
      media(sort:$sort, type:ANIME){${FULL_MEDIA_FIELDS}}
    }
  }
`;
