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
