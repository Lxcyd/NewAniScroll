/**
 * Manual "watch next" queue — an ordered list of media ids the user lines up to
 * watch, independent of their list status (Planning/Current/…). Local-only,
 * same pattern as the other stores: one localStorage key, a CustomEvent, hooks.
 *
 * Entries cache title + cover so the queue renders without an extra fetch.
 */

import { useEffect, useState } from "react";
import type { LocalTitle } from "./localList";

export type QueueItem = {
  mediaId: number;
  title?: LocalTitle;
  coverImage?: string | null;
  /** epoch ms added — used only as a stable tiebreaker; order is explicit. */
  addedAt: number;
};

const KEY = "aniscroll:queue";
export const QUEUE_EVENT = "aniscroll:queue:change";

function read(): QueueItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((e) => Number.isFinite(e?.mediaId)) : [];
  } catch {
    return [];
  }
}

function write(items: QueueItem[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* best-effort */
  }
  window.dispatchEvent(new CustomEvent(QUEUE_EVENT));
}

export function getQueue(): QueueItem[] {
  return read();
}

export function isQueued(mediaId: number): boolean {
  return read().some((e) => e.mediaId === mediaId);
}

/** Add to the END of the queue (no-op if already present). */
export function addToQueue(item: {
  mediaId: number;
  title?: LocalTitle;
  coverImage?: string | null;
}): void {
  const items = read();
  if (items.some((e) => e.mediaId === item.mediaId)) return;
  items.push({
    mediaId: item.mediaId,
    title: item.title,
    coverImage: item.coverImage ?? null,
    addedAt: Date.now(),
  });
  write(items);
}

export function removeFromQueue(mediaId: number): void {
  const items = read().filter((e) => e.mediaId !== mediaId);
  write(items);
}

/** Toggle membership; returns the new state (true = now queued). */
export function toggleQueue(item: {
  mediaId: number;
  title?: LocalTitle;
  coverImage?: string | null;
}): boolean {
  if (isQueued(item.mediaId)) {
    removeFromQueue(item.mediaId);
    return false;
  }
  addToQueue(item);
  return true;
}

/** Move an item up (dir -1) or down (dir +1) one slot. */
export function moveInQueue(mediaId: number, dir: -1 | 1): void {
  const items = read();
  const i = items.findIndex((e) => e.mediaId === mediaId);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= items.length) return;
  [items[i], items[j]] = [items[j], items[i]];
  write(items);
}

/** Live queue + whether a given id is queued. */
export function useQueue(): QueueItem[] {
  const [items, setItems] = useState<QueueItem[]>([]);
  useEffect(() => {
    const refresh = () => setItems(read());
    refresh();
    window.addEventListener(QUEUE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(QUEUE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return items;
}

/** Reactive "is this id queued" for a single button. */
export function useIsQueued(mediaId: number): boolean {
  const items = useQueue();
  return items.some((e) => e.mediaId === mediaId);
}
