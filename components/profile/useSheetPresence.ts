import { useEffect, useState } from "react";

/* LA FEUILLE RESTE MONTÉE LE TEMPS DE SA SORTIE (20/11/2026, Luc) : quand
   `open` repasse à false, `shown` reste vrai `ms` millisecondes avec
   `closing` à vrai, pour l'animation de fermeture (.as-sfp-overlay.is-closing). */
export function useSheetPresence(open: boolean, ms = 220) {
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setShown(true);
      return;
    }
    const id = setTimeout(() => setShown(false), ms);
    return () => clearTimeout(id);
  }, [open, ms]);
  return { shown: open || shown, closing: !open && shown };
}

/* PAGE FIGÉE DERRIÈRE LES FEUILLES : c'est <html> qui défile, et la largeur de
   la barre disparue est rendue en marge. UN COMPTEUR PARTAGÉ (21/11/2026, Luc) :
   le tirage ouvre sa fiche pendant que le panneau se ferme. Chacun restaurant
   ce qu'il avait trouvé, le panneau débloquait la page derrière la fiche, puis
   la fiche la rebloquait pour de bon en partant. */
let locks = 0;
let saved: [string, string] = ["", ""];
export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const html = document.documentElement;
    if (locks++ === 0) {
      const bar = window.innerWidth - html.clientWidth;
      saved = [html.style.overflow, html.style.paddingRight];
      html.style.overflow = "hidden";
      if (bar > 0) html.style.paddingRight = `${bar}px`;
    }
    return () => {
      if (--locks === 0) [html.style.overflow, html.style.paddingRight] = saved;
    };
  }, [active]);
}
