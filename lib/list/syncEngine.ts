/**
 * Sync engine — the single place that applies "automation" rules.
 *
 * Two entry points:
 *   - onEpisodeFinished(): called when the player reaches the end of an episode.
 *   - runAutoPauseSweep(): called once at app bootstrap.
 *
 * Both always update the LOCAL list (lib/list/localList.ts). When the AniList
 * sync master toggle is on AND the user has a connected AniList session, they
 * ALSO push the change upstream (lib/list/anilistPush.ts) and reconcile the
 * AniList client cache (lib/anilist/userListCache.ts) so other components stay
 * consistent without a refetch.
 *
 * Session is read lazily via next-auth's getSession() so callers (the player,
 * _app bootstrap) don't have to thread the session through — and we only pay
 * that lookup when the sync master toggle is actually on.
 */

import { getSession } from "next-auth/react";
import { getSyncPrefs, SyncPrefs } from "@/lib/prefs/syncPrefs";
import {
  getLocalList,
  peekLocalEntry,
  upsertLocalEntry,
  importEntries,
  LocalEntry,
  LocalTitle,
} from "./localList";
import { todayFuzzy, Status, FuzzyDate } from "./types";
import { saveMediaListEntry } from "./anilistPush";
import { patchListEntry, peekListEntry } from "@/lib/anilist/userListCache";

const ENDPOINT = "https://graphql.anilist.co/";

type AniSession = { user?: { token?: string; name?: string } } | null;

/** Resolve the AniList session only when sync is enabled (avoids a needless
 *  /api/auth/session round-trip on every episode finish for local-only users). */
async function getAniListSession(prefs: SyncPrefs): Promise<AniSession> {
  if (!prefs.enabled) return null;
  try {
    const s = (await getSession()) as AniSession;
    return s?.user?.token ? s : null;
  } catch {
    return null;
  }
}

const emptyFuzzy = (d?: FuzzyDate | null): FuzzyDate | null =>
  !d || (!d.year && !d.month && !d.day)
    ? null
    : { year: d.year ?? null, month: d.month ?? null, day: d.day ?? null };

/**
 * Full pull: replace the entire local list with the signed-in user's AniList
 * list. This is the "AniList overwrites local" operation — run when the user
 * enables sync (after they confirm), on app load while sync is on, and from the
 * manual "Resync now" button.
 *
 * The local list stays the always-displayed, resilient mirror: if this fetch
 * fails (AniList down / offline) we DON'T clobber the existing local list —
 * we just keep what we have and report failure, so the user still has a list.
 *
 * Returns { ok, count }. ok=false means the pull failed and local was left
 * untouched.
 */
export async function fullSyncFromAniList(): Promise<{ ok: boolean; count: number }> {
  const prefs = getSyncPrefs();
  const session = await getAniListSession(prefs);
  const token = session?.user?.token;
  const userName = session?.user?.name;
  if (!token || !userName) return { ok: false, count: 0 };

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: `query ($userName: String) {
          MediaListCollection(userName: $userName, type: ANIME) {
            lists { entries {
              status score(format: POINT_10_DECIMAL) progress updatedAt
              startedAt { year month day } completedAt { year month day } notes
              media { id episodes title { english romaji native userPreferred } coverImage { large } }
            } }
          }
        }`,
        variables: { userName },
      }),
    });
    if (!res.ok) return { ok: false, count: 0 };
    const json = await res.json();
    if (json?.errors?.length) return { ok: false, count: 0 };
    const lists = json?.data?.MediaListCollection?.lists || [];
    const byId = new Map<number, LocalEntry>();
    const now = Date.now();
    for (const list of lists) {
      for (const e of list?.entries || []) {
        const mediaId = Number(e?.media?.id);
        if (!Number.isFinite(mediaId)) continue;
        byId.set(mediaId, {
          mediaId,
          status: (e.status as Status) ?? null,
          score: typeof e.score === "number" && e.score > 0 ? e.score : null,
          progress: Number(e.progress) || 0,
          total: typeof e.media?.episodes === "number" ? e.media.episodes : null,
          title: e.media?.title || undefined,
          coverImage: e.media?.coverImage?.large ?? null,
          startedAt: emptyFuzzy(e.startedAt),
          completedAt: emptyFuzzy(e.completedAt),
          notes: e.notes || null,
          updatedAt: now,
          // AniList's MediaList.updatedAt (Unix seconds) is the real last-activity
          // signal that drives auto-pause. Fall back to `now` if absent.
          activityAt:
            typeof e.updatedAt === "number" && e.updatedAt > 0
              ? e.updatedAt * 1000
              : now,
        });
      }
    }
    const entries = Array.from(byId.values());
    // Replace: AniList is the source of truth at sync time (per user choice).
    const count = importEntries(entries, "replace");
    return { ok: true, count };
  } catch {
    return { ok: false, count: 0 };
  }
}

/** De-dupe guard: the player re-binds its `ended` listener per episode/server,
 *  so the same finish can fire more than once. We coalesce per media:episode. */
const recentlyFinished = new Set<string>();

export type EpisodeFinishedArgs = {
  aniId: number;
  episode: number;
  /** Total episodes when known (caps progress + decides COMPLETED). */
  total?: number | null;
  title?: LocalTitle;
  coverImage?: string | null;
};

/**
 * Apply the "episode finished" rules.
 *
 * Local (always):
 *   - progress = max(existing, episode)
 *   - autoWatching: if no status (or PLANNING) → CURRENT + startedAt today
 *   - if episode === total → COMPLETED + completedAt today
 *
 * AniList push (only when master enabled + session): mirror progress/status,
 * respecting the individual autoProgress / autoWatching toggles.
 */
export async function onEpisodeFinished(args: EpisodeFinishedArgs): Promise<void> {
  const { aniId, episode, total, title, coverImage } = args;
  if (!Number.isFinite(aniId) || !Number.isFinite(episode) || episode <= 0) return;

  const dedupeKey = `${aniId}:${episode}`;
  if (recentlyFinished.has(dedupeKey)) return;
  recentlyFinished.add(dedupeKey);
  // Allow a re-fire after a while (e.g. a genuine rewatch later in the session).
  setTimeout(() => recentlyFinished.delete(dedupeKey), 60_000);

  const prefs = getSyncPrefs();
  const prev = peekLocalEntry(aniId);
  const totalEp = Number.isFinite(total as number) && (total as number) > 0 ? (total as number) : null;

  // ── Local update (always) ──────────────────────────────────────
  const nextProgress = Math.max(prev?.progress ?? 0, episode);
  let nextStatus: Status | null = prev?.status ?? null;
  const patch: Parameters<typeof upsertLocalEntry>[1] = {
    progress: nextProgress,
    total: totalEp ?? prev?.total ?? null,
    activityAt: Date.now(), // real watch activity — resets the auto-pause clock
  };
  if (title) patch.title = title;
  if (coverImage) patch.coverImage = coverImage;

  // First finished episode → CURRENT (only promotes from "nothing"/PLANNING).
  if (prefs.autoWatching && (nextStatus == null || nextStatus === "PLANNING")) {
    nextStatus = "CURRENT";
    patch.status = "CURRENT";
    if (!prev?.startedAt) patch.startedAt = todayFuzzy();
  }
  // Final episode → COMPLETED (never downgrades a REPEATING rewatch count here).
  if (totalEp != null && nextProgress >= totalEp) {
    nextStatus = "COMPLETED";
    patch.status = "COMPLETED";
    if (!prev?.completedAt) patch.completedAt = todayFuzzy();
  }
  upsertLocalEntry(aniId, patch);

  // ── AniList push (opt-in) ──────────────────────────────────────
  const session = await getAniListSession(prefs);
  if (!session?.user?.token) return;
  const token = session.user.token;
  const userName = session.user.name;

  // Build the upstream payload from the same rules but gated per-toggle.
  const payload: Parameters<typeof saveMediaListEntry>[1] = { mediaId: aniId };
  if (prefs.autoProgress) payload.progress = nextProgress;
  if (totalEp != null && nextProgress >= totalEp) {
    payload.status = "COMPLETED";
    payload.completedAt = todayFuzzy();
  } else if (prefs.autoWatching) {
    // Only promote on AniList when it isn't already on a "stronger" status.
    const existing = userName ? peekListEntry(userName, aniId) : undefined;
    const cur = existing?.status ?? null;
    if (cur == null || cur === "PLANNING") {
      payload.status = "CURRENT";
      payload.startedAt = todayFuzzy();
    }
  }
  // Nothing to push (both relevant toggles off).
  if (payload.progress === undefined && payload.status === undefined) return;

  const saved = await saveMediaListEntry(token, payload);
  if (saved && userName) {
    const existing = peekListEntry(userName, aniId);
    patchListEntry(userName, aniId, {
      id: saved.id,
      mediaId: aniId,
      status: saved.status ?? existing?.status ?? null,
      score: saved.score ?? existing?.score ?? null,
      progress: saved.progress,
      repeat: existing?.repeat ?? 0,
      private: existing?.private ?? false,
      hiddenFromStatusLists: existing?.hiddenFromStatusLists ?? false,
      notes: existing?.notes ?? null,
      startedAt: existing?.startedAt ?? payload.startedAt ?? null,
      completedAt: payload.completedAt ?? existing?.completedAt ?? null,
      customLists: existing?.customLists ?? [],
    });
    // Recopy AniList's authoritative result into the local mirror so the two
    // stay identical (AniList is the source of truth while sync is on).
    upsertLocalEntry(aniId, {
      status: saved.status ?? null,
      score: saved.score,
      progress: saved.progress,
    });
  }
}

/**
 * Auto-pause sweep. CURRENT local entries whose last activity is older than
 * `autoPauseDays` become PAUSED. We DON'T bump `updatedAt` when pausing (pass
 * it through) so a paused entry isn't immediately "active" again. When AniList
 * sync is on, the same change is pushed upstream (verifying the AniList entry
 * is still CURRENT first, so we never fight a fresh change made on AniList).
 *
 * Idempotent and cheap: only iterates the local list, only touches stale
 * CURRENT entries, and is bounded by how many of those exist.
 */
export async function runAutoPauseSweep(): Promise<void> {
  const prefs = getSyncPrefs();
  if (!prefs.autoPause) return;

  const cutoff = Date.now() - prefs.autoPauseDays * 24 * 60 * 60 * 1000;
  // Inactivity is measured by `activityAt` (real last watch / AniList activity),
  // NOT `updatedAt` (which a sync/import bumps to "now" for every entry — using
  // it here would make nothing ever look stale). Fall back to `updatedAt` only
  // for legacy entries that predate `activityAt`.
  const stale = Object.values(getLocalList()).filter(
    (e) => e.status === "CURRENT" && (e.activityAt ?? e.updatedAt) < cutoff,
  );
  if (stale.length === 0) return;

  // Pause locally first (instant, offline-safe). Preserve both timestamps so a
  // paused entry doesn't look freshly active (and isn't re-swept immediately).
  for (const e of stale) {
    upsertLocalEntry(e.mediaId, {
      status: "PAUSED",
      updatedAt: e.updatedAt,
      activityAt: e.activityAt ?? e.updatedAt,
    });
  }

  // Push upstream only if enabled + connected.
  const session = await getAniListSession(prefs);
  const token = session?.user?.token;
  const userName = session?.user?.name;
  if (!token) return;

  for (const e of stale) {
    const saved = await saveMediaListEntry(token, { mediaId: e.mediaId, status: "PAUSED" });
    if (saved && userName) {
      const existing = peekListEntry(userName, e.mediaId);
      patchListEntry(userName, e.mediaId, {
        id: saved.id,
        mediaId: e.mediaId,
        status: "PAUSED",
        score: existing?.score ?? null,
        progress: saved.progress,
        repeat: existing?.repeat ?? 0,
        private: existing?.private ?? false,
        hiddenFromStatusLists: existing?.hiddenFromStatusLists ?? false,
        notes: existing?.notes ?? null,
        startedAt: existing?.startedAt ?? null,
        completedAt: existing?.completedAt ?? null,
        customLists: existing?.customLists ?? [],
      });
    }
  }
}
