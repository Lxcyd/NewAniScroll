/**
 * Builds the GraphQL variables of `advanceSearchQuery`. Pure, no server import:
 * the search page runs it in the browser to query AniList directly, and
 * `aniAdvanceSearch` runs it on the server.
 */
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
  /** Adulte inclus : `isAdult: null` (AniList rend alors les deux ; `true`
   *  ne rendrait QUE l'adulte). Absent : la requete garde son `false`. */
  adult?: boolean;
};

export function advanceSearchVars({
  search,
  type = "ANIME",
  genres,
  page,
  sort,
  format,
  season,
  seasonYear,
  perPage,
  adult,
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

  return {
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
    ...(adult && { isAdult: null }),
  };
}
