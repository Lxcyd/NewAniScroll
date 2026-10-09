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
/** Écart du pouce aux bords haut et bas du cadre, en pixels écran. */
const THUMB_INSET = 12;
/** Écart entre le bord droit du cadre et la gouttière du pouce. */
const THUMB_GAP = 8;

/**
 * Où se pose le cadre une fois glissé à droite, et où se posent les outils
 * autour de lui. Tout dérive des mêmes nombres :
 *
 *   — à gauche, le menu des fonds (bord 1,5 %, largeur 24 % bornée 300–440 px),
 *     puis un écart de 1,5 % ;
 *   — à droite, 2 % de marge (la gouttière du pouce y vit) ;
 *   — en haut, la barre de titre (7 %, au moins 52 px) ;
 *   — en bas, la barre des réglages (21,5 %, au moins 150 px).
 *
 * Le cadre prend la plus grande échelle qui tient dans ce qui reste, centré
 * dedans. La transformation garde l'origine au CENTRE de la fenêtre, comme le
 * premier temps (recul centré) : changer d'origine entre les deux ferait
 * sauter le cadre.
 *
 * Sous 1024 px il n'y a pas la place d'une colonne : le cadre reste centré à
 * l'échelle du premier temps.
 */
export function sceneGeometry(W: number, H: number): Record<string, string> {
  const px = (n: number) => `${Math.round(n * 100) / 100}px`;
  const first = W < 768 ? 0.8 : 0.86;
  const top = Math.max(52, H * 0.07);
  if (W < 1024) {
    const w = first * W;
    const h = first * H;
    return {
      "--as-scene-s": String(first),
      "--as-scene-dock-s": String(first),
      "--as-scene-dock-x": "0px",
      "--as-scene-dock-y": "0px",
      "--as-scene-top": px(top),
      "--as-scene-menu-left": px(W * 0.015),
      "--as-scene-menu-w": px(Math.min(440, Math.max(300, W * 0.24))),
      "--as-scene-menu-from": "0px",
      "--as-scene-frame-left": px((W - w) / 2),
      "--as-scene-frame-right": px((W - w) / 2),
      "--as-scene-frame-bottom": px((H + h) / 2),
    };
  }
  const menuLeft = W * 0.015;
  const menuW = Math.min(440, Math.max(300, W * 0.24));
  const gap = W * 0.015;
  const zoneLeft = menuLeft + menuW + gap;
  const zoneRight = W * 0.02;
  const bottom = Math.max(150, H * 0.215);
  const availW = W - zoneLeft - zoneRight;
  const availH = H - top - bottom;
  const s = Math.max(0.3, Math.min(availW / W, availH / H));
  const w = s * W;
  const h = s * H;
  const x0 = zoneLeft + (availW - w) / 2;
  const y0 = top + (availH - h) / 2;
  /* Le bord gauche du cadre, centré au premier temps puis posé : le menu
     parcourt EXACTEMENT cette distance pendant le glissement (globals.css,
     `.as-scene-ui-left`), d'où un écart constant entre les deux. */
  const firstLeft = (W - first * W) / 2;
  return {
    "--as-scene-s": String(first),
    "--as-scene-dock-s": String(Math.round(s * 10000) / 10000),
    "--as-scene-dock-x": px(x0 + w / 2 - W / 2),
    "--as-scene-dock-y": px(y0 + h / 2 - H / 2),
    "--as-scene-top": px(top),
    "--as-scene-menu-left": px(menuLeft),
    "--as-scene-menu-w": px(menuW),
    "--as-scene-menu-from": px(-(x0 - firstLeft)),
    "--as-scene-frame-left": px(x0),
    "--as-scene-frame-right": px(W - x0 - w),
    "--as-scene-frame-bottom": px(y0 + h),
  };
}

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

  /* ── La géométrie ─────────────────────────────────────────────────────
     Calculée EN PIXELS sur la fenêtre réelle, et publiée en variables CSS que
     la scène ET le studio lisent. Elle était écrite à la main en vw (24, 27,
     0,71) : les vw comptent la barre de défilement de la fenêtre, le menu a
     une largeur plancher, et le cadre finissait sous le menu au lieu d'être à
     1,5 vw de lui. Une seule source, plus d'écart possible. */
  useLayoutEffect(() => {
    if (!fixed) return;
    const html = document.documentElement;
    const apply = () => {
      const W = html.clientWidth;
      const H = html.clientHeight;
      const vars = sceneGeometry(W, H);
      for (const [k, v] of Object.entries(vars)) html.style.setProperty(k, v);
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [fixed]);

  /* Le signal du glissement, pour le studio : son menu et sa barre du bas
     TRANSITIONNENT sur cette classe (globals.css) au lieu de partir sur un
     délai à eux. Posée dans la même image que la classe du cadre, avec la même
     durée et la même courbe, elle ne peut plus prendre d'avance — un délai
     CSS fixe démarrait ~40 ms avant le cadre, et sur une courbe aussi raide au
     départ, c'était assez pour passer dessus. */
  useLayoutEffect(() => {
    const html = document.documentElement;
    html.classList.toggle("as-scene-docked", shrunk && docked);
  }, [shrunk, docked]);
  useLayoutEffect(() => () => document.documentElement.classList.remove("as-scene-docked"), []);

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
     À sa place, un pouce DANS LA MARGE, à droite du cadre : jamais posé sur le
     profil, et sur un calque au-dessus du studio, donc rien ne le recouvre.

     Il vit en coordonnées ÉCRAN, recalées sur le rectangle VISIBLE de la
     scène (`getBoundingClientRect`, transformations comprises) : c'est ce qui
     le garde collé au cadre pendant le recul et le glissement, où ce rectangle
     bouge à chaque image. Toute la gouttière se survole et se clique — viser
     un trait de 7 px n'est pas un usage. Positionné hors React : un rendu par
     événement de défilement n'a aucune raison d'être. */
  const gutter = useRef<HTMLDivElement | null>(null);
  const thumb = useRef<HTMLDivElement | null>(null);
  /** Recaler le pouce sans le faire apparaître (suivi des transitions). */
  const placeRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const el = stage.current;
    const gu = gutter.current;
    const th = thumb.current;
    if (!fixed || !el || !gu || !th) return;
    let raf = 0;
    let hide: ReturnType<typeof setTimeout> | undefined;
    let grab: { y: number; top: number; per: number } | null = null;

    /** La course du pouce, en pixels écran. */
    const geometry = () => {
      const r = el.getBoundingClientRect();
      const { scrollTop, scrollHeight, clientHeight } = el;
      const room = Math.max(0, scrollHeight - clientHeight);
      const track = Math.max(0, r.height - 2 * THUMB_INSET);
      const h = room ? Math.max(40, (clientHeight / scrollHeight) * track) : 0;
      const top = room ? (scrollTop / room) * (track - h) : 0;
      return { r, room, track, h, top };
    };
    const place = () => {
      const { r, room, h, top } = geometry();
      /* Pas de marge (début du recul) ou rien à faire défiler : pas de pouce. */
      const visible = room > 0 && window.innerWidth - r.right > THUMB_GAP + 6;
      gu.style.display = visible ? "block" : "none";
      if (!visible) return;
      gu.style.transform = `translate(${r.right + THUMB_GAP}px, ${r.top + THUMB_INSET}px)`;
      gu.style.height = `${r.height - 2 * THUMB_INSET}px`;
      th.style.height = `${h}px`;
      th.style.transform = `translateY(${top}px)`;
    };
    /* Le cadre bouge pendant ses transitions : on suit image par image tant
       qu'elles durent (recul + glissement, ~1,2 s), puis aux seuls événements. */
    let follow = 0;
    const until = performance.now() + 1400;
    const tick = () => {
      place();
      if (performance.now() < until) follow = requestAnimationFrame(tick);
    };
    follow = requestAnimationFrame(tick);

    const flash = () => {
      th.classList.add("is-on");
      clearTimeout(hide);
      /* Tenu, il reste : il ne s'efface qu'une fois lâché. */
      if (!grab) hide = setTimeout(() => th.classList.remove("is-on"), 1000);
    };
    const onScroll = () => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          place();
        });
      flash();
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const g = geometry();
      const per = g.room / Math.max(1, g.track - g.h);
      /* Un clic dans la gouttière, hors du pouce, y amène d'abord son centre :
         on tire ensuite depuis là, comme une barre native. */
      if (e.target !== th) {
        const y = e.clientY - (g.r.top + THUMB_INSET) - g.h / 2;
        el.scrollTop = y * per;
      }
      grab = { y: e.clientY, top: el.scrollTop, per };
      gu.setPointerCapture(e.pointerId);
      th.classList.add("is-on", "is-held");
      clearTimeout(hide);
    };
    const onMove = (e: PointerEvent) => {
      if (!grab) return;
      el.scrollTop = grab.top + (e.clientY - grab.y) * grab.per;
    };
    const onUp = (e: PointerEvent) => {
      if (!grab) return;
      grab = null;
      if (gu.hasPointerCapture(e.pointerId)) gu.releasePointerCapture(e.pointerId);
      th.classList.remove("is-held");
      flash();
    };
    const onEnter = () => {
      th.classList.add("is-on");
      clearTimeout(hide);
    };
    const onLeave = () => {
      if (!grab) flash();
    };

    placeRef.current = place;
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", place);
    el.addEventListener("transitionend", place);
    gu.addEventListener("pointerdown", onDown);
    gu.addEventListener("pointermove", onMove);
    gu.addEventListener("pointerup", onUp);
    gu.addEventListener("pointercancel", onUp);
    gu.addEventListener("pointerenter", onEnter);
    gu.addEventListener("pointerleave", onLeave);
    return () => {
      placeRef.current = null;
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", place);
      el.removeEventListener("transitionend", place);
      gu.removeEventListener("pointerdown", onDown);
      gu.removeEventListener("pointermove", onMove);
      gu.removeEventListener("pointerup", onUp);
      gu.removeEventListener("pointercancel", onUp);
      gu.removeEventListener("pointerenter", onEnter);
      gu.removeEventListener("pointerleave", onLeave);
      cancelAnimationFrame(raf);
      cancelAnimationFrame(follow);
      clearTimeout(hide);
      gu.style.display = "none";
      th.classList.remove("is-on", "is-held");
    };
  }, [fixed]);

  /* Le cadre se déplace aussi au second temps (glissement) et au retour : on
     relance le suivi image par image à chaque changement d'état. */
  useLayoutEffect(() => {
    const el = stage.current;
    if (!fixed || !el) return;
    let raf = 0;
    const until = performance.now() + 900;
    const tick = () => {
      placeRef.current?.();
      if (performance.now() < until) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [fixed, shrunk, docked]);

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
      {fixed ? (
        <div ref={gutter} aria-hidden className="as-scene-gutter">
          <div ref={thumb} className="as-scene-thumb" />
        </div>
      ) : null}
    </SceneContext.Provider>
  );
}
