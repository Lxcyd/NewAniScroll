import { redis } from "@/lib/redis";
import { anilistFetch } from "./anilistFetch";

/**
 * Upcoming-anime carousel for the home page.
 *
 * Called from every home-page SSR. The underlying data (anime airing
 * "soon" in the current season) shifts at most once per day, so we
 * cache the resolved list in Redis for 6 hours.
 *
 * The AniList call itself goes through the global limiter, so even a
 * cold-cache stampede can't blow the rate budget.
 */

const CACHE_KEY = "anilist:upcoming:v1";
const TTL_SECONDS = 6 * 60 * 60;

function currentSeasonYear() {
  const now = new Date();
  const m = now.getMonth();
  let season;
  if (m < 3) season = "WINTER";
  else if (m < 6) season = "SPRING";
  else if (m < 9) season = "SUMMER";
  else season = "FALL";
  return { season, year: now.getFullYear() };
}

const QUERY = `
  query ($season: MediaSeason, $year: Int, $format: MediaFormat) {
    Page(page: 1) {
      media(
        season: $season,
        seasonYear: $year,
        format: $format,
        isAdult: false,
        type: ANIME,
        sort: TITLE_ROMAJI,
      ) {
        id idMal
        title { romaji native english }
        startDate { year month day }
        status season format description bannerImage
        coverImage { extraLarge color }
        airingSchedule(notYetAired: true, perPage: 1) {
          nodes { episode airingAt }
        }
      }
    }
  }
`;

const getUpcomingAnime = async () => {
  if (redis) {
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) return JSON.parse(cached);
    } catch {
      /* fall through */
    }
  }

  const { season, year } = currentSeasonYear();
  const json = await anilistFetch({
    query: QUERY,
    variables: { season, year, format: "TV" },
    label: "upcoming",
    cacheSeconds: 0, // we handle our own longer cache below
  });
  if (!json?.data?.Page?.media) return null;

  const currentSeasonAnime = json.data.Page.media;
  let nextAiringAnime = currentSeasonAnime.filter(
    (anime) => anime.airingSchedule.nodes?.[0]?.episode === 1
  );

  if (nextAiringAnime.length >= 1) {
    nextAiringAnime.sort(
      (a, b) =>
        a.airingSchedule.nodes?.[0].airingAt -
        b.airingSchedule.nodes?.[0].airingAt
    );
  } else {
    nextAiringAnime = null;
  }

  if (redis && nextAiringAnime) {
    try {
      await redis.set(CACHE_KEY, JSON.stringify(nextAiringAnime), "EX", TTL_SECONDS);
    } catch {
      /* non-fatal */
    }
  }

  return nextAiringAnime;
};

export default getUpcomingAnime;
