import { advanceSearchQuery } from "../graphql/query";
import { anilistFetch } from "./anilistFetch";
import { advanceSearchVars, type AniAdvanceSearch } from "./advanceSearchVars";

export type { AniAdvanceSearch };

export async function aniAdvanceSearch(args: AniAdvanceSearch) {
  const datas = await anilistFetch({
    query: advanceSearchQuery,
    variables: advanceSearchVars(args),
    // Search results change with every keystroke — short cache only.
    cacheSeconds: 30,
    // The search route answers from the edge for 10 min; a 30 s Redis copy
    // behind it only cost a SET per unique query. Failure marks still apply.
    cacheSuccess: false,
    label: "advanceSearch",
  });
  return datas?.data?.Page ?? null;
}
