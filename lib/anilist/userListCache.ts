/**
 * Client-side cache of the signed-in user's whole AniList list.
 *
 * Instead of firing a per-anime AniList query every time an info page opens
 * (slow, and repeated for every anime the user browses), we fetch the entire
 * MediaListCollection ONCE per session and look entries up locally — O(1) map
 * read, no network. The info page and the list editor both read from here so
 * they're always consistent.
 *
 * Caching:
 *   - In-memory map (instant within the SPA session).
 *   - sessionStorage mirror (survives reloads / new tabs for a short TTL) so a
 *     hard refresh doesn't pay the full-list fetch again.
 *
 * The fetch is de-duplicated: concurrent callers share one in-flight promise.
 */

export type UserListEntry = {
  id: number; // mediaListEntry id (needed for DeleteMediaListEntry)
  mediaId: number;
  status: string | null; // CURRENT | PLANNING | COMPLETED | DROPPED | PAUSED | REPEATING
  score: number | null; // POINT_10_DECIMAL
  progress: number;
  repeat: number;
  private: boolean;
  hiddenFromStatusLists: boolean;
  notes: string | null;
  startedAt: { year: number | null; month: number | null; day: number | null } | null;
  completedAt: { year: number | null; month: number | null; day: number | null } | null;
  customLists: string[]; // names of custom lists this entry is on
};

type ListMap = Map<number, UserListEntry>;

const TTL_MS = 5 * 60 * 1000;
const SS_KEY = (userName: string) => `aniscroll.userList.${userName}`;

// Per-userName in-memory state.
const memCache = new Map<string, { map: ListMap; ts: number }>();
const inflight = new Map<string, Promise<ListMap>>();

function entriesToMap(entries: UserListEntry[]): ListMap {
  const m: ListMap = new Map();
  for (const e of entries) m.set(e.mediaId, e);
  return m;
}

function readSession(userName: string): { map: ListMap; ts: number } | null {
  try {
    const raw = sessionStorage.getItem(SS_KEY(userName));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.entries)) return null;
    return { map: entriesToMap(parsed.entries), ts: parsed.ts };
  } catch {
    return null;
  }
}

function writeSession(userName: string, entries: UserListEntry[]): void {
  try {
    sessionStorage.setItem(SS_KEY(userName), JSON.stringify({ entries, ts: Date.now() }));
  } catch {
    /* sessionStorage full / disabled — in-memory cache still works */
  }
}

const LIST_QUERY = `
  query ($userName: String) {
    MediaListCollection(userName: $userName, type: ANIME) {
      lists {
        entries {
          id
          mediaId
          status
          score(format: POINT_10_DECIMAL)
          progress
          repeat
          private
          hiddenFromStatusLists
          notes
          startedAt { year month day }
          completedAt { year month day }
          customLists
          media { id }
        }
      }
    }
  }
`;

/** Flatten AniList's grouped lists into one entry-per-media map (an entry can
 *  appear in several status groups; we keep the richest single record). */
function parseCollection(json: any): UserListEntry[] {
  const lists = json?.data?.MediaListCollection?.lists || [];
  const byMedia = new Map<number, UserListEntry>();
  for (const list of lists) {
    for (const e of list?.entries || []) {
      const mediaId = Number(e.mediaId ?? e.media?.id);
      if (!Number.isFinite(mediaId)) continue;
      // customLists comes back as an object { "Watch Soon": true, ... }; keep
      // only the enabled names.
      const cl = e.customLists && typeof e.customLists === "object"
        ? Object.entries(e.customLists)
            .filter(([, v]) => v === true)
            .map(([k]) => k)
        : [];
      byMedia.set(mediaId, {
        id: Number(e.id),
        mediaId,
        status: e.status ?? null,
        score: typeof e.score === "number" ? e.score : null,
        progress: Number(e.progress) || 0,
        repeat: Number(e.repeat) || 0,
        private: !!e.private,
        hiddenFromStatusLists: !!e.hiddenFromStatusLists,
        notes: e.notes || null,
        startedAt: e.startedAt || null,
        completedAt: e.completedAt || null,
        customLists: cl,
      });
    }
  }
  return Array.from(byMedia.values());
}

/**
 * Resolve the user's list map, using cache when fresh. `force` bypasses the
 * cache (used after a mutation to refresh). Never throws — returns an empty
 * map on failure so callers degrade to "nothing in list".
 */
export async function getUserList(
  userName: string,
  token: string,
  force = false,
): Promise<ListMap> {
  if (!userName || !token) return new Map();

  if (!force) {
    const mem = memCache.get(userName);
    if (mem && Date.now() - mem.ts < TTL_MS) return mem.map;
    const ss = readSession(userName);
    if (ss && Date.now() - ss.ts < TTL_MS) {
      memCache.set(userName, ss);
      return ss.map;
    }
    const pending = inflight.get(userName);
    if (pending) return pending;
  }

  const p = (async () => {
    try {
      const res = await fetch("https://graphql.anilist.co/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query: LIST_QUERY, variables: { userName } }),
      });
      if (!res.ok) return memCache.get(userName)?.map || new Map();
      const json = await res.json();
      const entries = parseCollection(json);
      const map = entriesToMap(entries);
      memCache.set(userName, { map, ts: Date.now() });
      writeSession(userName, entries);
      return map;
    } catch {
      return memCache.get(userName)?.map || new Map();
    } finally {
      inflight.delete(userName);
    }
  })();
  inflight.set(userName, p);
  return p;
}

/** Synchronous read of a single entry from whatever is cached (mem → session).
 *  Returns undefined when the list isn't cached yet or the anime isn't on it. */
export function peekListEntry(userName: string, aniId: number): UserListEntry | undefined {
  if (!userName) return undefined;
  const mem = memCache.get(userName);
  if (mem) return mem.map.get(aniId);
  const ss = readSession(userName);
  if (ss) {
    memCache.set(userName, ss);
    return ss.map.get(aniId);
  }
  return undefined;
}

/** True when we have a cached list for this user (so a missing entry reliably
 *  means "not in list" rather than "not loaded yet"). */
export function hasUserList(userName: string): boolean {
  if (!userName) return false;
  if (memCache.has(userName)) return true;
  const ss = readSession(userName);
  if (ss) {
    memCache.set(userName, ss);
    return true;
  }
  return false;
}

/** Apply a single entry update into the cache (after a save) so the next read
 *  is correct without re-fetching. Pass null to remove (after delete). */
export function patchListEntry(
  userName: string,
  aniId: number,
  entry: UserListEntry | null,
): void {
  if (!userName) return;
  const mem = memCache.get(userName);
  const map: ListMap = mem ? mem.map : (readSession(userName)?.map ?? new Map());
  if (entry) map.set(aniId, entry);
  else map.delete(aniId);
  memCache.set(userName, { map, ts: Date.now() });
  writeSession(userName, Array.from(map.values()));
}

/** Drop the cached list (e.g. on sign-out). */
export function clearUserList(userName: string): void {
  memCache.delete(userName);
  inflight.delete(userName);
  try {
    sessionStorage.removeItem(SS_KEY(userName));
  } catch {}
}
