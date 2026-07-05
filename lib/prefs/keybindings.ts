/**
 * Configurable video-player keyboard shortcuts (local, per-device).
 *
 * Same storage pattern as lib/prefs/playerPrefs.ts: one localStorage key, a
 * CustomEvent for same-tab notification, and a hook returning the live value.
 *
 * The map is `actionId -> KeyCombo | null`. A `null` (or missing) entry means
 * the action is unbound. The player installs ONE central keydown handler
 * (see UniversalPlayer) that looks up the pressed combo in this map and runs
 * the matching action — so the whole shortcut system is data-driven and the
 * user can rebind anything from the visual keyboard editor.
 *
 * We store a normalized "combo" string (e.g. "s", "shift+arrowright",
 * "ctrl+m") rather than a raw KeyboardEvent, so the same value round-trips
 * cleanly between capture (editor), display (keyboard glyphs) and matching
 * (runtime handler).
 */

import { useEffect, useState } from "react";

/** Stable identifiers for every bindable player action. */
export type ShortcutAction =
  | "playPause"
  | "prevEpisode"
  | "nextEpisode"
  | "mute"
  | "toggleStats"
  | "pictureInPicture"
  | "seekBackward"
  | "seekForward"
  | "volumeUp"
  | "volumeDown"
  | "rateDown"
  | "rateUp"
  | "rateReset"
  | "skipIntro"
  | "skipOutro"
  | "chromecast"
  | "fullscreen"
  | "screenshot"
  | "subtitles"
  // Extra actions we propose on top of the user's list:
  | "seekBackwardLong"
  | "seekForwardLong"
  | "restart"
  | "seekToEnd"
  | "frameBackward"
  | "frameForward"
  | "toggleTheater"
  | "cycleAspect"
  | "cycleServer"
  | "copyTimestamp";

/** A normalized key combination: lower-cased `event.key`, optionally prefixed
 *  by modifier tokens in a fixed order (ctrl → alt → shift → meta). */
export type KeyCombo = string;

export type Keybindings = Partial<Record<ShortcutAction, KeyCombo | null>>;

/**
 * Action catalog. `group` buckets them in the editor's action list; `i18n` is
 * the translation key for the label. The order here is the order the actions
 * appear in the editor.
 */
export type ActionMeta = {
  id: ShortcutAction;
  i18n: string; // key under `shortcuts.actions.*`
  group: "playback" | "navigation" | "audio" | "speed" | "skip" | "view";
  /** Actions that only make sense on a real <video> (not iframe embeds). Kept
   *  informational; the handler no-ops gracefully when unavailable anyway. */
  directOnly?: boolean;
};

export const ACTION_CATALOG: ActionMeta[] = [
  // Playback
  { id: "playPause", i18n: "playPause", group: "playback" },
  { id: "restart", i18n: "restart", group: "playback", directOnly: true },
  { id: "seekToEnd", i18n: "seekToEnd", group: "playback", directOnly: true },
  // Navigation (episodes / seeking)
  { id: "prevEpisode", i18n: "prevEpisode", group: "navigation" },
  { id: "nextEpisode", i18n: "nextEpisode", group: "navigation" },
  { id: "seekBackward", i18n: "seekBackward", group: "navigation", directOnly: true },
  { id: "seekForward", i18n: "seekForward", group: "navigation", directOnly: true },
  { id: "seekBackwardLong", i18n: "seekBackwardLong", group: "navigation", directOnly: true },
  { id: "seekForwardLong", i18n: "seekForwardLong", group: "navigation", directOnly: true },
  { id: "frameBackward", i18n: "frameBackward", group: "navigation", directOnly: true },
  { id: "frameForward", i18n: "frameForward", group: "navigation", directOnly: true },
  // Skip segments
  { id: "skipIntro", i18n: "skipIntro", group: "skip", directOnly: true },
  { id: "skipOutro", i18n: "skipOutro", group: "skip", directOnly: true },
  // Audio
  { id: "mute", i18n: "mute", group: "audio", directOnly: true },
  { id: "volumeUp", i18n: "volumeUp", group: "audio", directOnly: true },
  { id: "volumeDown", i18n: "volumeDown", group: "audio", directOnly: true },
  // Speed
  { id: "rateDown", i18n: "rateDown", group: "speed", directOnly: true },
  { id: "rateUp", i18n: "rateUp", group: "speed", directOnly: true },
  { id: "rateReset", i18n: "rateReset", group: "speed", directOnly: true },
  // View / output
  { id: "fullscreen", i18n: "fullscreen", group: "view" },
  { id: "toggleTheater", i18n: "toggleTheater", group: "view" },
  { id: "pictureInPicture", i18n: "pictureInPicture", group: "view", directOnly: true },
  { id: "chromecast", i18n: "chromecast", group: "view" },
  { id: "cycleAspect", i18n: "cycleAspect", group: "view", directOnly: true },
  { id: "cycleServer", i18n: "cycleServer", group: "view" },
  { id: "copyTimestamp", i18n: "copyTimestamp", group: "view", directOnly: true },
  { id: "subtitles", i18n: "subtitles", group: "view" },
  { id: "toggleStats", i18n: "toggleStats", group: "view", directOnly: true },
  { id: "screenshot", i18n: "screenshot", group: "view", directOnly: true },
];

/** Sensible defaults, shown on the keyboard out of the box. Chosen to match
 *  common video-player conventions (YouTube / Vidstack) and to avoid clashing
 *  with each other. Single keys where possible; modifiers only when we run out
 *  of obvious letters. */
// Default distribution is inspired by the reference layout the user shared:
// icons scattered across the board rather than clustered. Each still resolves
// to a real, sensible key so the shortcuts are usable out of the box.
export const DEFAULT_KEYBINDINGS: Keybindings = {
  // Home row-ish cluster
  toggleStats: "a", // brightness/stats slot in the ref (top-left of ASDF)
  cycleAspect: "s", // "+90"/rotate slot
  chromecast: "d", // cast slot
  fullscreen: "f", // fullscreen brackets slot
  frameBackward: "l", // ".0 ←" frame-step slot
  frameForward: ";", // ".00 →" frame-step slot
  // Upper (QWERTY) row
  pictureInPicture: "o", // PiP icon
  toggleTheater: "q", // window/theater icon
  subtitles: "u", // list/CC-ish icon
  restart: "p", // rotate-left (restart) slot
  seekToEnd: "[", // rotate-right slot
  // Lower (ZXCV) row
  screenshot: "c", // screen-share/screenshot slot
  prevEpisode: "n", // |◄ previous
  nextEpisode: "m", // ►| next
  mute: ",", // ◄× mute
  // Bottom row + arrows
  playPause: "space", // ► play (spacebar in the ref)
  seekBackward: "arrowleft",
  seekForward: "arrowright",
  volumeUp: "arrowup",
  volumeDown: "arrowdown",
  seekBackwardLong: "j",
  seekForwardLong: "k",
  skipIntro: "1",
  skipOutro: "2",
  rateDown: "9",
  rateUp: "0",
  rateReset: "8",
  cycleServer: "e", // switch player/host (megaplay → vidmoly → …)
  copyTimestamp: "y", // copy a link timestamped at the current time
};

const KEY = "aniscroll:keybindings";
export const KEYBINDINGS_EVENT = "aniscroll:keybindings:change";

export function getKeybindings(): Keybindings {
  if (typeof window === "undefined") return { ...DEFAULT_KEYBINDINGS };
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_KEYBINDINGS };
    const parsed = JSON.parse(raw);
    // Merge over defaults so a stored object missing a newer action still has
    // the default for it (unless the user explicitly unbound it — see below).
    return { ...DEFAULT_KEYBINDINGS, ...parsed };
  } catch {
    return { ...DEFAULT_KEYBINDINGS };
  }
}

export function setKeybindings(patch: Keybindings): Keybindings {
  const next = { ...getKeybindings(), ...patch };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* best-effort */
    }
    window.dispatchEvent(new CustomEvent(KEYBINDINGS_EVENT));
  }
  return next;
}

/** Reset every binding back to the shipped defaults. */
export function resetKeybindings(): Keybindings {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      /* best-effort */
    }
    window.dispatchEvent(new CustomEvent(KEYBINDINGS_EVENT));
  }
  return { ...DEFAULT_KEYBINDINGS };
}

export function useKeybindings(): Keybindings {
  const [binds, setBinds] = useState<Keybindings>(DEFAULT_KEYBINDINGS);
  useEffect(() => {
    const read = () => setBinds(getKeybindings());
    read();
    window.addEventListener(KEYBINDINGS_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(KEYBINDINGS_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return binds;
}

// ── Key combo normalization / display ──────────────────────────────────────

const MOD_ORDER = ["ctrl", "alt", "shift", "meta"] as const;

/**
 * Build a normalized combo string from a KeyboardEvent. Modifiers come first in
 * a fixed order, then the base key (lower-cased `event.key`). Returns null when
 * the event carries only a modifier key (so "press a key" ignores a lone Shift).
 */
export function comboFromEvent(e: KeyboardEvent): KeyCombo | null {
  const key = e.key;
  if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") {
    return null;
  }
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  if (e.metaKey) parts.push("meta");
  // Normalize the base key. Space arrives as " "; store it as "space".
  let base = key.length === 1 ? key.toLowerCase() : key.toLowerCase();
  if (base === " ") base = "space";
  parts.push(base);
  return parts.join("+");
}

/** Same normalization used to match a live event against a stored combo. */
export function eventMatchesCombo(e: KeyboardEvent, combo: KeyCombo): boolean {
  const c = comboFromEvent(e);
  return c !== null && c === combo;
}

/** Map a base key token to a short glyph for the keyboard / chips. */
const KEY_GLYPH: Record<string, string> = {
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  space: "␣",
  comma: ",",
  period: ".",
  ",": ",",
  ".": ".",
  backspace: "⌫",
  enter: "↵",
  escape: "Esc",
  home: "Home",
  end: "End",
  pageup: "PgUp",
  pagedown: "PgDn",
  tab: "⇥",
};

const MOD_GLYPH: Record<string, string> = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "⇧",
  meta: "⌘",
};

/** Human-readable label for a combo, e.g. "shift+arrowright" -> "⇧ →". */
export function comboLabel(combo: KeyCombo | null | undefined): string {
  if (!combo) return "";
  const parts = combo.split("+");
  const base = parts.pop() as string;
  const mods = parts.map((m) => MOD_GLYPH[m] ?? m);
  const baseGlyph = KEY_GLYPH[base] ?? base.toUpperCase();
  return [...mods, baseGlyph].join(" ");
}

/**
 * Given the bindings map, return `combo -> actionId`. Used by the runtime
 * handler for O(1) dispatch and by the editor to detect / surface conflicts
 * (two actions on the same combo — last write wins, we warn in the UI).
 */
export function comboToAction(binds: Keybindings): Map<KeyCombo, ShortcutAction> {
  const map = new Map<KeyCombo, ShortcutAction>();
  (Object.keys(binds) as ShortcutAction[]).forEach((action) => {
    const combo = binds[action];
    if (combo) map.set(combo, action);
  });
  return map;
}
