import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * LA SCÈNE : le profil qui recule quand on le personnalise.
 *
 * En édition, la page sort du flux et devient un cadre arrondi au centre de
 * l'écran, réduit à `--as-scene-s` (globals.css). La marge qu'il libère porte
 * les outils du studio (BannerStudio). On sait d'un coup d'œil qu'on édite, et
 * plus rien ne flotte PAR-DESSUS le profil.
 *
 * TROIS CALQUES, et l'ordre est imposé par le papier peint :
 *
 *   1. le fond de salle (`.as-scene-back`), sombre, qui couvre aussi la navbar ;
 *   2. l'écran (`.as-scene-screen`) : la couleur de page et le papier peint ;
 *   3. la scène (`.as-stage`) : le profil, transparent, qui défile seul.
 *
 * Le papier peint ne peut pas rester DANS la scène. Il est en `position:
 * fixed`, et une transformation fait de son ancêtre le bloc conteneur des
 * éléments fixes : il deviendrait un élément absolu de la zone qui défile, et
 * partirait avec le contenu. ProfileHero le confie donc à l'écran par un
 * portail (`useScene().screen`) — l'écran reçoit la MÊME transformation que la
 * scène, si bien que les deux se superposent au pixel.
 *
 * Tout est en `transform` : la mise en page reste celle de la pleine largeur,
 * rien ne se recalcule pendant l'animation. Et jamais d'opacité sur la scène :
 * une animation d'opacité en fait une « racine de fond » et éteint le flou des
 * widgets (cf. la note de pages/en/profile/[user].tsx).
 */

type Scene = { screen: HTMLDivElement | null; fixed: boolean };
const SceneContext = createContext<Scene>({ screen: null, fixed: false });

/** Où le papier peint doit être rendu pendant que la scène est active. */
export function useScene(): Scene {
  return useContext(SceneContext);
}

const DURATION = 600;

export default function ProfileStage({ scene, children }: { scene: boolean; children: ReactNode }) {
  const stage = useRef<HTMLDivElement | null>(null);
  const [screen, setScreen] = useState<HTMLDivElement | null>(null);
  /** La page est sortie du flux (fixe, défilement propre). */
  const [fixed, setFixed] = useState(false);
  /** La réduction est appliquée — c'est elle que la transition anime. */
  const [shrunk, setShrunk] = useState(false);
  /** Le défilement à reprendre d'un mode à l'autre, pour que rien ne saute. */
  const scroll = useRef(0);
  const want = useRef(scene);
  want.current = scene;

  /* Entrée : on sort du flux à taille réelle, PUIS on réduit — deux images
     plus tard, sinon le navigateur n'a jamais vu l'état de départ et saute
     directement à l'arrivée. Sortie : on agrandit, et c'est à la fin de la
     transition seulement qu'on rend la page au flux. */
  useLayoutEffect(() => {
    if (scene) {
      if (!fixed) {
        scroll.current = window.scrollY;
        setFixed(true);
      } else {
        setShrunk(true);
      }
      return;
    }
    if (!fixed) return;
    setShrunk(false);
    const el = stage.current;
    let done = false;
    const release = () => {
      if (done || want.current) return;
      done = true;
      scroll.current = el?.scrollTop ?? 0;
      setFixed(false);
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target === el && e.propertyName === "transform") release();
    };
    el?.addEventListener("transitionend", onEnd);
    /* Filet : sans mouvement (prefers-reduced-motion), aucune transition ne
       finit jamais. */
    const timer = setTimeout(release, DURATION + 100);
    return () => {
      el?.removeEventListener("transitionend", onEnd);
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene]);

  const mounted = useRef(false);
  useLayoutEffect(() => {
    const body = document.body.style;
    if (!mounted.current) {
      /* Au premier rendu il n'y a rien à reprendre : remonter en haut ici
         écraserait la restauration de défilement du navigateur. */
      mounted.current = true;
      return;
    }
    if (fixed) {
      if (stage.current) stage.current.scrollTop = scroll.current;
      const previous = body.overflow;
      body.overflow = "hidden";
      let raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(() => {
          if (want.current) setShrunk(true);
        });
      });
      return () => {
        cancelAnimationFrame(raf);
        body.overflow = previous;
      };
    }
    window.scrollTo(0, scroll.current);
  }, [fixed]);

  const state = `${fixed ? " is-fixed" : ""}${shrunk ? " is-shrunk" : ""}`;

  return (
    <SceneContext.Provider value={{ screen, fixed }}>
      <div aria-hidden className={`as-scene-back${state}`} />
      <div aria-hidden ref={setScreen} className={`as-scene-screen${state}`} />
      <div ref={stage} className={`as-stage${state}`}>
        {children}
      </div>
    </SceneContext.Provider>
  );
}
