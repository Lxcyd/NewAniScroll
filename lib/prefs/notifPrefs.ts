/**
 * In-app notification preferences (local, per-device).
 *
 * Same pattern as lib/prefs/syncPrefs.ts: a single localStorage key, a
 * CustomEvent for same-tab notification, and a hook returning the live value.
 *
 * Each toggle gates one of the notification kinds computed in
 * lib/notifications/computeNotifications.ts. When a toggle is off, that kind is
 * simply not emitted (so it also doesn't count toward the unread badge).
 */

import { useEffect, useState } from "react";

export type NotifPrefs = {
  /** A CURRENT anime has aired episodes beyond your progress. */
  newEpisode: boolean;
  /** A COMPLETED anime has a sequel you don't have in your list. */
  nextSeason: boolean;
  /** Nudge to pick back up an anime you stalled on a while ago. */
  resume: boolean;
};

export const DEFAULT_NOTIF_PREFS: NotifPrefs = {
  newEpisode: true,
  nextSeason: true,
  resume: true,
};

const KEY = "aniscroll:notifPrefs";
export const NOTIF_PREFS_EVENT = "aniscroll:notifPrefs:change";

export function getNotifPrefs(): NotifPrefs {
  if (typeof window === "undefined") return DEFAULT_NOTIF_PREFS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_NOTIF_PREFS;
    // Merge over defaults so a stored object missing a newer field is safe.
    return { ...DEFAULT_NOTIF_PREFS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_NOTIF_PREFS;
  }
}

export function setNotifPrefs(patch: Partial<NotifPrefs>): NotifPrefs {
  const next = { ...getNotifPrefs(), ...patch };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* best-effort */
    }
    window.dispatchEvent(new CustomEvent(NOTIF_PREFS_EVENT));
  }
  return next;
}

export function useNotifPrefs(): NotifPrefs {
  const [prefs, setPrefs] = useState<NotifPrefs>(DEFAULT_NOTIF_PREFS);
  useEffect(() => {
    const read = () => setPrefs(getNotifPrefs());
    read();
    window.addEventListener(NOTIF_PREFS_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(NOTIF_PREFS_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return prefs;
}
