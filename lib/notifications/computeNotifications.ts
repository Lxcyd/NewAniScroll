/**
 * In-app notifications — computed on demand from the LOCAL list plus AniList's
 * airing schedule. No service worker / web push: these surface in the NavBar
 * bell while the app is open and recompute on load.
 *
 * Two kinds:
 *  - "new-episode": a CURRENT anime has aired episodes beyond your progress.
 *  - "resume":      a CURRENT/PAUSED anime you haven't touched in a long while.
 *
 * The new-episode kind needs the latest aired episode per anime, which the
 * local list doesn't store — so we batch-query AniList for the CURRENT entries'
 * `nextAiringEpisode`. The resume kind is purely local (uses `activityAt`).
 */

import { getLocalList, LocalEntry } from "@/lib/list/localList";
import { pickTitle, type TitlePref } from "@/lib/prefs/titlePref";

const ENDPOINT = "https://graphql.anilist.co/";

export type NotificationKind = "new-episode" | "resume";

export type AppNotification = {
  /** Stable id: kind + mediaId + the salient number, so "read" state sticks
   *  until the situation changes (e.g. a newer episode bumps the id). */
  id: string;
  kind: NotificationKind;
  mediaId: number;
  title: string;
  coverImage: string | null;
  /** Latest aired episode (new-episode) — drives the body copy. */
  episode?: number;
  /** How many unwatched aired episodes (new-episode). */
  count?: number;
  /** Days since last activity (resume). */
  days?: number;
  /** Sort key — most relevant first. */
  sortAt: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function localTitle(e: LocalEntry, titlePref: TitlePref): string {
  return pickTitle(e.title ?? null, titlePref);
}

// Module-level cache so navigating between pages (each remounts the NavBar
// bell) doesn't re-hit AniList every time. Keyed by the sorted id set; 15-min
// TTL — airing data changes at most a few times a day.
const AIRING_TTL_MS = 15 * 60 * 1000;
let airingCache: {
  key: string;
  at: number;
  data: Map<number, { lastAired: number | null }>;
} | null = null;

/** Batch-fetch latest-aired-episode info for the given media ids. */
async function fetchAiring(
  ids: number[],
): Promise<Map<number, { lastAired: number | null }>> {
  const out = new Map<number, { lastAired: number | null }>();
  if (ids.length === 0) return out;
  const key = Array.from(ids).sort((a, b) => a - b).join(",");
  if (airingCache && airingCache.key === key && Date.now() - airingCache.at < AIRING_TTL_MS) {
    return airingCache.data;
  }
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query ($ids: [Int]) {
          Page(perPage: 50) {
            media(id_in: $ids, type: ANIME) {
              id episodes nextAiringEpisode { episode }
            }
          }
        }`,
        variables: { ids: ids.slice(0, 50) },
      }),
    });
    if (!res.ok) return out;
    const json = await res.json();
    const media = json?.data?.Page?.media || [];
    for (const m of media) {
      const id = Number(m?.id);
      if (!Number.isFinite(id)) continue;
      // Last aired episode = (next airing episode − 1) for releasing shows, or
      // the full `episodes` count once finished. null when truly unknown.
      const lastAired =
        typeof m?.nextAiringEpisode?.episode === "number"
          ? m.nextAiringEpisode.episode - 1
          : typeof m?.episodes === "number"
            ? m.episodes
            : null;
      out.set(id, { lastAired });
    }
    // Only cache a real (successful) response so a transient failure isn't
    // remembered for 15 min.
    airingCache = { key, at: Date.now(), data: out };
  } catch {
    /* offline / AniList down — new-episode notifs just won't appear */
  }
  return out;
}

export type ComputeOpts = {
  titlePref: TitlePref;
  /** Inactivity (days) after which a CURRENT/PAUSED entry suggests resuming. */
  resumeAfterDays: number;
};

/**
 * Compute the current notification set. Async because the new-episode kind hits
 * AniList; the resume kind is synchronous-local but folded in here so callers
 * get one list.
 */
export async function computeNotifications(
  opts: ComputeOpts,
): Promise<AppNotification[]> {
  const { titlePref, resumeAfterDays } = opts;
  const list = Object.values(getLocalList());
  const now = Date.now();
  const notes: AppNotification[] = [];

  // ── New episodes (CURRENT entries) ──────────────────────────────
  const current = list.filter((e) => e.status === "CURRENT");
  const airing = await fetchAiring(current.map((e) => e.mediaId));
  for (const e of current) {
    const info = airing.get(e.mediaId);
    const lastAired = info?.lastAired ?? null;
    if (lastAired == null) continue;
    const behind = lastAired - (e.progress ?? 0);
    if (behind <= 0) continue;
    notes.push({
      id: `new-episode:${e.mediaId}:${lastAired}`,
      kind: "new-episode",
      mediaId: e.mediaId,
      title: localTitle(e, titlePref),
      coverImage: e.coverImage ?? null,
      episode: lastAired,
      count: behind,
      sortAt: now, // freshest concern — sort to the top
    });
  }

  // ── Resume reminders (stale CURRENT/PAUSED) ─────────────────────
  const cutoff = now - resumeAfterDays * DAY_MS;
  for (const e of list) {
    if (e.status !== "PAUSED" && e.status !== "CURRENT") continue;
    const last = e.activityAt ?? e.updatedAt;
    if (last >= cutoff) continue;
    // Don't double-notify: if this CURRENT anime already has a new-episode
    // notification, that's the more actionable one.
    if (notes.some((n) => n.kind === "new-episode" && n.mediaId === e.mediaId))
      continue;
    notes.push({
      id: `resume:${e.mediaId}`,
      kind: "resume",
      mediaId: e.mediaId,
      title: localTitle(e, titlePref),
      coverImage: e.coverImage ?? null,
      days: Math.floor((now - last) / DAY_MS),
      sortAt: last, // older inactivity sorts after fresh new-episode alerts
    });
  }

  return notes.sort((a, b) => b.sortAt - a.sortAt);
}
