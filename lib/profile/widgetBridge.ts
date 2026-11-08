import { useSyncExternalStore } from "react";
import type { BlockChrome } from "@/components/profile/WidgetGrid";

/**
 * LE PONT ENTRE LA GRILLE ET LE MENU WIDGETS DU STUDIO (07/11/2026, Luc).
 *
 * La grille de l'aperçu (ProfileOverview) et le studio (BannerStudio) ne
 * partagent aucun parent qui tienne la disposition : c'est la grille qui la
 * possède, l'enregistre et sait où poser un bloc. Elle publie ici les blocs
 * posés, de quoi en ajouter un et son contenu (pour l'aperçu du menu). Le
 * studio les lit. Sans grille montée (autre onglet que l'Aperçu), tout est nul.
 */
/** `gridW` : la largeur de la grille du profil, en px de mise en page (0 si
    elle n'est pas mesurée) — l'aperçu est dessiné à cette taille, puis réduit. */
export type WidgetPreview = { chrome: BlockChrome; w: number; h: number; gridW: number };

type Bridge = {
  /** Les blocs qu'on ne peut plus ajouter (posés autant de fois que permis). */
  posed: ReadonlySet<string>;
  /** Le nombre de widgets sur le profil, instances comprises. */
  count: number;
  /** Ajouter le bloc à la fin de la grille (rien s'il est au plafond), puis
      descendre jusqu'à lui et le faire apparaître. */
  add: ((id: string) => void) | null;
  /** Le contenu du bloc, tel que la grille le dessine, et sa taille en cases
      (celle qu'il a sur le profil, sinon celle qu'il aura en y entrant). */
  preview: ((id: string) => WidgetPreview | null) | null;
};

/** Le bouton sous la grille demande au studio d'ouvrir son menu Widgets. */
export const WIDGETS_MENU_EVENT = "as-studio-widgets";
/** Le bouton « Réinitialiser » de l'en-tête du profil remet la grille de
    l'Aperçu à sa disposition par défaut. */
export const WIDGETS_RESET_EVENT = "as-widgets-reset";

export const NO_WIDGETS: Bridge = { posed: new Set(), count: 0, add: null, preview: null };
let state: Bridge = NO_WIDGETS;
const subs = new Set<() => void>();

export function publishWidgets(next: Bridge) {
  state = next;
  subs.forEach((f) => f());
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};
const read = () => state;

export function useWidgetBridge(): Bridge {
  return useSyncExternalStore(subscribe, read, read);
}

/* LE MENU WIDGETS EST-IL OUVERT ? Le studio le dit, la grille l'écoute : le
   bouton « Ajouter un widget » sous la grille s'efface tant que le menu, qui
   fait la même chose, est à l'écran (08/11/2026, Luc). */
let menuOpen = false;
const menuSubs = new Set<() => void>();
export function setWidgetsMenuOpen(v: boolean) {
  if (menuOpen === v) return;
  menuOpen = v;
  menuSubs.forEach((f) => f());
}
const subscribeMenu = (f: () => void) => {
  menuSubs.add(f);
  return () => menuSubs.delete(f);
};
const readMenu = () => menuOpen;
const readMenuServer = () => false;
export function useWidgetsMenuOpen(): boolean {
  return useSyncExternalStore(subscribeMenu, readMenu, readMenuServer);
}
