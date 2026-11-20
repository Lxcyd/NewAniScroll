import { createContext, memo, useCallback, useContext, useDeferredValue, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

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
  /* Combien de fois chaque onglet a été QUITTÉ : ses widgets s'y remettent à
     l'état d'avant leur entrée, pour la rejouer au retour (cf. EntranceEpoch).
     Après la peinture du nouvel onglet (effet), pas pendant le clic. */
  const [left, setLeft] = useState<Record<string, number>>({});
  const prevShown = useRef(shown);
  useEffect(() => {
    const prev = prevShown.current;
    prevShown.current = shown;
    if (prev !== shown) setLeft((m) => ({ ...m, [prev]: (m[prev] ?? 0) + 1 }));
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
      live: k === tab && k === shown,
      epoch: left[k] ?? 0,
    }),
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

/**
 * LES ANIMATIONS D'ENTRÉE DES WIDGETS SE REJOUENT AU RETOUR SUR L'ONGLET
 * (21/11/2026, Luc : « les animations des widgets ne se font pas »). L'onglet
 * gardé monté ne recrée plus ses widgets ; ce compteur change quand on le
 * quitte, et chaque animation d'entrée (`useEntranceReplay`) revient alors,
 * cachée, à son état de départ — l'observateur de visibilité la relance au
 * retour, comme au premier affichage.
 */
export const EntranceEpoch = createContext(0);

/** Appelle `reset` chaque fois que l'onglet du widget est quitté. */
export function useEntranceReplay(reset: () => void) {
  const epoch = useContext(EntranceEpoch);
  const seen = useRef(epoch);
  const cb = useRef(reset);
  cb.current = reset;
  useEffect(() => {
    if (epoch === seen.current) return;
    seen.current = epoch;
    cb.current();
  }, [epoch]);
}

/** Un panneau d'onglet gardé monté : caché par classe, contenu gelé hors
 *  service, compteur d'entrée transmis aux widgets. */
export function KeepAlivePanel({
  className,
  live,
  epoch,
  children,
  ...rest
}: {
  className: string;
  live: boolean;
  epoch: number;
  children: ReactNode;
  "aria-hidden"?: boolean;
}) {
  /* AU RÉAFFICHAGE, PAS DE TRANSITION PENDANT DEUX IMAGES. Les widgets se sont
     remis à leur état de départ pendant que l'onglet était caché, mais le
     navigateur ne recalcule pas les styles d'un contenu caché : au retour, une
     ligne passait de son état final à « invisible » par sa transition CSS
     (≈ 150 ms de fondu à l'envers), avant de rejouer son entrée. */
  const ref = useRef<HTMLDivElement>(null);
  const visible = !className.includes("as-tab-off");
  const wasVisible = useRef(visible);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    const back = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (!el || !back) return;
    el.classList.add("as-tab-reveal");
    let r2 = 0;
    const r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => el.classList.remove("as-tab-reveal"));
    });
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
      el.classList.remove("as-tab-reveal");
    };
  }, [visible]);
  return (
    <div ref={ref} className={className} aria-hidden={rest["aria-hidden"]}>
      <EntranceEpoch.Provider value={epoch}>
        <Freeze active={live}>{children}</Freeze>
      </EntranceEpoch.Provider>
    </div>
  );
}
