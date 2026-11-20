import { memo, useCallback, useDeferredValue, useEffect, useState, type ReactNode } from "react";

/**
 * LES ONGLETS DU PROFIL RESTENT MONTÉS UNE FOIS VISITÉS (21/11/2026, Luc :
 * « optimise énormément […] pour que quand on switch de menu ce soit fluide »).
 *
 * Avant, chaque onglet était démonté en le quittant et refaisait TOUT au
 * retour : trier les ~700 titres, recalculer les 176 badges, remonter la grille
 * des widgets (jusqu'à 0,9 s gelé sur mobile). Désormais :
 * - la pastille de l'onglet bouge tout de suite (`tab`, urgent) ;
 * - le contenu suit en différé (`useDeferredValue`) : interruptible, le clic ne
 *   gèle plus. Pendant ce temps, l'onglet jamais ouvert montre son SQUELETTE ;
 * - un onglet déjà visité n'est plus que caché (`content-visibility: hidden`,
 *   classe `.as-tab-off`) : il revient sans rien recalculer, filtres et
 *   défilement interne compris.
 */
export function useKeepAliveTabs(tab: string, first = "overview") {
  const shown = useDeferredValue(tab);
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set([first]));
  useEffect(() => {
    setVisited((v) => (v.has(shown) ? v : new Set(v).add(shown)));
  }, [shown]);
  /* Le fondu d'entrée seulement après un vrai changement d'onglet, pas au
     chargement de la page. */
  const [switched, setSwitched] = useState(false);
  const mounted = useCallback((k: string) => visited.has(k) || shown === k, [visited, shown]);
  return {
    /** Le panneau `k` est-il rendu (visible ou caché) ? */
    mounted,
    /** Les attributs du panneau `k` : caché par `content-visibility: hidden`
     *  (`.as-tab-off`) et NON par `hidden` — `display: none` jetait sa mise en
     *  page, et la refaire au retour coûtait 0,5 s sur mobile ; ici le
     *  navigateur la garde, et l'onglet revient sans recalcul. */
    panel: (k: string) => ({
      className: `${switched ? "as-tab-in" : ""}${k !== tab ? " as-tab-off" : ""}`,
      "aria-hidden": k !== tab ? true : undefined,
    }),
    /** Le panneau `k` doit-il suivre ses props (cf. `Freeze`) ? Seulement
     *  quand il est choisi ET rendu en différé : au clic (rendu urgent), aucun
     *  onglet ne se recalcule, la classe seule le montre ou le cache. */
    live: (k: string) => k === tab && k === shown,
    /** Montrer le squelette de `k` : choisi mais pas encore rendu. */
    skeleton: (k: string) => k === tab && !mounted(k),
    /** À appeler quand l'utilisateur change d'onglet. */
    markSwitch: useCallback(() => setSwitched(true), []),
  };
}

/**
 * LE CONTENU D'UN ONGLET GELÉ TANT QU'IL N'EST PAS `active` (21/11/2026).
 * Les onglets gardés montés sont des enfants de la page : sans ce gel, chaque
 * changement d'onglet les recalculait TOUS (≈ 0,3 s fixe sur mobile). Gelé,
 * un onglet garde son dernier rendu ; redevenu actif, il se remet à jour en
 * différé, sans bloquer l'affichage.
 */
export const Freeze = memo(
  function Freeze({ children }: { active: boolean; children: ReactNode }) {
    return <>{children}</>;
  },
  (_prev, next) => !next.active,
);
