/**
 * Video player preferences (local, per-device).
 *
 * Same pattern as lib/prefs/syncPrefs.ts: a single localStorage key, a
 * CustomEvent for same-tab notification, and a hook returning the live value.
 *
 * These control the *automatic* counterparts of the manual Skip / Next
 * buttons SkipOverlay already shows. They're all off by default so the
 * default experience stays manual (the user clicks to skip / advance).
 */

import { useEffect, useState } from "react";

export type PlayerPrefs = {
  /** Jump past the intro (op) automatically when it starts. */
  autoSkipIntro: boolean;
  /** Jump past the outro (ed) automatically when it starts. */
  autoSkipOutro: boolean;
  /** Navigate to the next episode automatically when the current one ends. */
  autoNextEpisode: boolean;
};

export const DEFAULT_PLAYER_PREFS: PlayerPrefs = {
  autoSkipIntro: false,
  autoSkipOutro: false,
  autoNextEpisode: false,
};

const KEY = "aniscroll:playerPrefs";
export const PLAYER_PREFS_EVENT = "aniscroll:playerPrefs:change";

export function getPlayerPrefs(): PlayerPrefs {
  if (typeof window === "undefined") return DEFAULT_PLAYER_PREFS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PLAYER_PREFS;
    const parsed = JSON.parse(raw);
    // Merge over defaults so a stored object missing a newer field is safe.
    return { ...DEFAULT_PLAYER_PREFS, ...parsed };
  } catch {
    return DEFAULT_PLAYER_PREFS;
  }
}

export function setPlayerPrefs(patch: Partial<PlayerPrefs>): PlayerPrefs {
  const next = { ...getPlayerPrefs(), ...patch };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* best-effort */
    }
    window.dispatchEvent(new CustomEvent(PLAYER_PREFS_EVENT));
  }
  return next;
}

export function usePlayerPrefs(): PlayerPrefs {
  const [prefs, setPrefs] = useState<PlayerPrefs>(DEFAULT_PLAYER_PREFS);
  useEffect(() => {
    const read = () => setPrefs(getPlayerPrefs());
    read();
    window.addEventListener(PLAYER_PREFS_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(PLAYER_PREFS_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return prefs;
}
