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
  | "frameBackward"
  | "frameForward"
  | "cycleServer"
  | "copyTimestamp"
  | "rotate"
  // Jump to N×10% of the runtime (YouTube-style number-row seek).
  | "seekPct10"
  | "seekPct20"
  | "seekPct30"
  | "seekPct40"
  | "seekPct50"
  | "seekPct60"
  | "seekPct70"
  | "seekPct80"
  | "seekPct90";

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
  // Navigation (episodes / seeking)
  { id: "prevEpisode", i18n: "prevEpisode", group: "navigation" },
  { id: "nextEpisode", i18n: "nextEpisode", group: "navigation" },
  { id: "seekBackward", i18n: "seekBackward", group: "navigation", directOnly: true },
  { id: "seekForward", i18n: "seekForward", group: "navigation", directOnly: true },
  { id: "seekBackwardLong", i18n: "seekBackwardLong", group: "navigation", directOnly: true },
  { id: "seekForwardLong", i18n: "seekForwardLong", group: "navigation", directOnly: true },
  { id: "frameBackward", i18n: "frameBackward", group: "navigation", directOnly: true },
  { id: "frameForward", i18n: "frameForward", group: "navigation", directOnly: true },
  // Percentage jumps (YouTube-style 1–9). Grouped under navigation.
  { id: "seekPct10", i18n: "seekPct10", group: "navigation", directOnly: true },
  { id: "seekPct20", i18n: "seekPct20", group: "navigation", directOnly: true },
  { id: "seekPct30", i18n: "seekPct30", group: "navigation", directOnly: true },
  { id: "seekPct40", i18n: "seekPct40", group: "navigation", directOnly: true },
  { id: "seekPct50", i18n: "seekPct50", group: "navigation", directOnly: true },
  { id: "seekPct60", i18n: "seekPct60", group: "navigation", directOnly: true },
  { id: "seekPct70", i18n: "seekPct70", group: "navigation", directOnly: true },
  { id: "seekPct80", i18n: "seekPct80", group: "navigation", directOnly: true },
  { id: "seekPct90", i18n: "seekPct90", group: "navigation", directOnly: true },
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
  { id: "pictureInPicture", i18n: "pictureInPicture", group: "view", directOnly: true },
  { id: "chromecast", i18n: "chromecast", group: "view" },
  { id: "cycleServer", i18n: "cycleServer", group: "view" },
  { id: "copyTimestamp", i18n: "copyTimestamp", group: "view", directOnly: true },
  { id: "rotate", i18n: "rotate", group: "view", directOnly: true },
  { id: "subtitles", i18n: "subtitles", group: "view" },
  { id: "toggleStats", i18n: "toggleStats", group: "view", directOnly: true },
  { id: "screenshot", i18n: "screenshot", group: "view", directOnly: true },
];

/** Sensible defaults, shown on the keyboard out of the box. Chosen to match
 *  common video-player conventions (YouTube / Vidstack) and to avoid clashing
 *  with each other. Single keys where possible; modifiers only when we run out
 *  of obvious letters. */
// Values are `event.code` (physical positions), matching what the visual editor
// stores and what `comboFromEvent` compares against. The comments give the
// AZERTY label printed on that physical key.
export const DEFAULT_KEYBINDINGS: Keybindings = {
  // Number row: 1–9 = jump to 10–90%, backspace = ↺ restart.
  seekPct10: "digit1",
  seekPct20: "digit2",
  seekPct30: "digit3",
  seekPct40: "digit4",
  seekPct50: "digit5",
  seekPct60: "digit6",
  seekPct70: "digit7",
  seekPct80: "digit8",
  seekPct90: "digit9",
  restart: "backspace",
  // Upper row (a z e r t y u i o p ^ $)
  cycleServer: "keyw", // "z" cap — ⟳ cycle player
  subtitles: "keyt", // "t" — tracks/list
  copyTimestamp: "keyy", // "y" — 🔗 link
  pictureInPicture: "keyo", // "o" — ▣ PiP
  // Home row (q s d f g h j k l m ù *)
  toggleStats: "keys", // "s"
  nextEpisode: "keyd", // "d"
  prevEpisode: "keyf", // "f"
  fullscreen: "keyg", // "g"
  seekBackwardLong: "keyj", // "j" — −5s
  seekForwardLong: "keyl", // "l" — +5s
  frameBackward: "semicolon", // "m"
  frameForward: "quote", // "ù"
  // Bottom letter row (w x c v b n , ; : !)
  chromecast: "keyc", // "c" — cast
  screenshot: "keyv", // "v"
  mute: "keyn", // "n"
  rotate: "keym", // "," cap (physical KeyM on AZERTY) — rotate 90°
  // Speed on the ; : ! cluster — AZERTY physical positions Comma/Period/Slash.
  rateDown: "comma", // ";" cap
  rateUp: "period", // ":" cap
  rateReset: "slash", // "!" cap
  // Space + arrows.
  playPause: "space",
  seekBackward: "arrowleft",
  seekForward: "arrowright",
  volumeUp: "arrowup",
  volumeDown: "arrowdown",
  // Skip intro/outro on PgUp/PgDn. EVERY action ships bound — the editor has
  // no unbind path (drops swap), so the full catalog must have a default key.
  skipIntro: "pageup",
  skipOutro: "pagedown",
};

// v3: event.code storage; v3 fixed the AZERTY bottom-row codes (bumped so the
// v2 defaults that were saved with wrong codes are discarded).
const KEY = "aniscroll:keybindings:v3";
export const KEYBINDINGS_EVENT = "aniscroll:keybindings:change";

export function getKeybindings(): Keybindings {
  if (typeof window === "undefined") return { ...DEFAULT_KEYBINDINGS };
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_KEYBINDINGS };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Merge over defaults so a stored object missing a newer action still has
    // the default for it. Null/empty entries (from older versions that allowed
    // unbinding) are DROPPED so the default reclaims the action — every action
    // must always be bound.
    const clean: Keybindings = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v) clean[k as ShortcutAction] = v;
    }
    return { ...DEFAULT_KEYBINDINGS, ...clean };
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
 * Build a normalized combo string from a KeyboardEvent.
 *
 * We key off `event.code` (the PHYSICAL key position, lower-cased) rather than
 * `event.key` (the produced character). This is layout-agnostic and, crucially,
 * does NOT require Shift: on an AZERTY keyboard the digit row and much of the
 * punctuation only yield "1", ";", "!", … as `event.key` WITH Shift held, so a
 * key-based binding never matched a plain press. `event.code` ("Digit1",
 * "Semicolon", "ShiftLeft", …) is stable and is exactly what the visual editor
 * stores for each cap.
 */
export function comboFromEvent(e: KeyboardEvent): KeyCombo | null {
  if (!e.code) return null;
  const code = e.code.toLowerCase();
  // Numpad digits fold onto the main digit row so a numpad "1" fires the same
  // binding as the top-row "1" (Num Lock must be on to emit NumpadN).
  const np = code.match(/^numpad(\d)$/);
  if (np) return `digit${np[1]}`;
  return code;
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
  delete: "Suppr",
  capslock: "⇪",
  shiftleft: "⇧",
  shiftright: "⇧",
  controlleft: "Ctrl",
  controlright: "Ctrl",
  metaleft: "⊞",
  metaright: "⊞",
  altleft: "Alt",
  altright: "AltGr",
  contextmenu: "☰",
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
