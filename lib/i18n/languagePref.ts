/**
 * User language preference for the whole UI.
 *
 * Detection order (first match wins):
 *   1. Explicit override stored in localStorage (the user picked a language
 *      from the navbar switcher) — this always takes priority.
 *   2. The browser's preferred language (`navigator.languages` /
 *      `navigator.language`). Anything starting with "fr" → French.
 *   3. Fallback to English.
 *
 * Mirrors the lib/prefs/titlePref.ts pattern: localStorage + a same-tab
 * CustomEvent so every mounted component re-reads when the language changes,
 * with no `Vary: Cookie` penalty on the CDN cache (detection is client-side
 * only; first SSR paint is always the fallback locale and the client
 * re-renders into the detected/chosen language once mounted).
 */

export type Lang = "en" | "fr";

export const SUPPORTED_LANGS: Lang[] = ["en", "fr"];
export const DEFAULT_LANG: Lang = "en";

const STORAGE_KEY = "aniscroll:lang";
const EVENT = "aniscroll:lang:change";

/** True when the user has explicitly chosen a language (vs auto-detected). */
export function hasExplicitLang(): boolean {
  if (typeof window === "undefined") return false;
  return SUPPORTED_LANGS.includes(
    window.localStorage.getItem(STORAGE_KEY) as Lang,
  );
}

/** Best-guess language from the browser settings. */
function detectBrowserLang(): Lang {
  if (typeof navigator === "undefined") return DEFAULT_LANG;
  const candidates = [
    ...(navigator.languages || []),
    navigator.language,
  ].filter(Boolean);
  for (const c of candidates) {
    if (c.toLowerCase().startsWith("fr")) return "fr";
    if (c.toLowerCase().startsWith("en")) return "en";
  }
  return DEFAULT_LANG;
}

/**
 * Resolve the active language: explicit override first, then browser
 * detection, then the default.
 */
export function getLang(): Lang {
  if (typeof window === "undefined") return DEFAULT_LANG;
  const stored = window.localStorage.getItem(STORAGE_KEY) as Lang | null;
  if (stored && SUPPORTED_LANGS.includes(stored)) return stored;
  return detectBrowserLang();
}

/** Persist an explicit language choice and notify the app. */
export function setLang(lang: Lang) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, lang);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: lang }));
}

export const LANG_EVENT = EVENT;
