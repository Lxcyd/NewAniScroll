/**
 * Client side of the same chain the server runs for a public profile: rank the
 * list, ask /api/v2/profile-banner for the winner's artwork.
 *
 * /en/profile/me has no SSR at all — the list it shows lives in this browser
 * and is never sent anywhere — so the whole resolution happens here. The
 * endpoint is shared and edge-cached, and the responses are memoised for the
 * page's lifetime, so the tie-break lookups cost one request per anime at most.
 *
 * A manual pick is kept in localStorage next to the list it dresses. That is
 * the guest's only storage, and for an account it rides the normal `prefs`
 * cloud backup (lib/list/cloudSync.ts) like every other aniscroll:* key.
 */

import { useEffect, useState } from "react";
import { pickFavorite, tiedHead, type FavoriteCandidate } from "./favorite";
import type { ProfileEntry } from "./types";

export type ResolvedBanner = {
  url: string | null;
  animeId: number | null;
  title: string | null;
  fallback?: boolean;
};

export const PINNED_KEY = "aniscroll:profileBanner";

export function readPinnedBanner(): ResolvedBanner | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PINNED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.url ? parsed : null;
  } catch {
    return null;
  }
}

export function writePinnedBanner(value: ResolvedBanner | null): void {
  try {
    if (value) window.localStorage.setItem(PINNED_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(PINNED_KEY);
  } catch {
    /* private mode / quota — the plate still swaps for this session */
  }
}

const MEMO = new Map<number, any>();

async function bannerFor(animeId: number): Promise<any | null> {
  if (MEMO.has(animeId)) return MEMO.get(animeId);
  try {
    const res = await fetch(`/api/v2/profile-banner?anime=${animeId}`);
    if (!res.ok) return null;
    const json = await res.json();
    MEMO.set(animeId, json);
    return json;
  } catch {
    return null;
  }
}

export function candidatesOf(entries: ProfileEntry[]): FavoriteCandidate[] {
  return entries.map((e) => ({
    mediaId: e.mediaId,
    score: e.score,
    favourite: !!e.favourite,
    repeat: e.repeat || 0,
    meanScore: null,
  }));
}

/**
 * The plate for a locally-held list. Returns null while nothing is resolved
 * yet (and for an empty list, which is exactly the "site colour" case).
 */
export function useProfileBanner(entries: ProfileEntry[]): ResolvedBanner | null {
  const [banner, setBanner] = useState<ResolvedBanner | null>(null);

  useEffect(() => {
    let alive = true;
    if (entries.length === 0) {
      setBanner(null);
      return;
    }

    (async () => {
      const candidates = candidatesOf(entries);
      // Criterion 4 (the anime's own average) only where the first three tie.
      const tied = tiedHead(candidates);
      if (tied.length > 1) {
        await Promise.all(
          tied.map(async (c) => {
            const json = await bannerFor(c.mediaId);
            c.meanScore = json?.meanScore ?? null;
          }),
        );
      }
      const favorite = pickFavorite(candidates);
      if (!favorite) return;
      const json = await bannerFor(favorite.mediaId);
      if (!alive || !json?.banner?.url) return;
      setBanner({
        url: json.banner.url,
        animeId: favorite.mediaId,
        title: json.title ?? null,
        fallback: !!json.banner.fallback,
      });
    })();

    return () => {
      alive = false;
    };
  }, [entries]);

  return banner;
}
