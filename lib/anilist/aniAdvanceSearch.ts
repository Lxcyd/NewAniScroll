import { advanceSearchQuery } from "../graphql/query";
import { anilistFetch } from "./anilistFetch";

export type AniAdvanceSearch = {
  search?: string;
  type?: string;
  genres?: any[];
  page?: number;
  sort?: string;
  format?:
    | "TV"
    | "TV_SHORT"
    | "MOVIE"
    | "SPECIAL"
    | "OVA"
    | "ONA"
    | "MUSIC"
    | undefined;
  season?: string;
  seasonYear?: number;
  perPage?: number;
};

export async function aniAdvanceSearch({
  search,
  type = "ANIME",
  genres,
  page,
  sort,
  format,
  season,
  seasonYear,
  perPage,
}: AniAdvanceSearch) {
  const categorizedGenres = genres?.reduce((result, item) => {
    const existingEntry = result[item.type];

    if (existingEntry) {
      existingEntry.push(item.value);
    } else {
      result[item.type] = [item.value];
    }

    return result;
  }, {});

  const datas = await anilistFetch({
    query: advanceSearchQuery,
    variables: {
      ...(search && {
        search: search,
        ...(!sort && { sort: "SEARCH_MATCH" }),
      }),
      ...(type && { type: type }),
      ...(seasonYear && { seasonYear: seasonYear }),
      ...(season && {
        season: season,
        ...(!seasonYear && { seasonYear: new Date().getFullYear() }),
      }),
      ...(categorizedGenres && { ...categorizedGenres }),
      ...(format && { format: format }),
      ...(perPage && { perPage: perPage }),
      ...(sort && { sort: sort }),
      ...(page && { page: page }),
    },
    // Search results change with every keystroke — short cache only.
    cacheSeconds: 30,
    label: "advanceSearch",
  });
  return datas?.data?.Page ?? null;
}
