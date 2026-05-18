export interface AniListInfoTypes {
  mediaListEntry: MediaListEntry | null;
  id: number;
  idMal: number | null;
  type: string;
  format: string;
  title: Title;
  coverImage: CoverImage;
  startDate: FuzzyDate;
  endDate: FuzzyDate | null;
  bannerImage: string | null;
  description: string;
  episodes: number | null;
  nextAiringEpisode: NextAiringEpisode | null;
  averageScore: number | null;
  meanScore: number | null;
  popularity: number | null;
  favourites: number | null;
  status: string;
  genres: string[];
  season: string | null;
  seasonYear: number | null;
  duration: number | null;
  source: string | null;
  countryOfOrigin: string | null;
  isAdult: boolean;
  synonyms: string[] | null;
  siteUrl: string | null;
  hashtag: string | null;
  trailer: Trailer | null;
  tags: Tag[] | null;
  externalLinks: ExternalLink[] | null;
  rankings: Ranking[] | null;
  studios: Studios;
  relations: Relations;
  recommendations: Recommendations;
  characters: Characters;
}

export interface Studios {
  edges: Studio[];
}

export interface Studio {
  isMain: boolean;
  node: StudioNode;
}

export interface StudioNode {
  id: number;
  name: string;
  siteUrl?: string | null;
}

export interface MediaListEntry {
  status: string;
  progress: number;
  progressVolumes: number;
}

export interface Title {
  romaji: string;
  english: string | null;
  native: string | null;
}

export interface CoverImage {
  extraLarge: string;
  large: string;
  color: string | null;
}

export interface FuzzyDate {
  year: number | null;
  month: number | null;
  day?: number | null;
}

export interface NextAiringEpisode {
  episode: number;
  airingAt: number;
  timeUntilAiring: number;
}

export interface Trailer {
  id: string | null;
  site: string | null;
  thumbnail: string | null;
}

export interface Tag {
  id: number;
  name: string;
  description?: string | null;
  rank: number | null;
  isMediaSpoiler: boolean;
  isGeneralSpoiler?: boolean;
  category?: string | null;
}

export interface ExternalLink {
  id: number;
  site: string;
  url: string;
  type?: string | null;
  icon?: string | null;
  color?: string | null;
  language?: string | null;
}

export interface Ranking {
  id: number;
  rank: number;
  type: string;
  format?: string | null;
  season?: string | null;
  year?: number | null;
  allTime: boolean;
  context: string;
}

export interface Relations {
  edges: Edge[];
}

export interface Edge {
  id: number;
  relationType: string;
  node: Node;
}

export interface Node {
  id: number;
  title: Title2;
  format: string;
  type: string;
  status: string;
  episodes?: number | null;
  seasonYear?: number | null;
  bannerImage?: string | null;
  coverImage: CoverImage2;
}

export interface Title2 {
  userPreferred: string;
  romaji?: string | null;
  english?: string | null;
}

export interface CoverImage2 {
  extraLarge: string;
  large?: string;
  color: string | null;
}

export interface Recommendations {
  nodes: Node2[];
}

export interface Node2 {
  mediaRecommendation: MediaRecommendation | null;
}

export interface MediaRecommendation {
  id: number;
  title: Title3;
  seasonYear?: number | null;
  averageScore?: number | null;
  coverImage: CoverImage3;
}

export interface Title3 {
  romaji: string;
  english?: string | null;
}

export interface CoverImage3 {
  extraLarge: string;
  large: string;
  color?: string | null;
}

export interface Characters {
  edges: Edge2[];
}

export interface Edge2 {
  role: string;
  node: Node3;
  voiceActors?: VoiceActor[];
}

export interface Node3 {
  id: number;
  image: Image;
  name: Name;
}

export interface Image {
  large: string;
  medium: string;
}

export interface Name {
  full: string;
  userPreferred: string;
}

export interface VoiceActor {
  id: number;
  name: Name;
  image?: { medium: string };
}
