/**
 * Minimal, framework-free AniList mutation helpers used by the sync engine.
 *
 * The existing AniList write paths live inside React (components/listEditor.tsx,
 * lib/anilist/useAnilist.js). The sync engine runs outside a component (it's
 * called from an event handler and from app bootstrap), so it needs plain
 * async functions. These mirror the SaveMediaListEntry mutation already used by
 * the editor — same field set — so behaviour stays consistent.
 */

import type { Status, FuzzyDate } from "./types";

const ENDPOINT = "https://graphql.anilist.co/";

export type SavePayload = {
  mediaId: number;
  status?: Status | null;
  score?: number | null;
  progress?: number | null;
  startedAt?: FuzzyDate | null;
  completedAt?: FuzzyDate | null;
};

/** SaveMediaListEntry — only sends the fields provided (undefined keys are
 *  dropped so we never blank out a value the user set on AniList). Returns the
 *  saved entry's authoritative fields, or null on any failure. */
export async function saveMediaListEntry(
  token: string,
  payload: SavePayload,
): Promise<{
  id: number;
  status: Status | null;
  score: number | null;
  progress: number;
} | null> {
  const variables: Record<string, unknown> = { mediaId: payload.mediaId };
  if (payload.status !== undefined) variables.status = payload.status;
  if (payload.score !== undefined) variables.score = payload.score;
  if (payload.progress !== undefined) variables.progress = payload.progress;
  if (payload.startedAt !== undefined) variables.startedAt = payload.startedAt;
  if (payload.completedAt !== undefined) variables.completedAt = payload.completedAt;

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: `mutation (
          $mediaId: Int!, $status: MediaListStatus, $score: Float, $progress: Int,
          $startedAt: FuzzyDateInput, $completedAt: FuzzyDateInput
        ) {
          SaveMediaListEntry(
            mediaId: $mediaId, status: $status, score: $score, progress: $progress,
            startedAt: $startedAt, completedAt: $completedAt
          ) {
            id status score(format: POINT_10_DECIMAL) progress
          }
        }`,
        variables,
      }),
    });
    const json = await res.json();
    const saved = json?.data?.SaveMediaListEntry;
    if (!saved) return null;
    return {
      id: Number(saved.id),
      status: (saved.status as Status) ?? null,
      score: typeof saved.score === "number" ? saved.score : null,
      progress: Number(saved.progress) || 0,
    };
  } catch {
    return null;
  }
}

/** Read the current AniList entry (status + progress) for one media. Used to
 *  decide whether an automation should run (e.g. don't auto-pause something
 *  the user just bumped on AniList). Returns null when not in list / on error. */
export async function readMediaListEntry(
  token: string,
  mediaId: number,
): Promise<{ id: number; status: Status | null; progress: number } | null> {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: `query ($id: Int) {
          Media(id: $id) { mediaListEntry { id status progress } }
        }`,
        variables: { id: mediaId },
      }),
    });
    const json = await res.json();
    const e = json?.data?.Media?.mediaListEntry;
    if (!e) return null;
    return {
      id: Number(e.id),
      status: (e.status as Status) ?? null,
      progress: Number(e.progress) || 0,
    };
  } catch {
    return null;
  }
}
