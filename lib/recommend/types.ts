/**
 * Types for the "For You" recommendation engine.
 *
 * The engine analyses the signed-in user's AniList list (scores, progress,
 * watch speed, repeats, status) to build a taste profile, then scores candidate
 * anime against it. All metadata comes from AniList's public GraphQL API.
 */

/** One AniList list entry, the subset the engine reasons over. */
export type ListEntry = {
  mediaId: number;
  status: string | null; // CURRENT|PLANNING|COMPLETED|DROPPED|PAUSED|REPEATING
  score: number | null; // 0–10 (POINT_10_DECIMAL); 0/null = unscored
  progress: number;
  repeat: number;
  startedAt: { year: number | null; month: number | null; day: number | null } | null;
  completedAt: { year: number | null; month: number | null; day: number | null } | null;
};

/** Per-anime metadata fetched from AniList, used both to profile the user's
 *  watched anime and to score candidates. */
export type AnimeMeta = {
  id: number;
  title: { romaji?: string; english?: string; native?: string; userPreferred?: string };
  coverImage?: { extraLarge?: string; large?: string; color?: string };
  bannerImage?: string | null;
  description?: string | null;
  genres: string[];
  tags: { name: string; rank: number; category?: string; isMediaSpoiler?: boolean }[];
  studios: string[]; // main studios
  format: string | null;
  episodes: number | null;
  duration: number | null;
  averageScore: number | null; // 0–100
  popularity: number | null;
  seasonYear: number | null;
  season: string | null;
  status: string | null;
  recommendations: number[]; // mediaIds the community recommends from this anime
};

/** The aggregated taste profile derived from the user's list. */
export type TasteProfile = {
  /** affinity weight per genre (can be negative for disliked) */
  genres: Record<string, number>;
  /** affinity weight per tag name (rank-weighted) */
  tags: Record<string, number>;
  /** affinity weight per main studio */
  studios: Record<string, number>;
  /** affinity weight per format (TV, MOVIE, OVA…) */
  formats: Record<string, number>;
  /** affinity weight per release decade (e.g. "2010s") */
  decades: Record<string, number>;
  /** mean user score across scored entries (for normalising) */
  meanScore: number;
  /** how niche the user leans: avg popularity of loved anime (lower = niche) */
  nicheLean: number;
  /** count of scored/affinity-bearing entries (confidence) */
  sampleSize: number;
};

/** A scored recommendation with its human-readable reasons. */
export type Recommendation = {
  anime: AnimeMeta;
  score: number;
  /** structured reason keys + values, turned into prose client-side */
  reasons: RecReason[];
};

export type RecReason =
  | { kind: "lovedSimilar"; titles: string[] } // "because you loved X and Y"
  | { kind: "studio"; studio: string } // same favourite studio
  | { kind: "genres"; genres: string[] } // matches favourite genres
  | { kind: "tags"; tags: string[] } // matches favourite tags
  | { kind: "sequel"; ofTitle: string } // direct sequel of a loved anime
  | { kind: "binge" } // matches your fast-binge action profile etc.
  | { kind: "highlyRated"; score: number } // community score
  | { kind: "community" }; // AniList community recommendation

export type RecommendMode = "all" | "planning";

export type RecommendResponse = {
  recommendations: Recommendation[];
  /** echo of the profile summary, for a "your taste" blurb if wanted */
  profileSummary: {
    topGenres: string[];
    topStudios: string[];
    sampleSize: number;
  };
};
