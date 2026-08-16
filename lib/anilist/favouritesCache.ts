/**
 * Client-side cache of the signed-in user's AniList favourites (anime only).
 *
 * Same reasoning as lib/anilist/userListCache.ts, for the same reason the hover
 * preview needs it: the heart on a preview card has to be correct the instant
 * the card appears, and the card appears ~30 ms after the pointer touches a
 * poster. Querying `Media(id) { isFavourite }` per hover — which is what the
 * info page does for its single title — would mean an AniList round-trip every
 * time the mouse crosses a carousel, and AniList rate-limits by IP.
 *
 * So we pull the whole favourites list ONCE per session (a couple of paginated
 * calls, ids only) and answer from a Set. Toggling writes through optimistically
 * and fires an event so every mounted heart updates at once.
 */

import { useEffect, useState } from "react";

const TTL_MS = 5 * 60 * 1000;
const SS_KEY = "aniscroll.favourites";
export const FAVOURITES_EVENT = "aniscroll:favourites:change";

const ANILIST = "https://graphql.anilist.co/";

const LIST_QUERY = `
  query ($page: Int) {
    Viewer {
      favourites {
        anime(page: $page) {
          pageInfo { hasNextPage }
          nodes { id }
        }
      }
    }
  }
`;

const TOGGLE_MUTATION = `
  mutation ($animeId: Int) {
    ToggleFavourite(animeId: $animeId) { anime { nodes { id } } }
  }
`;

let ids: Set<number> | null = null;
let loadedAt = 0;
let inFlight: Promise<Set<number>> | null = null;

function announce() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FAVOURITES_EVENT));
}

function readSession(): { ids: number[]; ts: number } | null {
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.ids) ? parsed : null;
  } catch {
    return null;
  }
}

function writeSession(set: Set<number>): void {
  try {
    // Array.from, not spread: the project targets ES5 downlevel.
    sessionStorage.setItem(SS_KEY, JSON.stringify({ ids: Array.from(set), ts: Date.now() }));
  } catch {
    /* full / disabled — the in-memory Set still works */
  }
}

async function anilist(token: string, query: string, variables: Record<string, unknown>) {
  const res = await fetch(ANILIST, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

/** Load (or reuse) the favourites Set. Concurrent callers share one fetch. */
export function loadFavourites(token: string): Promise<Set<number>> {
  if (ids && Date.now() - loadedAt < TTL_MS) return Promise.resolve(ids);
  if (inFlight) return inFlight;

  const fromSession = readSession();
  if (fromSession && Date.now() - fromSession.ts < TTL_MS) {
    ids = new Set(fromSession.ids);
    loadedAt = fromSession.ts;
    announce();
    return Promise.resolve(ids);
  }

  inFlight = (async () => {
    const set = new Set<number>();
    try {
      // Favourites are paginated at 25; a big list is a handful of calls, once.
      for (let page = 1; page <= 20; page++) {
        const json = await anilist(token, LIST_QUERY, { page });
        const block = json?.data?.Viewer?.favourites?.anime;
        for (const n of block?.nodes ?? []) if (n?.id) set.add(Number(n.id));
        if (!block?.pageInfo?.hasNextPage) break;
      }
      ids = set;
      loadedAt = Date.now();
      writeSession(set);
    } catch {
      // Leave `ids` null so the next mount retries rather than showing every
      // heart as empty forever.
    } finally {
      inFlight = null;
    }
    announce();
    return ids ?? set;
  })();

  return inFlight;
}

/** Synchronous read. `false` while the list hasn't loaded yet. */
export function isFavourite(mediaId: number): boolean {
  return ids?.has(mediaId) ?? false;
}

/**
 * Flip the favourite state. Optimistic: the heart fills immediately and reverts
 * only if AniList rejects the mutation.
 */
export async function toggleFavourite(mediaId: number, token: string): Promise<boolean> {
  const set = ids ?? new Set<number>();
  ids = set;
  const next = !set.has(mediaId);
  if (next) set.add(mediaId);
  else set.delete(mediaId);
  writeSession(set);
  announce();

  try {
    const json = await anilist(token, TOGGLE_MUTATION, { animeId: mediaId });
    if (json?.errors?.length) throw new Error("rejected");
  } catch {
    if (next) set.delete(mediaId);
    else set.add(mediaId);
    writeSession(set);
    announce();
    return !next;
  }
  return next;
}

/**
 * Reactive "is this favourited", loading the whole list on first use. Passing a
 * null token (signed out) leaves it permanently false.
 */
export function useIsFavourite(mediaId: number, token: string | null): boolean {
  const [fav, setFav] = useState(() => isFavourite(mediaId));

  useEffect(() => {
    const read = () => setFav(isFavourite(mediaId));
    read();
    window.addEventListener(FAVOURITES_EVENT, read);
    if (token) void loadFavourites(token).then(read);
    return () => window.removeEventListener(FAVOURITES_EVENT, read);
  }, [mediaId, token]);

  return fav;
}
