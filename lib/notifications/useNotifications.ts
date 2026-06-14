/**
 * NavBar-bell notifications hook. Recomputes on mount (and when the local list
 * changes) and tracks which notification ids the user has already seen so the
 * unread badge only counts genuinely-new ones.
 *
 * Read state is a localStorage set of notification ids. Because ids embed the
 * salient number (e.g. the latest aired episode), a NEWER episode produces a
 * new id and re-surfaces as unread — exactly what we want.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getTitlePref } from "@/lib/prefs/titlePref";
import { LOCAL_LIST_EVENT } from "@/lib/list/localList";
import { NOTIF_PREFS_EVENT } from "@/lib/prefs/notifPrefs";
import {
  computeNotifications,
  type AppNotification,
} from "./computeNotifications";

const READ_KEY = "aniscroll:notifReadIds";
// Cap the stored read-id set so it can't grow forever as episodes advance.
// Keeping the most recent N (insertion order) is enough — far more than the
// handful of notifications ever live at once.
const MAX_READ_IDS = 200;

function getReadIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(READ_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeReadIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(READ_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    /* best-effort */
  }
}

export type UseNotifications = {
  notifications: AppNotification[];
  unreadCount: number;
  isRead: (id: string) => boolean;
  markAllRead: () => void;
  refresh: () => void;
};

export function useNotifications(): UseNotifications {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [readIds, setReadIds] = useState<Set<string>>(() => getReadIds());
  // Guard against overlapping/stale async computes (list changes mid-fetch).
  const runIdRef = useRef(0);

  const refresh = useCallback(() => {
    const myRun = ++runIdRef.current;
    computeNotifications({
      titlePref: getTitlePref(),
    })
      .then((next) => {
        if (myRun === runIdRef.current) setNotifications(next);
      })
      .catch(() => {
        if (myRun === runIdRef.current) setNotifications([]);
      });
  }, []);

  useEffect(() => {
    refresh();
    // Recompute when the local list changes (status/progress edits, syncs).
    const onChange = () => refresh();
    window.addEventListener(LOCAL_LIST_EVENT, onChange);
    // Recompute immediately when the user flips a notification toggle.
    window.addEventListener(NOTIF_PREFS_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(LOCAL_LIST_EVENT, onChange);
      window.removeEventListener(NOTIF_PREFS_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, [refresh]);

  // NOTE: we deliberately DON'T prune read ids by "no longer live". A refresh
  // hits AniList, and a transient network failure makes computeNotifications
  // return a partial/empty set — pruning then would drop the read state for
  // notifications that merely failed to refetch, so when the fetch later
  // succeeds they'd come back as UNREAD and the badge would reappear (the
  // "badge reappears on tab switch" bug). Instead we just cap the set size.

  const isRead = useCallback((id: string) => readIds.has(id), [readIds]);

  const markAllRead = useCallback(() => {
    setReadIds((prev) => {
      // Keep the most recent ids (current prev order + the now-read ones),
      // de-duped then capped so the set can't grow without bound.
      const merged = Array.from(
        new Set([...Array.from(prev), ...notifications.map((n) => n.id)]),
      );
      const next = new Set(merged.slice(-MAX_READ_IDS));
      writeReadIds(next);
      return next;
    });
  }, [notifications]);

  const unreadCount = notifications.reduce(
    (acc, n) => acc + (readIds.has(n.id) ? 0 : 1),
    0,
  );

  return { notifications, unreadCount, isRead, markAllRead, refresh };
}
