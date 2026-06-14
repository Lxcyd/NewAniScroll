/**
 * Watch streak — consecutive days with at least one episode finished.
 *
 * Local-only (localStorage), same pattern as the other pref stores. We record a
 * "watch happened today" mark on every episode finish; the streak is the run of
 * consecutive calendar days ending today (or yesterday — a streak you haven't
 * broken yet because today isn't over). Stored as { lastDay, current, best }.
 *
 * Days are local-calendar `YYYY-MM-DD` strings so the boundary follows the
 * user's timezone, not UTC.
 */

import { useEffect, useState } from "react";

export type StreakState = {
  /** Last day (YYYY-MM-DD) an episode was finished. */
  lastDay: string | null;
  /** Current consecutive-day run ending on lastDay. */
  current: number;
  /** Best run ever reached. */
  best: number;
};

const KEY = "aniscroll:streak";
export const STREAK_EVENT = "aniscroll:streak:change";

function dayKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Difference in whole calendar days between two YYYY-MM-DD strings (b - a). */
function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const ta = Date.UTC(ay, am - 1, ad);
  const tb = Date.UTC(by, bm - 1, bd);
  return Math.round((tb - ta) / 86_400_000);
}

const EMPTY: StreakState = { lastDay: null, current: 0, best: 0 };

export function getStreak(): StreakState {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw);
    return {
      lastDay: typeof parsed?.lastDay === "string" ? parsed.lastDay : null,
      current: Number(parsed?.current) || 0,
      best: Number(parsed?.best) || 0,
    };
  } catch {
    return EMPTY;
  }
}

function write(state: StreakState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* best-effort */
  }
  window.dispatchEvent(new CustomEvent(STREAK_EVENT));
}

/**
 * Record that the user finished an episode today, updating the streak.
 *  - same day as lastDay → no change (already counted today),
 *  - exactly +1 day → streak continues,
 *  - any larger gap (or first ever) → streak resets to 1.
 * Idempotent within a day. Returns the new state.
 */
export function recordWatchToday(): StreakState {
  const prev = getStreak();
  const today = dayKey();
  if (prev.lastDay === today) return prev; // already counted

  let current: number;
  if (prev.lastDay && dayDiff(prev.lastDay, today) === 1) {
    current = prev.current + 1; // consecutive day
  } else {
    current = 1; // first watch, or a gap broke the streak
  }
  const next: StreakState = {
    lastDay: today,
    current,
    best: Math.max(prev.best, current),
  };
  write(next);
  return next;
}

/**
 * The streak as it should DISPLAY right now. The stored `current` is only valid
 * if the last watch was today or yesterday; if the user missed a full day the
 * streak is effectively broken (shown as 0) even though we haven't rewritten it.
 */
export function liveStreak(state: StreakState = getStreak()): number {
  if (!state.lastDay) return 0;
  const gap = dayDiff(state.lastDay, dayKey());
  return gap <= 1 ? state.current : 0;
}

export function useStreak(): { current: number; best: number } {
  const [state, setState] = useState<StreakState>(EMPTY);
  useEffect(() => {
    const read = () => setState(getStreak());
    read();
    window.addEventListener(STREAK_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(STREAK_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return { current: liveStreak(state), best: state.best };
}
