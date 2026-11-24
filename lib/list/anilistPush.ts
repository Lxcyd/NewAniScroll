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
import { anilistWritesAllowed } from "../anilist/writeGuard";
import { protectHistory, type RemoteState } from "./protectHistory";

export type { RemoteState };

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

export type SaveOptions = {
  /** Un geste de l'utilisateur dans l'éditeur de liste : il a le droit de
   *  réécrire une date ou de rétrograder un statut. */
  manual?: boolean;
  /** L'état d'AniList quand l'appelant le connaît déjà (synchro complète) ;
   *  sinon il est relu à la source. */
  remote?: RemoteState;
};

async function readRemote(token: string, mediaId: number): Promise<RemoteState | undefined> {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        query: `query($m:Int){Media(id:$m){mediaListEntry{status
          startedAt{year month day} completedAt{year month day}}}}`,
        variables: { m: mediaId },
      }),
    });
    const j = await res.json().catch(() => null);
    if (!j?.data?.Media) return undefined;
    const e = j.data.Media.mediaListEntry;
    return e ? { status: e.status ?? null, startedAt: e.startedAt ?? null, completedAt: e.completedAt ?? null } : null;
  } catch {
    return undefined;
  }
}

/** L'appel lui-même, sans file : `flushOutbox` s'en sert pour rejouer. */
export async function sendSave(token: string, payload: SavePayload, opts: SaveOptions = {}): Promise<SaveResult> {
  // Hors prod : jamais envoyé, jamais rangé dans la file (lib/anilist/writeGuard).
  if (!anilistWritesAllowed()) return { ok: false, retryable: false };
  if (!opts.manual && (payload.startedAt !== undefined || payload.completedAt !== undefined || payload.status)) {
    const remote = "remote" in opts ? opts.remote : await readRemote(token, payload.mediaId);
    /* S'il ne reste que l'id, l'envoi part quand même : sur une entrée
       existante il ne change rien et rend l'état réel aux appelants. */
    payload = protectHistory(payload, remote);
  }
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
  if (!anilistWritesAllowed()) return { ok: false, retryable: false };
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
  opts: SaveOptions = {},
): Promise<SavedEntry | null> {
  const r = await sendSave(token, payload, opts);
  if (r.ok) {
    clearSent(payload.mediaId, Object.keys(fieldsOf(payload)));
    return r.saved;
  }
  if (r.retryable) queueSave(payload.mediaId, fieldsOf(payload), { manual: opts.manual });
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
  if (!anilistWritesAllowed()) return true; // hors prod : retiré localement seulement
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
