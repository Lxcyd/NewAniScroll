/**
 * AniList synchronisation preferences (local, per-device).
 *
 * Same pattern as lib/prefs/titlePref.ts: a single localStorage key, a
 * CustomEvent for same-tab notification, and a hook returning the live value.
 *
 * The "master" toggle (`enabled`) gates whether anything is pushed to AniList
 * at all. The three sub-toggles are independent rules that ALSO apply to the
 * local list regardless of `enabled` (see lib/list/syncEngine.ts) — `enabled`
 * only controls the AniList push, never the local-list bookkeeping.
 */

import { useEffect, useState } from "react";

export type SyncPrefs = {
  /** Master: push automations to the connected AniList account. */
  enabled: boolean;
  /** Update episode progress on episode finish. */
  autoProgress: boolean;
  /** First finished episode → status CURRENT. */
  autoWatching: boolean;
  /** CURRENT entries untouched for `autoPauseDays` → PAUSED. */
  autoPause: boolean;
  /** Inactivity window for auto-pause, in days. */
  autoPauseDays: number;
  /** Minimum fraction of an episode that must be watched before it counts as
   *  finished (progress +1 / AniList update). 0–1.0; default 0.8 (80%). */
  syncThreshold: number;
  /** True once the user has answered the "which list wins" direction prompt at
   *  least once (first AniList login, or a manual toggle). Gates the one-time
   *  auto-enable + direction popup in _app so it never re-nags on later loads. */
  directionChosen: boolean;
};

export const DEFAULT_SYNC_PREFS: SyncPrefs = {
  // Sync defaults OFF and is turned ON by the user's choice in the first-login
  // direction popup (see _app.tsx SyncBootstrap). Keeping it off by default
  // means a guest / not-yet-decided user never has it silently enabled, and
  // "Don't sync" is a real, sticky choice. `directionChosen` records whether
  // that one-time question has been answered.
  enabled: false,
  autoProgress: true,
  autoWatching: true,
  autoPause: false,
  autoPauseDays: 30,
  syncThreshold: 0.8,
  directionChosen: false,
};

/** Clamp a stored/incoming threshold to the supported 0–100% range. */
function clampThreshold(v: unknown): number {
  return Number.isFinite(v as number)
    ? Math.min(1, Math.max(0, v as number))
    : DEFAULT_SYNC_PREFS.syncThreshold;
}

const KEY = "aniscroll:syncPrefs";
export const SYNC_PREFS_EVENT = "aniscroll:syncPrefs:change";

export function getSyncPrefs(): SyncPrefs {
  if (typeof window === "undefined") return DEFAULT_SYNC_PREFS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SYNC_PREFS;
    const parsed = JSON.parse(raw);
    // Merge over defaults so a stored object missing a newer field is safe.
    return {
      ...DEFAULT_SYNC_PREFS,
      ...parsed,
      autoPauseDays:
        Number.isFinite(parsed?.autoPauseDays) && parsed.autoPauseDays > 0
          ? Math.floor(parsed.autoPauseDays)
          : DEFAULT_SYNC_PREFS.autoPauseDays,
      syncThreshold: clampThreshold(parsed?.syncThreshold),
    };
  } catch {
    return DEFAULT_SYNC_PREFS;
  }
}

export function setSyncPrefs(patch: Partial<SyncPrefs>): SyncPrefs {
  const next = { ...getSyncPrefs(), ...patch };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* best-effort */
    }
    window.dispatchEvent(new CustomEvent(SYNC_PREFS_EVENT));
  }
  return next;
}

export function useSyncPrefs(): SyncPrefs {
  const [prefs, setPrefs] = useState<SyncPrefs>(DEFAULT_SYNC_PREFS);
  useEffect(() => {
    const read = () => setPrefs(getSyncPrefs());
    read();
    window.addEventListener(SYNC_PREFS_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(SYNC_PREFS_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return prefs;
}
