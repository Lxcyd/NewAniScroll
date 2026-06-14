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

  // Prune read ids that no longer correspond to a live notification, so the set
  // doesn't grow forever as episodes advance.
  useEffect(() => {
    if (notifications.length === 0) return;
    setReadIds((prev) => {
      const live = new Set(notifications.map((n) => n.id));
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (live.has(id)) next.add(id);
        else changed = true;
      });
      if (changed) writeReadIds(next);
      return changed ? next : prev;
    });
  }, [notifications]);

  const isRead = useCallback((id: string) => readIds.has(id), [readIds]);

  const markAllRead = useCallback(() => {
    setReadIds((prev) => {
      const next = new Set(prev);
      notifications.forEach((n) => next.add(n.id));
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
