/**
 * « Afficher le contenu adulte » (hentai, anime adultes), local a l'appareil.
 *
 * Meme motif que lib/prefs/spoilerPrefs.ts : une cle localStorage, un
 * CustomEvent pour l'onglet courant, un hook. ETEINT PAR DEFAUT (10/11/2026,
 * Luc). Il ne leve le filtre que dans les RECHERCHES (page de recherche et
 * palette) : les accueils, catalogues et decouvertes restent sans adulte.
 */

import { useEffect, useState } from "react";

const KEY = "aniscroll:showAdult";
export const SHOW_ADULT_EVENT = "aniscroll:showAdult:change";

export function getShowAdult(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setShowAdult(next: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    /* best-effort */
  }
  window.dispatchEvent(new CustomEvent(SHOW_ADULT_EVENT));
}

export function useShowAdult(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const read = () => setOn(getShowAdult());
    read();
    window.addEventListener(SHOW_ADULT_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(SHOW_ADULT_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return on;
}
