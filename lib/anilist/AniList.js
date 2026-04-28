// Process-level in-memory cache (per server instance) — TTL 30 min.
const aniListCache = new Map();
const ANILIST_TTL = 30 * 60 * 1000;
const HOMEPAGE_TTL = 30 * 60 * 1000;

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
    const resAnilist = await fetch(`https://graphql.anilist.co`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: SINGLE_QUERY,
        variables: { page, perPage: 15, sort },
      }),
    });
    const anilistData = await resAnilist.json();
    const data = anilistData?.data?.Page?.media || [];
    const result = { props: { data } };
    if (data.length > 0) aniListCache.set(cacheKey, { t: Date.now(), value: result });
    return result;
  } catch (e) {
    console.warn("AniList fetch error:", e.message);
    if (cached) return cached.value;
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
    return {
      trending: { props: { data: [] } },
      popular: { props: { data: [] } },
      genre: { props: { data: [] } },
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
