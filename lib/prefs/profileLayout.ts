/**
 * La disposition des widgets du profil (position, taille, blocs posés).
 *
 * Même patron que les autres préférences (lib/prefs/spoilerPrefs.ts) : une clé
 * localStorage, un CustomEvent pour le même onglet, un hook pour la valeur
 * vivante.
 *
 * ET le compte, sans écrire une ligne de serveur : `lib/list/cloudSync.ts`
 * range dans la catégorie `prefs` TOUTE clé `aniscroll:*` non réclamée par une
 * autre catégorie (cf. son `isPrefsKey`), donc cette clé part avec elles dès
 * qu'un compte existe. La seule chose à faire côté sync est d'écouter notre
 * événement pour déclencher la poussée — c'est fait dans cloudSync.start().
 *
 * Conséquence voulue : déconnecté, la disposition vit sur l'appareil ; connecté,
 * elle suit le compte, avec l'arbitrage last-writer-wins par catégorie déjà en
 * place. Rien de neuf à réconcilier.
 */

import { useEffect, useState } from "react";
import { isValidLayout, type GridItem } from "@/lib/profile/grid";

const KEY = "aniscroll:profileLayout";
export const PROFILE_LAYOUT_EVENT = "aniscroll:profileLayout:change";

/** null = « jamais touché » — l'appelant applique alors sa disposition par
 *  défaut, qui peut donc évoluer sans figer les profils existants. */
export function getProfileLayout(): GridItem[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isValidLayout(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function setProfileLayout(layout: GridItem[] | null): void {
  if (typeof window === "undefined") return;
  try {
    if (layout) window.localStorage.setItem(KEY, JSON.stringify(layout));
    else window.localStorage.removeItem(KEY);
  } catch {
    /* quota — au pire la disposition ne survit pas au rechargement */
  }
  window.dispatchEvent(new CustomEvent(PROFILE_LAYOUT_EVENT));
}

/**
 * La disposition stockée, ou null tant que rien n'a été lu.
 *
 * `loaded` distingue « pas encore lu » de « rien de stocké » : sans lui, le
 * premier rendu serveur et le premier rendu client ne peuvent pas s'accorder,
 * et React remplacerait la grille juste après l'avoir peinte.
 */
export function useProfileLayout(): {
  layout: GridItem[] | null;
  loaded: boolean;
} {
  const [state, setState] = useState<{ layout: GridItem[] | null; loaded: boolean }>({
    layout: null,
    loaded: false,
  });
  useEffect(() => {
    const read = () => setState({ layout: getProfileLayout(), loaded: true });
    read();
    window.addEventListener(PROFILE_LAYOUT_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(PROFILE_LAYOUT_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return state;
}
