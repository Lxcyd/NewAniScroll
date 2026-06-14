/**
 * "Hide spoilers" preference (local, per-device).
 *
 * Same pattern as the other prefs (lib/prefs/syncPrefs.ts): one localStorage
 * key, a CustomEvent for same-tab notification, and a hook returning the live
 * value.
 *
 * When on, episode thumbnails are blurred and episode titles / descriptions are
 * hidden across the app, so browsing a show you're mid-way through doesn't spoil
 * what's coming. Off by default.
 */

import { useEffect, useState } from "react";

const KEY = "aniscroll:hideSpoilers";
export const HIDE_SPOILERS_EVENT = "aniscroll:hideSpoilers:change";

export function getHideSpoilers(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setHideSpoilers(next: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    /* best-effort */
  }
  window.dispatchEvent(new CustomEvent(HIDE_SPOILERS_EVENT));
}

export function useHideSpoilers(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const read = () => setOn(getHideSpoilers());
    read();
    window.addEventListener(HIDE_SPOILERS_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(HIDE_SPOILERS_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return on;
}
