import type { TFunction } from "i18next";

/**
 * Home-page carousels identify themselves with an English string (`section`)
 * that doubles as both a routing key (see content.tsx `goToPage`) and the
 * displayed heading. Rather than refactor every call site to split key vs
 * label, we keep the English string as the stable key and translate only its
 * display here.
 *
 * Unknown sections fall through to the raw string so a new carousel never
 * renders blank if its translation is missing.
 */
const SECTION_KEY: Record<string, string> = {
  "Recently Watched": "home.recentlyWatched",
  "New Episodes": "home.newEpisodes",
  "Trending Now": "home.trendingNow",
  "Popular Anime": "home.popularAnime",
  "This Season": "home.thisSeason",
  "Popular Movies": "home.popularMovies",
  "Your Plan": "home.yourPlan",
  "Your List": "home.yourList",
  "Your Watch List": "home.yourWatchList",
  "On-Going Anime": "home.onGoingAnime",
  Recommendations: "home.recommendations",
  "Freshly Added": "home.freshlyAdded",
  "Continue Watching": "home.continueWatching",
};

/** Translate a home `section` string for display. */
export function sectionLabel(t: TFunction, section?: string): string {
  if (!section) return "";
  const key = SECTION_KEY[section];
  return key ? t(key) : section;
}
