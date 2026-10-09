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
/** Écart du pouce aux bords haut et bas du cadre, en pixels de mise en page. */
const THUMB_INSET = 14;

export default function ProfileStage({ scene, children }: { scene: boolean; children: ReactNode }) {
  const stage = useRef<HTMLDivElement | null>(null);
  const [screen, setScreen] = useState<HTMLDivElement | null>(null);
  /** La page est sortie du flux (fixe, défilement propre). */
  const [fixed, setFixed] = useState(false);
  /** La réduction est appliquée — c'est elle que la transition anime. */
  const [shrunk, setShrunk] = useState(false);
  /** Second temps : le cadre glisse à droite pour laisser la place au menu
      du fond (BannerStudio). Il attend la fin du recul — les deux mouvements
      à la fois se liraient comme une seule dérive en diagonale. */
  const [docked, setDocked] = useState(false);
  useLayoutEffect(() => {
    if (!shrunk) {
      setDocked(false);
      return;
    }
    const timer = setTimeout(() => {
      if (want.current) setDocked(true);
    }, DURATION - 40);
    return () => clearTimeout(timer);
  }, [shrunk]);
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
    setDocked(false);
    const el = stage.current;
    let done = false;
    const release = () => {
      if (done || want.current) return;
      done = true;
      scroll.current = el?.scrollTop ?? 0;
      setFixed(false);
      /* Ce qui vit HORS de la scène — la navbar d'abord — était caché par
         l'écran opaque pendant tout le retour, et surgissait d'un coup à la
         fin. Il entre en fondu, le temps d'une classe (globals.css). */
      const html = document.documentElement;
      html.classList.add("as-scene-leave");
      setTimeout(() => html.classList.remove("as-scene-leave"), 700);
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

  /* ── Le pouce ─────────────────────────────────────────────────────────
     La barre de défilement native est masquée (elle tombait dans le cadre).
     À sa place, une pilule translucide qui n'existe que pendant qu'on défile
     et s'efface une seconde après, comme sur macOS. Elle vit sur son propre
     calque, transformé comme la scène : posée DANS la scène, elle défilerait
     avec le contenu. Positionnée hors React — un rendu par événement de
     défilement n'a aucune raison d'être. */
  const thumb = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = stage.current;
    const th = thumb.current;
    if (!fixed || !el || !th) return;
    let raf = 0;
    let hide: ReturnType<typeof setTimeout> | undefined;
    const place = () => {
      raf = 0;
      const { scrollTop, scrollHeight, clientHeight } = el;
      const room = scrollHeight - clientHeight;
      if (room <= 0) return;
      const track = clientHeight - 2 * THUMB_INSET;
      const h = Math.max(48, (clientHeight / scrollHeight) * track);
      th.style.height = `${h}px`;
      th.style.transform = `translateY(${THUMB_INSET + (scrollTop / room) * (track - h)}px)`;
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(place);
      th.classList.add("is-on");
      clearTimeout(hide);
      hide = setTimeout(() => th.classList.remove("is-on"), 1000);
    };
    place();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
      clearTimeout(hide);
      th.classList.remove("is-on");
    };
  }, [fixed]);

  const state = `${fixed ? " is-fixed" : ""}${shrunk ? " is-shrunk" : ""}${
    shrunk && docked ? " is-docked" : ""
  }`;

  return (
    <SceneContext.Provider value={{ screen, fixed }}>
      <div aria-hidden className={`as-scene-back${state}`} />
      <div aria-hidden ref={setScreen} className={`as-scene-screen${state}`} />
      <div ref={stage} className={`as-stage${state}`}>
        {children}
      </div>
      <div aria-hidden className={`as-scene-track${state}`}>
        <div ref={thumb} className="as-scene-thumb" />
      </div>
    </SceneContext.Provider>
  );
}
