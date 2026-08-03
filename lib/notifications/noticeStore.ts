// Unified, app-wide notice (toast) store — the single source of truth for
// every transient message in the app (player "subs burned in", party created,
// HTTP errors, settings saved, admin actions, …). Previously the app had two
// competing systems: sonner (`toast.*`, rendered on document.body) and an
// in-player stack living inside UniversalPlayer. They never co-stacked, so a
// "party created" toast and a "subs burned in" notice piled in two different
// corners. This store replaces sonner entirely; a single <NoticeStack> renders
// it, and it portals INTO the player when the player is fullscreen.
//
// Framework-agnostic (plain observable) so any module can call `notify()`
// without React context, plus a `useNotices()` hook for the renderer.
import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";

export type NoticeType = "error" | "success" | "info" | "message";

// An optional inline action button (e.g. "Undo" on a discover swipe), matching
// sonner's `{ label, onClick }` shape.
export interface NoticeAction {
  label: string;
  onClick: () => void;
}

export interface Notice {
  id: string | number;
  type: NoticeType;
  msg: string;
  description?: string;
  // Custom leading icon (emoji string or node). When absent the renderer picks
  // a default glyph per type.
  icon?: ReactNode;
  // Auto-dismiss delay in ms. Infinity → persistent card (no countdown, no
  // timer; only the ✕ / an explicit dismiss removes it).
  dur: number;
  important?: boolean;
  className?: string;
  action?: NoticeAction;
  onDismiss?: () => void;
}

export interface NotifyOptions {
  type?: NoticeType;
  description?: string;
  icon?: ReactNode;
  // ms, or Infinity for persistent. Defaults to DEFAULT_DUR.
  duration?: number;
  // Stable id → update-in-place instead of stacking a duplicate (used by the
  // global broadcast toast and the AniList health banner, which re-fire on a
  // poll but must not pile up).
  id?: string | number;
  important?: boolean;
  className?: string;
  action?: NoticeAction;
  onDismiss?: () => void;
}

// Every transient notice shares the same on-screen lifetime (5s), whatever its
// type. Persistent banners opt out explicitly with duration: Infinity.
const DEFAULT_DUR = 5000;

let notices: Notice[] = [];
const listeners = new Set<() => void>();
// Auto-dismiss timers, keyed by notice id, cleared when a notice is removed or
// replaced in place.
const timers = new Map<string | number, ReturnType<typeof setTimeout>>();
let autoId = 0;

function emit() {
  // New array identity so useSyncExternalStore's getSnapshot returns a fresh
  // reference and React re-renders.
  notices = notices.slice();
  listeners.forEach((l) => l());
}

function clearTimer(id: string | number) {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
}

function armTimer(n: Notice) {
  if (!Number.isFinite(n.dur)) return; // persistent
  clearTimer(n.id);
  timers.set(
    n.id,
    setTimeout(() => dismissNotice(n.id), n.dur),
  );
}

export function dismissNotice(id: string | number) {
  const n = notices.find((x) => x.id === id);
  if (!n) return;
  clearTimer(id);
  notices = notices.filter((x) => x.id !== id);
  emit();
  n.onDismiss?.();
}

function push(msg: string, opts: NotifyOptions = {}): string | number {
  const id = opts.id ?? `n${++autoId}`;
  const notice: Notice = {
    id,
    type: opts.type ?? "message",
    msg,
    description: opts.description,
    icon: opts.icon,
    dur: opts.duration ?? DEFAULT_DUR,
    important: opts.important,
    className: opts.className,
    action: opts.action,
    onDismiss: opts.onDismiss,
  };
  const existingIdx = notices.findIndex((x) => x.id === id);
  if (existingIdx >= 0) {
    // Update-in-place: replace the existing card, keep its slot in the stack.
    notices = notices.slice();
    notices[existingIdx] = notice;
  } else {
    notices = [...notices, notice];
  }
  emit();
  armTimer(notice);
  return id;
}

// Primary API. `notify(msg, opts)` plus sonner-parity helpers so migrating the
// ~50 call sites is a mechanical `toast.success` → `notify.success` swap.
interface PromiseMessages<T> {
  loading: string;
  success: string | ((data: T) => string);
  error: string | ((err: unknown) => string);
}

type NotifyFn = ((msg: string, opts?: NotifyOptions) => string | number) & {
  success: (msg: string, opts?: NotifyOptions) => string | number;
  error: (msg: string, opts?: NotifyOptions) => string | number;
  info: (msg: string, opts?: NotifyOptions) => string | number;
  message: (msg: string, opts?: NotifyOptions) => string | number;
  dismiss: (id: string | number) => void;
  // sonner-parity: show a loading card that updates to success/error when the
  // promise settles. Uses a stable id so it updates in place.
  promise: <T>(p: Promise<T>, msgs: PromiseMessages<T>) => Promise<T>;
};

export const notify: NotifyFn = Object.assign(
  (msg: string, opts?: NotifyOptions) => push(msg, opts),
  {
    success: (msg: string, opts?: NotifyOptions) =>
      push(msg, { ...opts, type: "success" }),
    error: (msg: string, opts?: NotifyOptions) =>
      push(msg, { ...opts, type: "error" }),
    info: (msg: string, opts?: NotifyOptions) =>
      push(msg, { ...opts, type: "info" }),
    message: (msg: string, opts?: NotifyOptions) =>
      push(msg, { ...opts, type: "message" }),
    dismiss: (id: string | number) => dismissNotice(id),
    promise: <T,>(p: Promise<T>, msgs: PromiseMessages<T>) => {
      const id = `p${++autoId}`;
      // Loading card is persistent until the promise settles, then we update it
      // in place to success/error with a normal auto-dismiss.
      push(msgs.loading, { id, type: "info", duration: Infinity });
      p.then(
        (data) => {
          const m =
            typeof msgs.success === "function" ? msgs.success(data) : msgs.success;
          push(m, { id, type: "success" });
        },
        (err) => {
          const m =
            typeof msgs.error === "function" ? msgs.error(err) : msgs.error;
          push(m, { id, type: "error" });
        },
      );
      return p;
    },
  },
);

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot() {
  return notices;
}

// Stable empty snapshot for SSR (no notices exist server-side).
const EMPTY: Notice[] = [];
function getServerSnapshot() {
  return EMPTY;
}

export function useNotices(): Notice[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
