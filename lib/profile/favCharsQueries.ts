/**
 * Les requêtes AniList des personnages favoris, à part : sans dépendance, pour
 * que tools/ puisse les envoyer telles quelles à AniList et vérifier qu'elles
 * passent son schéma (cf. favChars.ts).
 */

export const CHAR_NODE = `id name { full } image { large }
  media(perPage: 1, sort: POPULARITY_DESC) { nodes { title { english romaji } } }`;

/** Une page de favoris. Une requête PAR page : quatre pages aliasées avec
 *  leur `media` dépassaient la complexité qu'AniList accepte. */
export const LIVE_FAVS = `query ($page: Int) { Viewer { favourites {
  characters(perPage: 25, page: $page) { pageInfo { hasNextPage } nodes { ${CHAR_NODE} } }
} } }`;

export const SEARCH = `query ($q: String) { Page(perPage: 24) {
  characters(search: $q, sort: [SEARCH_MATCH, FAVOURITES_DESC]) { ${CHAR_NODE} }
} }`;

/** Le mode « Anime » de la recherche : la requête du studio (BannerStudio). */
export const SEARCH_ANIME = `query ($search: String) { Page(perPage: 12) {
  media(search: $search, type: ANIME, sort: SEARCH_MATCH, isAdult: false) {
    id title { userPreferred english romaji } coverImage { medium large }
  }
} }`;

export const TOGGLE = `mutation ($id: Int) { ToggleFavourite(characterId: $id) { characters { pageInfo { total } } } }`;

export const ORDER = `mutation ($ids: [Int], $order: [Int]) {
  UpdateFavouriteOrder(characterIds: $ids, characterOrder: $order) { characters { pageInfo { total } } }
}`;
