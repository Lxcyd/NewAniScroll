import { notify } from "@/lib/notifications/noticeStore";

export const useAniList = (session) => {
  const accessToken = session?.user?.token;

  const fetchGraphQL = async (query, variables) => {
    try {
      const response = await fetch("https://graphql.anilist.co/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
        },
        body: JSON.stringify({ query, variables }),
      });
      return response.json();
    } catch (error) {
      notify.error("An error occurred, please try again later");
    }
  };

  const quickSearch = async ({ search, type, isAdult = false }) => {
    if (!search || search === " ") return;
    const searchQuery = `
    query ($type: MediaType, $search: String, $isAdult: Boolean) {
  Page(perPage: 8) {
    pageInfo {
      total
      hasNextPage
    }
    results: media(type: $type, isAdult: $isAdult, search: $search) {
      id
      title {
        userPreferred
        english
        romaji
        native
      }
      coverImage {
        medium
      }
      type
      format
      bannerImage
      isLicensed
      genres
      startDate {
        year
      }
    }
  }
}   
    `;
    const data = await fetchGraphQL(searchQuery, { search, type, isAdult });
    return data;
  };

  const markComplete = async (mediaId, { notes, scoreRaw }) => {
    if (!accessToken) return;
    const completeQuery = `
      mutation($mediaId: Int, $notes: String, $scoreRaw: Int) {
        SaveMediaListEntry(mediaId: $mediaId, status: COMPLETED, scoreRaw: $scoreRaw, notes: $notes) {
          id
          mediaId
          status
        }
      }
    `;
    await fetchGraphQL(completeQuery, {
      mediaId,
      scoreRaw,
      notes,
    });
  };

  /* Toggle favourite for an anime. AniList exposes a single mutation
     `ToggleFavourite(animeId: Int)` that flips the boolean — no need
     to read the current state first. Returns the resulting payload
     so the caller can confirm the change went through. */
  const toggleFavourite = async (animeId) => {
    const mutation = `
      mutation ($animeId: Int) {
        ToggleFavourite(animeId: $animeId) {
          anime { nodes { id } }
        }
      }
    `;
    return fetchGraphQL(mutation, { animeId });
  };

  return {
    markComplete,
    quickSearch,
    toggleFavourite,
  };
};
