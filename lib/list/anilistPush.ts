/**
 * Minimal, framework-free AniList mutation helpers used by the sync engine.
 *
 * The existing AniList write paths live inside React (components/listEditor.tsx,
 * lib/anilist/useAnilist.js). The sync engine runs outside a component (it's
 * called from an event handler and from app bootstrap), so it needs plain
 * async functions. These mirror the SaveMediaListEntry mutation already used by
 * the editor — same field set — so behaviour stays consistent.
 *
 * Un échec PASSAGER (AniList en panne, réseau coupé) range la modification dans
 * la file d'envoi (lib/list/anilistOutbox.ts), rejouée au retour d'AniList.
 */

import type { Status, FuzzyDate } from "./types";
import { clearSent, isRetryable, queueDelete, queueSave, type OutboxFields } from "./anilistOutbox";

const ENDPOINT = "https://graphql.anilist.co/";

export type SavePayload = {
  mediaId: number;
  status?: Status | null;
  score?: number | null;
  progress?: number | null;
  startedAt?: FuzzyDate | null;
  completedAt?: FuzzyDate | null;
  repeat?: number | null;
  notes?: string | null;
  private?: boolean;
  hiddenFromStatusLists?: boolean;
  customLists?: string[];
};

export type SavedEntry = {
  id: number;
  status: Status | null;
  score: number | null;
  progress: number;
};

/** Le résultat brut : l'entrée enregistrée, ou pourquoi elle ne l'est pas. */
export type SaveResult =
  | { ok: true; saved: SavedEntry }
  | { ok: false; retryable: boolean };

const FIELDS = [
  "status",
  "score",
  "progress",
  "startedAt",
  "completedAt",
  "repeat",
  "notes",
  "private",
  "hiddenFromStatusLists",
  "customLists",
] as const;

/** L'appel lui-même, sans file : `flushOutbox` s'en sert pour rejouer. */
export async function sendSave(token: string, payload: SavePayload): Promise<SaveResult> {
  const variables: Record<string, unknown> = { mediaId: payload.mediaId };
  for (const f of FIELDS) if (payload[f] !== undefined) variables[f] = payload[f];

  let status: number | null = null;
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
          $startedAt: FuzzyDateInput, $completedAt: FuzzyDateInput,
          $repeat: Int, $notes: String, $private: Boolean,
          $hiddenFromStatusLists: Boolean, $customLists: [String]
        ) {
          SaveMediaListEntry(
            mediaId: $mediaId, status: $status, score: $score, progress: $progress,
            startedAt: $startedAt, completedAt: $completedAt, repeat: $repeat,
            notes: $notes, private: $private,
            hiddenFromStatusLists: $hiddenFromStatusLists, customLists: $customLists
          ) {
            id status score(format: POINT_10_DECIMAL) progress
          }
        }`,
        variables,
      }),
    });
    status = res.status;
    const json = await res.json().catch(() => null);
    const saved = json?.data?.SaveMediaListEntry;
    if (!saved) return { ok: false, retryable: isRetryable(res.ok ? 200 : status, json) };
    return {
      ok: true,
      saved: {
        id: Number(saved.id),
        status: (saved.status as Status) ?? null,
        score: typeof saved.score === "number" ? saved.score : null,
        progress: Number(saved.progress) || 0,
      },
    };
  } catch {
    return { ok: false, retryable: isRetryable(status) };
  }
}

/** DeleteMediaListEntry, sans file. `true` = supprimée (ou déjà absente). */
export async function sendDelete(token: string, entryId: number): Promise<SaveResult | { ok: true }> {
  let status: number | null = null;
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        query: `mutation ($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }`,
        variables: { id: entryId },
      }),
    });
    status = res.status;
    const json = await res.json().catch(() => null);
    if (json?.data?.DeleteMediaListEntry?.deleted) return { ok: true };
    return { ok: false, retryable: isRetryable(res.ok ? 200 : status, json) };
  } catch {
    return { ok: false, retryable: isRetryable(status) };
  }
}

/** Les champs d'un envoi, tels que la file les range. */
function fieldsOf(payload: SavePayload): OutboxFields {
  const out: OutboxFields = {};
  for (const f of FIELDS) if (payload[f] !== undefined) (out as any)[f] = payload[f];
  return out;
}

/** SaveMediaListEntry — only sends the fields provided (undefined keys are
 *  dropped so we never blank out a value the user set on AniList). Returns the
 *  saved entry's authoritative fields, or null on any failure — a PASSING
 *  failure is queued for replay (anilistOutbox). */
export async function saveMediaListEntry(
  token: string,
  payload: SavePayload,
): Promise<SavedEntry | null> {
  const r = await sendSave(token, payload);
  if (r.ok) {
    clearSent(payload.mediaId, Object.keys(fieldsOf(payload)));
    return r.saved;
  }
  if (r.retryable) queueSave(payload.mediaId, fieldsOf(payload));
  return null;
}

/** DeleteMediaListEntry avec mise en file en cas d'échec passager. Sans id
 *  d'entrée connu (liste AniList pas chargée), la suppression est rangée et
 *  l'id sera retrouvé au rejeu. */
export async function deleteMediaListEntry(
  token: string,
  mediaId: number,
  entryId: number | null,
): Promise<boolean> {
  if (!entryId) {
    queueDelete(mediaId);
    return true;
  }
  const r = await sendDelete(token, entryId);
  if (r.ok) {
    clearSent(mediaId, "all");
    return true;
  }
  if ((r as any).retryable) {
    queueDelete(mediaId);
    return true;
  }
  return false;
}
