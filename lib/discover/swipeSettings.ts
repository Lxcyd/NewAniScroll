/**
 * Swipe-settings model + status helpers for the Discover feed.
 *
 * Ported from the reference AniScroll (MAUI) project's SwipeSettings.cs +
 * UiHelpers + Index.razor's GetSwipeHintIcon. That project had a local
 * custom-list backend; this one doesn't, so we expose the AniList status set
 * only (no custom lists). Swiping right/left assigns one of these statuses to
 * the active anime via SaveMediaListEntry.
 */

import type { Status } from "@/lib/list/types";

export type SwipeSettings = {
  /** Status applied when swiping RIGHT (default: COMPLETED) */
  rightStatus: Status;
  /** Status applied when swiping LEFT (default: PLANNING) */
  leftStatus: Status;
};

export const DEFAULT_SWIPE_SETTINGS: SwipeSettings = {
  rightStatus: "COMPLETED",
  leftStatus: "PLANNING",
};

const STORAGE_KEY = "discover_swipe_settings";

/** Statuses offered in the settings panel, in display order. */
export const SWIPE_STATUS_OPTIONS: Status[] = [
  "CURRENT",
  "REPEATING",
  "COMPLETED",
  "PLANNING",
  "PAUSED",
  "DROPPED",
];

/** Hex colour per status — mirrors the as-* tokens in tailwind.config.js so the
 *  feather gradients (built inline from hex) match the rest of the app. */
export const STATUS_COLOR: Record<Status, string> = {
  CURRENT: "#10B981", // watching
  REPEATING: "#06B6D4", // rewatching
  COMPLETED: "#3B82F6",
  PLANNING: "#A855F7",
  PAUSED: "#F59E0B",
  DROPPED: "#EF4444",
};

/** i18n key suffix per status — resolved as discover.status.<key>. */
export const STATUS_LABEL_KEY: Record<Status, string> = {
  CURRENT: "watching",
  REPEATING: "rewatching",
  COMPLETED: "completed",
  PLANNING: "planning",
  PAUSED: "paused",
  DROPPED: "dropped",
};

/** Inline SVG markup per status — ported verbatim from the reference repo's
 *  GetSwipeHintIcon so the hint pills render the same glyphs. */
export const STATUS_ICON: Record<Status, string> = {
  CURRENT:
    '<svg width="11" height="11" viewBox="0 0 512 512" fill="none" stroke="currentColor" stroke-miterlimit="10" stroke-width="32"><path d="M112 111v290c0 17.44 17 28.52 31 20.16l247.9-148.37c12.12-7.25 12.12-26.33 0-33.58L143 90.84c-14-8.36-31 2.72-31 20.16z"/></svg>',
  REPEATING:
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/></svg>',
  COMPLETED:
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  PLANNING:
    '<svg width="10" height="10" viewBox="0 0 512 512" fill="none" stroke="currentColor" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"><path d="M352 48H160a48 48 0 00-48 48v368l144-128 144 128V96a48 48 0 00-48-48z"/></svg>',
  PAUSED:
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="7" y1="4" x2="7" y2="20"/><line x1="17" y1="4" x2="17" y2="20"/></svg>',
  DROPPED:
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
};

/** Build the feather gradient inline-style from a hex colour. Direction points
 *  inward from the swipe edge, matching the reference's GetFeatherStyle. */
export function featherGradient(hex: string, isRight: boolean): string {
  const c = hex.replace(/^#/, "");
  const direction = isRight ? "to left" : "to right";
  return (
    `linear-gradient(${direction},` +
    `#${c}61 0%,#${c}38 14%,#${c}1a 36%,#${c}07 62%,transparent 100%)`
  );
}

export function loadSwipeSettings(): SwipeSettings {
  if (typeof window === "undefined") return DEFAULT_SWIPE_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SWIPE_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<SwipeSettings>;
    return {
      rightStatus: parsed.rightStatus ?? DEFAULT_SWIPE_SETTINGS.rightStatus,
      leftStatus: parsed.leftStatus ?? DEFAULT_SWIPE_SETTINGS.leftStatus,
    };
  } catch {
    return DEFAULT_SWIPE_SETTINGS;
  }
}

export function saveSwipeSettings(s: SwipeSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* non-fatal */
  }
}
