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
  data: Map<number, AiringInfo>;
} | null = null;

type AiringInfo = { lastAired: number | null; releasing: boolean };

/** Batch-fetch airing status + latest-aired-episode for the given media ids. */
async function fetchAiring(ids: number[]): Promise<Map<number, AiringInfo>> {
  const out = new Map<number, AiringInfo>();
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
              id status episodes nextAiringEpisode { episode }
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
      out.set(id, { lastAired, releasing: m?.status === "RELEASING" });
    }
    // Only cache a real (successful) response so a transient failure isn't
    // remembered for 15 min.
    airingCache = { key, at: Date.now(), data: out };
  } catch {
    /* offline / AniList down — new-episode notifs just won't appear */
  }
  return out;
}

/** Batch-fetch genres + tag names for the given media ids (themes for the
 *  resume recommender). Cached like airing. */
type Themes = { genres: string[]; tags: string[] };
const themesCache = new Map<number, Themes>();

async function fetchThemes(ids: number[]): Promise<Map<number, Themes>> {
  const out = new Map<number, Themes>();
  const missing = ids.filter((id) => !themesCache.has(id));
  if (missing.length === 0) {
    ids.forEach((id) => out.set(id, themesCache.get(id)!));
    return out;
  }
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query ($ids: [Int]) {
          Page(perPage: 50) {
            media(id_in: $ids, type: ANIME) {
              id genres tags { name }
            }
          }
        }`,
        variables: { ids: missing.slice(0, 50) },
      }),
    });
    if (res.ok) {
      const json = await res.json();
      const media = json?.data?.Page?.media || [];
      for (const m of media) {
        const id = Number(m?.id);
        if (!Number.isFinite(id)) continue;
        themesCache.set(id, {
          genres: Array.isArray(m?.genres) ? m.genres : [],
          tags: Array.isArray(m?.tags)
            ? m.tags.map((tg: any) => tg?.name).filter(Boolean)
            : [],
        });
      }
    }
  } catch {
    /* offline — recommender just falls back to "most recently dropped" */
  }
  // Fill in anything still missing (failed fetch) with empties so callers get
  // a value and we don't re-query it forever.
  ids.forEach((id) => out.set(id, themesCache.get(id) ?? { genres: [], tags: [] }));
  return out;
}

/** Overlap score between two theme sets — genres weighted heavier than tags. */
function themeOverlap(a: Themes, b: Themes): number {
  const gb = new Set(b.genres);
  const tb = new Set(b.tags);
  let score = 0;
  for (const g of a.genres) if (gb.has(g)) score += 2;
  for (const tg of a.tags) if (tb.has(tg)) score += 1;
  return score;
}

// Resume-reminder pacing: pick a new one at most every 3 days, but keep showing
// the CURRENT pick for that whole window (so it doesn't vanish on the next page
// load). We persist the chosen { mediaId, at } in localStorage.
const RESUME_GATE_KEY = "aniscroll:resumeReminder";
const RESUME_INTERVAL_MS = 3 * DAY_MS;
// "Not touched in a while" = at least one month.
const RESUME_STALE_DAYS = 30;
// "Recently watching" window used to theme-match the recommendation.
const RECENT_WINDOW_DAYS = 30;

type ResumePick = { mediaId: number; at: number };

function readResumePick(): ResumePick | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(RESUME_GATE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return Number.isFinite(p?.mediaId) && Number.isFinite(p?.at) ? p : null;
  } catch {
    return null;
  }
}

function writeResumePick(pick: ResumePick): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RESUME_GATE_KEY, JSON.stringify(pick));
  } catch {
    /* best-effort */
  }
}

export type ComputeOpts = {
  titlePref: TitlePref;
};

/**
 * Compute the current notification set. Async because the new-episode kind hits
 * AniList; the resume kind is synchronous-local but folded in here so callers
 * get one list.
 */
export async function computeNotifications(
  opts: ComputeOpts,
): Promise<AppNotification[]> {
  const { titlePref } = opts;
  const list = Object.values(getLocalList());
  const now = Date.now();
  const notes: AppNotification[] = [];

  // ── New episodes (CURRENT entries) ──────────────────────────────
  const current = list.filter((e) => e.status === "CURRENT");
  const airing = await fetchAiring(current.map((e) => e.mediaId));
  for (const e of current) {
    const info = airing.get(e.mediaId);
    // Only notify for shows still RELEASING — a finished show you're behind on
    // isn't "a new episode dropped", it's just unwatched backlog.
    if (!info?.releasing) continue;
    const lastAired = info.lastAired ?? null;
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

  // ── Resume recommendation (paced, theme-matched) ────────────────
  // Nudge the user to pick back up ONE anime they paused / stalled on a while
  // ago — biased toward something thematically close to what they've watched
  // lately (genres weighted over tags). We pick a fresh one at most every 3
  // days, but keep showing the current pick for that whole window.
  const lastActivity = (e: LocalEntry) => e.activityAt ?? e.updatedAt;
  const staleCutoff = now - RESUME_STALE_DAYS * DAY_MS;
  const byId = new Map(list.map((e) => [e.mediaId, e] as const));
  const hasNewEp = (id: number) =>
    notes.some((n) => n.kind === "new-episode" && n.mediaId === id);

  // Is an entry still a valid resume candidate (paused/stalled-current, stale,
  // no pending new-episode alert)? DROPPED is excluded by design.
  const isCandidate = (e: LocalEntry | undefined): e is LocalEntry =>
    !!e &&
    (e.status === "PAUSED" || e.status === "CURRENT") &&
    lastActivity(e) < staleCutoff &&
    !hasNewEp(e.mediaId);

  const emitResume = (e: LocalEntry) => {
    const last = lastActivity(e);
    notes.push({
      id: `resume:${e.mediaId}`,
      kind: "resume",
      mediaId: e.mediaId,
      title: localTitle(e, titlePref),
      coverImage: e.coverImage ?? null,
      days: Math.floor((now - last) / DAY_MS),
      sortAt: last,
    });
  };

  const stored = readResumePick();
  const storedFresh = !!stored && now - stored.at < RESUME_INTERVAL_MS;
  const storedEntry = stored ? byId.get(stored.mediaId) : undefined;

  if (storedFresh && isCandidate(storedEntry)) {
    // Still within the 3-day window and the pick is still valid → keep showing.
    emitResume(storedEntry);
  } else {
    // Window elapsed (or the stored pick is no longer valid) → choose a new one.
    const recentCutoff = now - RECENT_WINDOW_DAYS * DAY_MS;
    const candidates = list.filter((e) => isCandidate(e));
    const recent = list.filter(
      (e) =>
        (e.status === "CURRENT" || e.status === "COMPLETED") &&
        lastActivity(e) >= recentCutoff,
    );

    if (candidates.length > 0) {
      const themes = await fetchThemes([
        ...candidates.map((e) => e.mediaId),
        ...recent.map((e) => e.mediaId),
      ]);
      const recentThemes = recent
        .map((e) => themes.get(e.mediaId))
        .filter(Boolean) as Themes[];

      // Best theme overlap with any recent watch; ties → most recently stale.
      let best: { e: LocalEntry; score: number } | null = null;
      for (const e of candidates) {
        const th = themes.get(e.mediaId) ?? { genres: [], tags: [] };
        const score = recentThemes.reduce(
          (max, rt) => Math.max(max, themeOverlap(th, rt)),
          0,
        );
        if (
          !best ||
          score > best.score ||
          (score === best.score && lastActivity(e) > lastActivity(best.e))
        ) {
          best = { e, score };
        }
      }

      if (best) {
        emitResume(best.e);
        writeResumePick({ mediaId: best.e.mediaId, at: now });
      }
    }
  }

  return notes.sort((a, b) => b.sortAt - a.sortAt);
}
