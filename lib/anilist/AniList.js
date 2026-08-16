import { listAnime } from "../db/anime";
import { anilistFetch } from "./anilistFetch";

// Process-level in-memory cache (per server instance) — TTL 30 min.
const aniListCache = new Map();
const ANILIST_TTL = 30 * 60 * 1000;
const HOMEPAGE_TTL = 30 * 60 * 1000;

// Manual outage simulator — set MOCK_ANILIST_DOWN=1 in .env.local to test the
// Turso fallback path without actually breaking AniList.
const MOCK_DOWN = process.env.MOCK_ANILIST_DOWN === "1";

/**
 * Map AniList Media JSON pulled from Turso into the shape the homepage
 * components expect. Turso stores the full Tier-1 payload so the shape is
 * already very close — we just trim down to the same fields the live
 * query returns.
 */
function shapeFromCache(media) {
  return {
    id: media.id,
    idMal: media.idMal ?? null,
    status: media.status ?? null,
    title: media.title ?? { romaji: null, english: null },
    bannerImage: media.bannerImage ?? null,
    coverImage: media.coverImage ?? { extraLarge: null, color: null },
    description: media.description ?? "",
  };
}

/**
 * Last-resort fallback when AniList is unreachable. Pulls the requested
 * number of anime from Turso in the requested sort order. Returns null
 * when Turso is empty or unconfigured (caller falls back to []).
 */
async function fallbackFromDb(sort, perPage = 15) {
  try {
    const rows = await listAnime(sort, perPage);
    if (!rows || rows.length === 0) return null;
    return rows.map(shapeFromCache);
  } catch (e) {
    console.warn("Turso fallback failed:", e.message);
    return null;
  }
}

const PAGE_FRAGMENT = `
  pageInfo { total currentPage lastPage hasNextPage perPage }
  media(id: $id, search: $search, sort: $sort, type: ANIME) {
    id idMal status
    title { romaji english }
    bannerImage
    coverImage { extraLarge color }
    description
  }
`;

const SINGLE_QUERY = `
  query (
    $id: Int
    $page: Int
    $perPage: Int
    $search: String
    $sort: [MediaSort]
  ) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { total currentPage lastPage hasNextPage perPage }
      media(id: $id, search: $search, sort: $sort, type: ANIME) {
        id idMal status
        title { romaji english }
        bannerImage
        coverImage { extraLarge color }
        description
      }
    }
  }
`;

/**
 * Fetch a single Page of media. Cached for 30 min, 4s timeout.
 */
export async function aniListData({ sort, page = 1 }) {
  const cacheKey = `${sort}-${page}`;
  const cached = aniListCache.get(cacheKey);
  if (cached && Date.now() - cached.t < ANILIST_TTL) return cached.value;

  try {
    if (MOCK_DOWN) throw new Error("MOCK_ANILIST_DOWN");
    const anilistData = await anilistFetch({
      query: SINGLE_QUERY,
      variables: { page, perPage: 15, sort },
      timeoutMs: 4000,
      label: `aniListData:${sort}:${page}`,
    });
    if (!anilistData) throw new Error("anilistFetch returned null");
    const data = anilistData?.data?.Page?.media || [];
    const result = { props: { data } };
    if (data.length > 0) aniListCache.set(cacheKey, { t: Date.now(), value: result });
    return result;
  } catch (e) {
    console.warn("AniList fetch error:", e.message);
    if (cached) return cached.value;
    // Last resort: serve from Turso so the page doesn't go blank during
    // an AniList outage.
    const dbRows = await fallbackFromDb(sort, 15);
    if (dbRows) {
      return { props: { data: dbRows } };
    }
    return { props: { data: [] } };
  }
}

/**
 * Batch fetch ALL homepage data in ONE GraphQL request using aliases.
 * Replaces 3 separate aniListData() calls with a single AniList token cost.
 */
const HOMEPAGE_BATCH_QUERY = `
  query HomeBatch($perPage: Int!, $season: MediaSeason!, $seasonYear: Int!) {
    trending: Page(page: 1, perPage: $perPage) {
      media(sort: TRENDING_DESC, type: ANIME) {
        id idMal status
        title { romaji english }
        bannerImage
        coverImage { extraLarge color }
        description
      }
    }
    popular: Page(page: 1, perPage: $perPage) {
      media(sort: POPULARITY_DESC, type: ANIME) {
        id idMal status
        title { romaji english }
        bannerImage
        coverImage { extraLarge color }
        description
      }
    }
    genre: Page(page: 1, perPage: $perPage) {
      media(sort: TYPE, type: ANIME) {
        id idMal status
        title { romaji english }
        bannerImage
        coverImage { extraLarge color }
        description
      }
    }
    # The hero carousel's pool — Hayase's exact query
    # (hayase-app/interface, src/lib/components/ui/banner/banner.svelte):
    # the current season's best-SCORED titles, minus what hasn't aired.
    #
    # NOT the trending list, and that distinction is the whole point. Trending
    # is dominated by evergreens — One Piece, Bleach, Naruto — which is what
    # made the hero feel frozen. Scoping to the season and ranking by score
    # gives "what's good right now", which is what a hero is for.
    #
    # Free to add: this is one alias inside an already-batched request, so it
    # costs no extra AniList call and no extra rate-limit token.
    heroPool: Page(page: 1, perPage: $perPage) {
      media(season: $season, seasonYear: $seasonYear, status_not: NOT_YET_RELEASED, sort: SCORE_DESC, type: ANIME) {
        id idMal status
        title { romaji english }
        bannerImage
        coverImage { extraLarge color }
        description
      }
    }
    thisSeason: Page(page: 1, perPage: $perPage) {
      media(season: $season, seasonYear: $seasonYear, sort: POPULARITY_DESC, type: ANIME) {
        id idMal status
        title { romaji english }
        bannerImage
        coverImage { extraLarge color }
        description
      }
    }
    movies: Page(page: 1, perPage: $perPage) {
      media(format: MOVIE, sort: POPULARITY_DESC, type: ANIME) {
        id idMal status
        title { romaji english }
        bannerImage
        coverImage { extraLarge color }
        description
      }
    }
  }
`;

// AniList's MediaSeason enum is keyed by calendar quarter. Returns the
// current { season, seasonYear } for the "This Season" carousel.
function currentSeason() {
  const now = new Date();
  const m = now.getMonth(); // 0-11
  const season =
    m <= 2 ? "WINTER" : m <= 5 ? "SPRING" : m <= 8 ? "SUMMER" : "FALL";
  return { season, seasonYear: now.getFullYear() };
}

let homepageCache = null;

export async function aniListHomepageBatch() {
  if (homepageCache && Date.now() - homepageCache.t < HOMEPAGE_TTL) {
    return homepageCache.value;
  }

  const { season, seasonYear } = currentSeason();

  try {
    if (MOCK_DOWN) throw new Error("MOCK_ANILIST_DOWN");
    const json = await anilistFetch({
      query: HOMEPAGE_BATCH_QUERY,
      variables: { perPage: 15, season, seasonYear },
      timeoutMs: 5000,
      label: "homepageBatch",
    });
    if (!json) throw new Error("anilistFetch returned null");
    const value = {
      trending: { props: { data: json?.data?.trending?.media || [] } },
      popular: { props: { data: json?.data?.popular?.media || [] } },
      genre: { props: { data: json?.data?.genre?.media || [] } },
      heroPool: { props: { data: json?.data?.heroPool?.media || [] } },
      thisSeason: { props: { data: json?.data?.thisSeason?.media || [] } },
      movies: { props: { data: json?.data?.movies?.media || [] } },
    };
    if (value.trending.props.data.length > 0) {
      homepageCache = { t: Date.now(), value };
    }
    return value;
  } catch (e) {
    console.warn("AniList homepage batch error:", e.message);
    if (homepageCache) return homepageCache.value;
    // Serve the homepage carousels from Turso in parallel. Each may return
    // null if Turso is also empty/unreachable — those slots fall back to [].
    const [trendingRows, popularRows, genreRows] = await Promise.all([
      fallbackFromDb("TRENDING_DESC", 15),
      fallbackFromDb("POPULARITY_DESC", 15),
      fallbackFromDb("ID_DESC", 15),
    ]);
    return {
      trending: { props: { data: trendingRows || [] } },
      popular:  { props: { data: popularRows  || [] } },
      genre:    { props: { data: genreRows    || [] } },
      // No reliable Turso fallback for season/movies — leave empty so the
      // sections simply don't render rather than show wrong data.
      heroPool: { props: { data: [] } },
      thisSeason: { props: { data: [] } },
      movies:     { props: { data: [] } },
    };
  }
}
