/**
 * User preference for how anime titles are displayed across the site.
 *
 * Stored in localStorage (client-only) — there's no SSR-aware lookup, so
 * the very first paint of every page uses the default ("en") and the
 * client re-renders into the chosen preference once mounted. Trade-off:
 * a brief flash on first load in exchange for keeping the CDN cache
 * keyed on URL alone (no `Vary: Cookie` penalty).
 *
 * Why no "fr" option: AniList doesn't expose a French title field, and
 * scraping synonyms for a heuristic French detection is unreliable. The
 * user is told this explicitly in the Settings UI.
 */

import { useEffect, useState } from "react";

export type TitlePref = "en" | "romaji";

const STORAGE_KEY = "aniscroll:titlePref";
const EVENT = "aniscroll:titlePref:change";

export function getTitlePref(): TitlePref {
  if (typeof window === "undefined") return "en";
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === "romaji" ? "romaji" : "en";
}

export function setTitlePref(pref: TitlePref) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, pref);
  // Cross-component notification: every <PickTitle/> mounted on the page
  // subscribes to this event and re-reads from localStorage. We don't use
  // the native `storage` event because it only fires across tabs, not
  // within the same tab.
  window.dispatchEvent(new CustomEvent(EVENT));
}

/**
 * Hook returning the live title preference. Re-renders the caller every
 * time `setTitlePref` is called anywhere in the app.
 */
export function useTitlePref(): TitlePref {
  const [pref, setPref] = useState<TitlePref>("en");
  useEffect(() => {
    setPref(getTitlePref());
    const onChange = () => setPref(getTitlePref());
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);
  return pref;
}

/* AniList "title" shape — we accept a loose superset so callers can pass
   whatever shape their query returned (full Media object, partial, etc.). */
type TitleShape = {
  english?: string | null;
  romaji?: string | null;
  native?: string | null;
  userPreferred?: string | null;
} | null | undefined;

/**
 * Pick the right title string for the given preference, with sensible
 * fallbacks. Never returns an empty string — if everything is null we
 * return "Untitled" so the UI never renders an empty heading.
 *
 *   pickTitle(title, "en")     → english || romaji || userPreferred || native
 *   pickTitle(title, "romaji") → romaji  || english || userPreferred || native
 *
 * Some queries only request `userPreferred` (e.g. cached cards in the
 * recommendation row) — we fall back to it after the explicit picks so
 * those components don't silently render "Untitled" when the user has
 * never opened a full media query for that id.
 */
export function pickTitle(title: TitleShape, pref: TitlePref): string {
  if (!title) return "Untitled";
  if (pref === "romaji") {
    return (
      title.romaji ||
      title.english ||
      title.userPreferred ||
      title.native ||
      "Untitled"
    );
  }
  return (
    title.english ||
    title.romaji ||
    title.userPreferred ||
    title.native ||
    "Untitled"
  );
}
