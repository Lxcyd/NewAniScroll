import { listAnime } from "../db/anime";

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

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 4000);

  try {
    if (MOCK_DOWN) throw new Error("MOCK_ANILIST_DOWN");
    const resAnilist = await fetch(`https://graphql.anilist.co`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: SINGLE_QUERY,
        variables: { page, perPage: 15, sort },
      }),
    });
    if (!resAnilist.ok) throw new Error(`AniList HTTP ${resAnilist.status}`);
    const anilistData = await resAnilist.json();
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
      console.info(`AniList down → served ${dbRows.length} rows from Turso (sort=${sort})`);
      return { props: { data: dbRows } };
    }
    return { props: { data: [] } };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Batch fetch ALL homepage data in ONE GraphQL request using aliases.
 * Replaces 3 separate aniListData() calls with a single AniList token cost.
 */
const HOMEPAGE_BATCH_QUERY = `
  query HomeBatch($perPage: Int!) {
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
  }
`;

let homepageCache = null;

export async function aniListHomepageBatch() {
  if (homepageCache && Date.now() - homepageCache.t < HOMEPAGE_TTL) {
    return homepageCache.value;
  }

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 5000);

  try {
    if (MOCK_DOWN) throw new Error("MOCK_ANILIST_DOWN");
    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: HOMEPAGE_BATCH_QUERY,
        variables: { perPage: 15 },
      }),
    });
    if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
    const json = await res.json();
    const value = {
      trending: { props: { data: json?.data?.trending?.media || [] } },
      popular: { props: { data: json?.data?.popular?.media || [] } },
      genre: { props: { data: json?.data?.genre?.media || [] } },
    };
    if (value.trending.props.data.length > 0) {
      homepageCache = { t: Date.now(), value };
    }
    return value;
  } catch (e) {
    console.warn("AniList homepage batch error:", e.message);
    if (homepageCache) return homepageCache.value;
    // Serve the three homepage carousels from Turso in parallel. Each may
    // return null if Turso is also empty/unreachable — those slots fall
    // back to [].
    const [trendingRows, popularRows, genreRows] = await Promise.all([
      fallbackFromDb("TRENDING_DESC", 15),
      fallbackFromDb("POPULARITY_DESC", 15),
      fallbackFromDb("ID_DESC", 15),
    ]);
    if (trendingRows || popularRows || genreRows) {
      console.info("AniList down → homepage served from Turso");
    }
    return {
      trending: { props: { data: trendingRows || [] } },
      popular:  { props: { data: popularRows  || [] } },
      genre:    { props: { data: genreRows    || [] } },
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
