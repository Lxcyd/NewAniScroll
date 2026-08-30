/**
 * Normalisers: every list source in, one ProfileEntry[] out.
 *
 * Isomorphic on purpose — no database, no fetch. The public profile calls these
 * from getServerSideProps (AniList, or an account's cloud backup) and
 * /en/profile/me calls the local one straight from localStorage, so the three
 * routes cannot drift into showing different things.
 */

import type { LocalEntry, LocalListMap } from "@/lib/list/localList";
import type { ProfileEntry, ProfileStats } from "./types";

/** AniList's MediaListCollection.lists → flat, de-duplicated entries. */
export function entriesFromAniList(
  lists: any[] | null | undefined,
  favouriteIds: Set<number>,
): ProfileEntry[] {
  const seen = new Set<number>();
  const out: ProfileEntry[] = [];
  for (const list of lists || []) {
    for (const e of list?.entries || []) {
      const mediaId = e.mediaId ?? e.media?.id;
      // A status can be split across custom lists, so the same entry shows up
      // more than once: the first occurrence wins.
      if (!mediaId || seen.has(mediaId)) continue;
      seen.add(mediaId);
      out.push({
        mediaId,
        status: e.status || list.status || "PLANNING",
        progress: e.progress || 0,
        score: e.score || null,
        total: e.media?.episodes ?? null,
        title: e.media?.title ?? null,
        cover: e.media?.coverImage?.large ?? null,
        favourite: favouriteIds.has(mediaId),
        repeat: e.repeat || 0,
      });
    }
  }
  return out;
}

/** The localStorage list (own device, or an account's cloud backup of it). */
export function entriesFromLocalList(map: LocalListMap): ProfileEntry[] {
  return entriesFromLocalEntries(Object.values(map || {}));
}

/** Same, for callers that already hold the array (`useLocalList`). */
export function entriesFromLocalEntries(list: LocalEntry[]): ProfileEntry[] {
  return (list || [])
    .filter((e): e is LocalEntry => !!e && typeof e.mediaId === "number")
    .map((e) => ({
      mediaId: e.mediaId,
      status: e.status || "PLANNING",
      progress: e.progress || 0,
      score: e.score ?? null,
      total: e.total ?? null,
      title: e.title ?? null,
      cover: e.coverImage ?? null,
      // No local favourites store exists yet (see lib/list/cloudSync.ts): the
      // criterion simply never fires, it does not misfire.
      favourite: false,
      repeat: e.repeat || 0,
    }));
}

/**
 * The cloud backup stores raw localStorage strings keyed by their storage key,
 * so the list category has to be unwrapped and re-parsed.
 */
export function localListFromCloudPayload(payload: unknown): LocalListMap {
  const raw = (payload as any)?.["aniscroll:localList"];
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as LocalListMap) : {};
  } catch {
    return {};
  }
}

/** Numbers a profile can always compute from its own entries. */
export function statsFromEntries(entries: ProfileEntry[]): ProfileStats {
  const rated = entries.filter((e) => e.score != null);
  return {
    count: entries.length,
    episodes: entries.reduce((n, e) => n + (e.progress || 0), 0),
    minutes: null,
    meanScore: rated.length
      ? Math.round((rated.reduce((n, e) => n + (e.score || 0), 0) / rated.length) * 10) /
        10
      : null,
  };
}

/** Minutes → "3.4" days, or hours below a day. Same shape the page had. */
export function watchTime(minutes: number): { days?: string; hours?: string } {
  const hours = minutes / 60;
  const days = hours / 24;
  const fmt = (n: number) => (n % 1 === 0 ? String(n) : n.toFixed(1));
  return days >= 1 ? { days: fmt(days) } : { hours: fmt(hours) };
}
