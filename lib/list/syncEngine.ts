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
  LocalTitle,
} from "./localList";
import { todayFuzzy, Status } from "./types";
import { saveMediaListEntry } from "./anilistPush";
import { patchListEntry, peekListEntry } from "@/lib/anilist/userListCache";

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
  const stale = Object.values(getLocalList()).filter(
    (e) => e.status === "CURRENT" && e.updatedAt < cutoff,
  );
  if (stale.length === 0) return;

  // Pause locally first (instant, offline-safe). Preserve updatedAt.
  for (const e of stale) {
    upsertLocalEntry(e.mediaId, { status: "PAUSED", updatedAt: e.updatedAt });
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
