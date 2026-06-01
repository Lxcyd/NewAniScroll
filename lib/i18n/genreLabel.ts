import type { TFunction } from "i18next";

/**
 * AniList exposes genres as fixed English strings. They double as filter keys
 * (the search route sends the English name verbatim), so we keep the English
 * value as the key and only translate the display here.
 *
 * Unknown genres fall through to the raw string so a new AniList genre never
 * renders blank.
 */
const GENRE_KEY: Record<string, string> = {
  Action: "genres.action",
  Adventure: "genres.adventure",
  Comedy: "genres.comedy",
  Drama: "genres.drama",
  Ecchi: "genres.ecchi",
  Fantasy: "genres.fantasy",
  Horror: "genres.horror",
  "Mahou Shoujo": "genres.mahouShoujo",
  Mecha: "genres.mecha",
  Music: "genres.music",
  Mystery: "genres.mystery",
  Psychological: "genres.psychological",
  Romance: "genres.romance",
  "Sci-Fi": "genres.sciFi",
  "Slice of Life": "genres.sliceOfLife",
  Sports: "genres.sports",
  Supernatural: "genres.supernatural",
  Thriller: "genres.thriller",
  Hentai: "genres.hentai",
};

export function genreLabel(t: TFunction, genre: string): string {
  const key = GENRE_KEY[genre];
  return key ? t(key) : genre;
}
