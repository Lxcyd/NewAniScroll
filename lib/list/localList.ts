/**
 * Client-side "local list" — a full anime list (status / score / progress /
 * dates / notes) stored entirely in localStorage, for users who are NOT signed
 * in to AniList.
 *
 * Design mirrors the existing local-pref stores (lib/prefs/titlePref.ts) and
 * the per-episode progress store (lib/watch/progress.ts):
 *   - one localStorage key holds the whole list (one read/write per change),
 *   - a CustomEvent notifies every mounted component to re-read (same-tab; the
 *     native `storage` event only fires across tabs),
 *   - a `useLocalList` hook returns the live list and re-renders on change.
 *
 * Identity is the AniList media id (`mediaId`), so a local entry maps 1:1 to an
 * AniList entry and the sync engine can push it upstream unchanged. Title +
 * cover are cached on the entry so the My List page can render fully offline
 * (no AniList query needed to show what's in the list).
 */

import { useEffect, useState } from "react";
import type { Status, FuzzyDate } from "./types";

export type LocalTitle = {
  english?: string | null;
  romaji?: string | null;
  native?: string | null;
  userPreferred?: string | null;
};

export type LocalEntry = {
  mediaId: number;
  status: Status | null;
  score: number | null; // POINT_10_DECIMAL (matches userListCache)
  progress: number; // episodes watched
  total: number | null; // total episodes when known (cache for the bar)
  title?: LocalTitle;
  coverImage?: string | null;
  startedAt: FuzzyDate | null;
  completedAt: FuzzyDate | null;
  notes: string | null;
  /** Number of times re-watched (AniList `repeat`). Defaults to 0. */
  repeat?: number;
  /** epoch ms of the last LOCAL write — drives "recently" ordering on My List. */
  updatedAt: number;
  /** epoch ms of the last real WATCH activity (an episode finished, or AniList's
   *  own MediaList.updatedAt at sync time). Drives auto-pause. Distinct from
   *  `updatedAt`: importing/syncing rewrites `updatedAt` to "now", but must NOT
   *  reset inactivity — otherwise nothing ever looks stale. Falls back to
   *  `updatedAt` when missing (older entries written before this field). */
  activityAt?: number;

  /* ── Métadonnées d'œuvre, mises en cache pour les badges ────────────────────
     Une liste locale ne connaissait que le titre, la jaquette et l'avancement.
     Les familles Genres, Découverte et Franchises en demandent plus, et
     l'inventer n'est pas une option : « pas de chiffre faux sur un profil »
     (lib/profile/insights.ts). Ces champs sont donc remplis OPPORTUNISTEMENT,
     là où la donnée est déjà en main et ne coûte rien de plus :
       - la synchro AniList, qui demandait déjà `media { … }` ;
       - la page anime et la page de lecture, qui les ont affichées ;
       - un rattrapage unique pour les listes déjà constituées
         (lib/badges/metaBackfill.ts), contre AniList et non contre nous.

     Tant qu'ils sont absents, le badge qui en dépend est « pas encore
     mesurable » — jamais « zéro ». */
  /** Genres AniList, en anglais (c'est ce que portent les données). */
  genres?: string[];
  /** Tags AniList, en anglais. */
  tags?: string[];
  /** Année de première diffusion. */
  year?: number | null;
  /** TV, MOVIE, OVA, ONA, SPECIAL… */
  format?: string | null;
  /** Statut de diffusion de l'ŒUVRE (FINISHED, RELEASING, NOT_YET_RELEASED…),
   *  à ne pas confondre avec `status`, qui est celui du SPECTATEUR. */
  mediaStatus?: string | null;
  /** Studio principal. */
  studio?: string | null;
  /** Combien de personnes l'ont sur leur liste, chez AniList. */
  popularity?: number | null;
  /** Ids AniList des œuvres liées — de quoi reconstruire une franchise sans
   *  interroger notre propre base. */
  relIds?: number[];
};

export type LocalListMap = Record<number, LocalEntry>;

const KEY = "aniscroll:localList";
export const LOCAL_LIST_EVENT = "aniscroll:localList:change";

function notify(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(LOCAL_LIST_EVENT));
}

/** Read the whole local list as a map. Empty object when unset / unavailable. */
export function getLocalList(): LocalListMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as LocalListMap) : {};
  } catch {
    return {};
  }
}

function writeLocalList(map: LocalListMap): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* quota / private-mode — best-effort, never throw */
  }
  notify();
}

/** Synchronous single-entry read (undefined when not in the local list). */
export function peekLocalEntry(mediaId: number): LocalEntry | undefined {
  if (mediaId == null) return undefined;
  return getLocalList()[mediaId];
}

/**
 * Insert or update one entry. `patch` is shallow-merged onto any existing entry
 * (so callers can update just `progress` or just `status`). `updatedAt` is
 * always refreshed unless the caller explicitly provides one (used by the
 * auto-pause sweep, which must NOT bump activity when it pauses an entry).
 */
export function upsertLocalEntry(
  mediaId: number,
  patch: Partial<Omit<LocalEntry, "mediaId">>,
): LocalEntry {
  const map = getLocalList();
  const prev = map[mediaId];
  const next: LocalEntry = {
    mediaId,
    status: patch.status !== undefined ? patch.status : prev?.status ?? null,
    score: patch.score !== undefined ? patch.score : prev?.score ?? null,
    progress: patch.progress !== undefined ? patch.progress : prev?.progress ?? 0,
    total: patch.total !== undefined ? patch.total : prev?.total ?? null,
    title: patch.title !== undefined ? patch.title : prev?.title,
    coverImage:
      patch.coverImage !== undefined ? patch.coverImage : prev?.coverImage ?? null,
    startedAt: patch.startedAt !== undefined ? patch.startedAt : prev?.startedAt ?? null,
    completedAt:
      patch.completedAt !== undefined ? patch.completedAt : prev?.completedAt ?? null,
    notes: patch.notes !== undefined ? patch.notes : prev?.notes ?? null,
    repeat: patch.repeat !== undefined ? patch.repeat : prev?.repeat ?? 0,
    updatedAt: patch.updatedAt !== undefined ? patch.updatedAt : Date.now(),
    activityAt:
      patch.activityAt !== undefined ? patch.activityAt : prev?.activityAt,
    /* Les métadonnées se conservent au patch, comme tout le reste : un
       `upsertLocalEntry(id, { progress })` venu du lecteur ne doit pas effacer
       les genres posés par la page anime. */
    genres: patch.genres !== undefined ? patch.genres : prev?.genres,
    tags: patch.tags !== undefined ? patch.tags : prev?.tags,
    year: patch.year !== undefined ? patch.year : prev?.year,
    format: patch.format !== undefined ? patch.format : prev?.format,
    mediaStatus: patch.mediaStatus !== undefined ? patch.mediaStatus : prev?.mediaStatus,
    studio: patch.studio !== undefined ? patch.studio : prev?.studio,
    popularity: patch.popularity !== undefined ? patch.popularity : prev?.popularity,
    relIds: patch.relIds !== undefined ? patch.relIds : prev?.relIds,
  };
  map[mediaId] = next;
  writeLocalList(map);
  return next;
}

/**
 * Patcher BEAUCOUP d'entrées d'un coup : une lecture, une écriture, un
 * événement.
 *
 * `upsertLocalEntry` relit et réécrit toute la liste à chaque appel — parfait
 * pour un épisode terminé, ruineux pour les huit cents titres du rattrapage de
 * métadonnées (lib/badges/metaBackfill.ts) : ce serait huit cents
 * sérialisations d'une liste d'un mégaoctet, et huit cents événements dont
 * chacun réveille la synchro cloud et l'évaluateur de badges.
 *
 * Une entrée absente est IGNORÉE et non créée : ce chemin sert à enrichir ce
 * qu'on a, pas à inventer des lignes de liste.
 */
export function patchLocalEntries(
  patches: { mediaId: number; patch: Partial<Omit<LocalEntry, "mediaId">> }[],
): number {
  const map = getLocalList();
  let touched = 0;
  for (const { mediaId, patch } of patches) {
    const prev = map[mediaId];
    if (!prev) continue;
    /* `updatedAt` n'est PAS remonté : un enrichissement n'est pas une activité
       de l'utilisateur, et le faire remonter réordonnerait « Ma liste » (triée
       par « récemment touché ») sur toute sa longueur d'un seul coup. */
    map[mediaId] = { ...prev, ...patch, mediaId, updatedAt: prev.updatedAt };
    touched++;
  }
  if (touched) writeLocalList(map);
  return touched;
}

/** Remove one entry (no-op when absent). */
export function removeLocalEntry(mediaId: number): void {
  const map = getLocalList();
  if (map[mediaId]) {
    delete map[mediaId];
    writeLocalList(map);
  }
}

export type ImportMode = "merge" | "replace";

/**
 * Bulk-import entries. In "replace" mode the whole list is overwritten; in
 * "merge" mode each entry wins only when it's newer (or the slot is empty), so
 * re-importing an older export never clobbers fresher local progress. Returns
 * the number of entries written. Bumps a single notification.
 */
export function importEntries(entries: LocalEntry[], mode: ImportMode): number {
  const incoming = entries.filter((e) => e && Number.isFinite(e.mediaId));
  /* L'ÉTAT D'AVANT EST LU DANS LES DEUX MODES, y compris « replace ».
     Un import remplace le STATUT, l'avancement, la note — ce qu'il apporte.
     Il ne connaît pas les métadonnées d'œuvre (un export JSON d'une version
     antérieure, un XML MyAnimeList) et les écraserait par `undefined` : les
     familles Genres et Découverte redeviendraient « pas encore mesurables »
     après chaque resynchronisation, jusqu'au prochain rattrapage. Ce sont des
     données de cache, pas de la liste : elles survivent à ce que l'import dit
     d'elle. */
  const before = getLocalList();
  const map: LocalListMap = mode === "replace" ? {} : before;
  let written = 0;
  for (const e of incoming) {
    const prev = map[e.mediaId];
    if (mode === "merge" && prev && prev.updatedAt >= (e.updatedAt || 0)) continue;
    const kept = before[e.mediaId];
    map[e.mediaId] = {
      ...e,
      genres: e.genres ?? kept?.genres,
      tags: e.tags ?? kept?.tags,
      year: e.year ?? kept?.year,
      format: e.format ?? kept?.format,
      mediaStatus: e.mediaStatus ?? kept?.mediaStatus,
      studio: e.studio ?? kept?.studio,
      popularity: e.popularity ?? kept?.popularity,
      relIds: e.relIds ?? kept?.relIds,
      updatedAt: e.updatedAt || Date.now(),
    };
    written++;
  }
  writeLocalList(map);
  return written;
}

/** Serialisable export payload (for download / cross-device transfer). */
export type LocalListExport = {
  version: 1;
  app: "aniscroll";
  exportedAt: string;
  entries: LocalEntry[];
};

export function buildExport(): LocalListExport {
  return {
    version: 1,
    app: "aniscroll",
    exportedAt: new Date().toISOString(),
    entries: Object.values(getLocalList()),
  };
}

/** Wipe the entire local list. */
export function clearLocalList(): void {
  writeLocalList({});
}

/**
 * Live local list as a sorted array (most-recently-touched first). Re-renders
 * the caller whenever the list changes anywhere in the app.
 */
export function useLocalList(): LocalEntry[] {
  const [list, setList] = useState<LocalEntry[]>([]);
  useEffect(() => {
    const read = () =>
      setList(Object.values(getLocalList()).sort((a, b) => b.updatedAt - a.updatedAt));
    read();
    window.addEventListener(LOCAL_LIST_EVENT, read);
    // Cross-tab: pick up edits made in another tab too.
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(LOCAL_LIST_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return list;
}
