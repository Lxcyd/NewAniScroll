/**
 * The hover preview's own switch and its delay (local, per-device).
 *
 * The preview was unconditional: a fine pointer and a wide enough window were
 * the only conditions, so anyone who found the trailer card intrusive had no
 * way to say so, and the one number that decides when it appears was a constant
 * in the provider. Both are opinions about how you browse, which is what the
 * settings page is for.
 *
 * Same pattern as the other pref stores: one localStorage key each, a
 * CustomEvent for same-tab notification, and a hook returning the live value.
 * The `aniscroll:` prefix keeps them inside "restore default settings".
 */

import { useEffect, useState } from "react";

const ENABLED_KEY = "aniscroll:preview:enabled";
const DELAY_KEY = "aniscroll:preview:delay";
export const PREVIEW_PREFS_EVENT = "aniscroll:preview:prefs:change";

/**
 * How long the pointer must hold still before a card opens, in milliseconds.
 *
 * This was `STILL_TIME` in HoverPreviewProvider, and its reasoning is the floor
 * of the range below. Hayase uses 30ms, which is short enough to be beaten by a
 * hand that is still moving: micro-adjustments over a small area are not a
 * smooth stream of events but bursts separated by pauses, and any pause longer
 * than the delay opens a card the pointer was only passing over. The window has
 * to be wider than the gaps in a moving hand for "still" to mean still.
 */
export const PREVIEW_DEFAULT_DELAY = 200;
/** Under this, a travelling pointer trips the card — see above. */
export const PREVIEW_MIN_DELAY = 200;
/** Three seconds of holding still is already someone who has stopped reading. */
export const PREVIEW_MAX_DELAY = 3000;

const clampDelay = (ms: number) =>
  Math.min(PREVIEW_MAX_DELAY, Math.max(PREVIEW_MIN_DELAY, Math.round(ms)));

/** On unless turned off: this is how the site has always behaved. */
export function getPreviewEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setPreviewEnabled(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
  } catch {
    /* best-effort */
  }
  window.dispatchEvent(new CustomEvent(PREVIEW_PREFS_EVENT));
}

export function getPreviewDelay(): number {
  if (typeof window === "undefined") return PREVIEW_DEFAULT_DELAY;
  try {
    const raw = window.localStorage.getItem(DELAY_KEY);
    const ms = raw == null ? NaN : parseInt(raw, 10);
    return Number.isFinite(ms) ? clampDelay(ms) : PREVIEW_DEFAULT_DELAY;
  } catch {
    return PREVIEW_DEFAULT_DELAY;
  }
}

export function setPreviewDelay(ms: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DELAY_KEY, String(clampDelay(ms)));
  } catch {
    /* best-effort */
  }
  window.dispatchEvent(new CustomEvent(PREVIEW_PREFS_EVENT));
}

/**
 * Both values, live.
 *
 * Seeded with the defaults rather than with storage: the provider renders on the
 * server too, and reading localStorage during the first render would make the
 * markup disagree with itself. The effect corrects it before any pointer can
 * have moved.
 */
export function usePreviewPrefs(): { enabled: boolean; delay: number } {
  const [prefs, setPrefs] = useState({ enabled: true, delay: PREVIEW_DEFAULT_DELAY });
  useEffect(() => {
    const read = () => setPrefs({ enabled: getPreviewEnabled(), delay: getPreviewDelay() });
    read();
    window.addEventListener(PREVIEW_PREFS_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(PREVIEW_PREFS_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return prefs;
}
