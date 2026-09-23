/**
 * L'interrupteur de la fête d'un badge.
 *
 * ── POURQUOI CE RÉGLAGE EXISTE ───────────────────────────────────────────────
 * La notification de badge a cessé de suivre `prefers-reduced-motion` (cf. le
 * bloc dédié de styles/globals.css) : Windows livre « Effets d'animation »
 * désactivé sur beaucoup de postes, ce qui met Chrome en `reduce` sans que
 * personne n'ait demandé moins d'animations à un site — et le `display: none`
 * tombait sur exactement ce qui FAIT la récompense. On avait alors écrit, en
 * toutes lettres, que le vrai correctif était un réglage DU SITE, distinct de
 * celui du système. Le voici.
 *
 * Il ne réinvente rien : même patron que lib/prefs/spoilerPrefs.ts — une clé
 * localStorage, un `CustomEvent` pour le même onglet, `storage` pour les
 * autres, un hook qui rend la valeur vivante.
 *
 * ── IL Y EN AVAIT DEUX ───────────────────────────────────────────────────────
 * Le second coupait le carillon du badge. Le carillon lui-même a été abandonné
 * le 23/09/2026 après cinq versions et deux bancs d'essai (voir l'en-tête de
 * components/shared/AchievementToast.tsx) ; l'interrupteur est parti avec, et
 * la clé `aniscroll:badges:sound` n'est plus lue nulle part. On ne la nettoie
 * pas chez ceux qui l'ont écrite : `localStorage` n'est pas une base de
 * données, une clé orpheline n'y coûte rien, et le code qui irait la supprimer
 * coûterait plus que ce qu'il économise.
 *
 * ── LE DÉFAUT EST « ALLUMÉ », ET C'EST UN CHOIX ──────────────────────────────
 * Quelqu'un qui n'a rien demandé reçoit la fête complète. Le réglage système
 * n'est PAS lu comme défaut : c'est précisément parce qu'il mentait sur ce
 * poste-là qu'on a arrêté de le suivre, et le reprendre par la bande ici
 * reviendrait au même bug.
 */

import { useEffect, useState } from "react";

const FX = "aniscroll:badges:fx";

export const BADGE_PREFS_EVENT = "aniscroll:badges:prefs";

/** Absent = allumé. Seul un « 0 » explicite éteint. */
function lire(cle: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(cle) !== "0";
  } catch {
    return true;
  }
}

function ecrire(cle: string, on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(cle, on ? "1" : "0");
  } catch {
    /* au mieux */
  }
  window.dispatchEvent(new CustomEvent(BADGE_PREFS_EVENT));
}

/** Lecture synchrone, pour le code hors React. */
export function getBadgeFx(): boolean {
  return lire(FX);
}
export function setBadgeFx(on: boolean): void {
  ecrire(FX, on);
}

/**
 * La valeur, vivante.
 *
 * `true` au premier rendu, TOUJOURS : `localStorage` n'existe pas au rendu
 * serveur, et rendre autre chose ici casserait l'hydratation. L'effet corrige
 * juste après, avant que quoi que ce soit ne s'anime.
 */
export function useBadgePrefs(): { fx: boolean } {
  const [v, setV] = useState({ fx: true });
  useEffect(() => {
    const read = () => setV({ fx: lire(FX) });
    read();
    window.addEventListener(BADGE_PREFS_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(BADGE_PREFS_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return v;
}
