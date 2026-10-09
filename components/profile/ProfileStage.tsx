import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowPathIcon, MinusIcon, PlusIcon } from "@heroicons/react/24/outline";

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

/** Le recul, en ms — `.as-stage.is-fixed` dans globals.css. */
const DURATION = 500;
/** Écart du pouce aux bords haut et bas du cadre, en pixels écran. */
const THUMB_INSET = 12;
/** Écart entre le bord droit du cadre et la gouttière du pouce (dedans). */
const THUMB_GAP = 4;
/** Largeur de la gouttière (la zone saisissable), cf. `.as-scene-gutter`. */
const GUTTER_W = 12;
/** Hauteur de la barre des réglages (BannerStudio, `min-h-[4.75rem]` + bords). */
const BOTTOM_BAR = 78;
/** Le menu de gauche ne descend pas sous cette largeur à la poignée. */
const MENU_MIN = 280;
/** Le zoom choisi, retenu sur l'appareil (absent = « Ajuster »). */
const ZOOM_KEY = "as-scene-zoom";
function readZoom(): number | null {
  try {
    const n = Number(localStorage.getItem(ZOOM_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
/** La largeur choisie à la poignée, retenue sur l'appareil. */
const MENU_KEY = "as-scene-menu-w";
function readMenuWidth(): number | null {
  try {
    const n = Number(localStorage.getItem(MENU_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Zoom du profil dans le cadre : bornes et pas des boutons − / +. */
export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 1.25;
export const ZOOM_STEP = 0.1;

/**
 * Où se pose le cadre une fois glissé à droite, et où se posent les outils
 * autour de lui. Tout dérive des mêmes nombres :
 *
 *   — à gauche, le menu (bord 1,5 %, largeur réglable à la poignée), puis un
 *     écart de 1,5 % ;
 *   — à droite, 2 % de marge ;
 *   — en haut, la barre de titre (7 %, au moins 52 px) ;
 *   — en bas, la barre des réglages et ses deux écarts (114 px).
 *
 * LE CADRE REMPLIT CETTE ZONE, quelle que soit sa forme (choix O1 du 10/10).
 * Il gardait la forme de l'écran et rétrécissait jusqu'à tenir en largeur :
 * une bande vide au-dessus, un haut désaligné du menu. La scène prend donc au
 * second temps la forme de la ZONE — `zone / zoom` en pixels de mise en page —
 * puis est réduite au zoom, l'origine en haut à gauche.
 *
 * LE ZOOM en découle : c'est l'échelle du profil dans le cadre, comme le zoom
 * du navigateur. `null` = « Ajuster » : zoneW / W, où le profil garde la
 * largeur de mise en page de la fenêtre — et où le glissement ne change donc
 * pas la largeur de la scène, seulement sa hauteur.
 *
 * Premier temps (recul centré) : même origine en haut à gauche, la translation
 * fait le centrage — une seule origine pour les deux temps, sans quoi le cadre
 * sauterait au passage de l'un à l'autre.
 *
 * Sous 1024 px il n'y a pas la place d'une colonne : le cadre reste centré à
 * l'échelle du premier temps.
 */
export function sceneGeometry(
  W: number,
  H: number,
  menuWidth?: number | null,
  zoom?: number | null,
): { vars: Record<string, string>; fit: number; zoom: number } {
  const px = (n: number) => `${Math.round(n * 100) / 100}px`;
  const num = (n: number) => String(Math.round(n * 10000) / 10000);
  const first = W < 768 ? 0.8 : 0.86;
  const top = Math.max(52, H * 0.07);
  const firstLeft = ((1 - first) * W) / 2;
  const firstTop = ((1 - first) * H) / 2;
  const common = {
    "--as-scene-W": px(W),
    "--as-scene-H": px(H),
    "--as-scene-s": num(first),
    "--as-scene-s1-x": px(firstLeft),
    "--as-scene-s1-y": px(firstTop),
    "--as-scene-top": px(top),
  };
  if (W < 1024) {
    return {
      fit: first,
      zoom: first,
      vars: {
        ...common,
        "--as-scene-zoom": num(first),
        "--as-scene-dock-x": px(firstLeft),
        "--as-scene-dock-y": px(firstTop),
        "--as-scene-dock-w": px(W),
        "--as-scene-dock-h": px(H),
        "--as-scene-menu-left": px(W * 0.015),
        "--as-scene-menu-w": px(Math.min(440, Math.max(300, W * 0.24))),
        "--as-scene-gap": px(W * 0.015),
        "--as-scene-menu-from": "0px",
        "--as-scene-frame-left": px(firstLeft),
        "--as-scene-frame-right": px(firstLeft),
        "--as-scene-frame-bottom": px(firstTop + first * H),
      },
    };
  }
  const menuLeft = W * 0.015;
  const gap = W * 0.015;
  /* La largeur du menu se règle à la poignée entre lui et le cadre
     (`menuWidth`). Bornée des deux côtés : le menu garde de quoi lire une
     ligne, le cadre au moins 35 % de la fenêtre. */
  const menuMax = Math.max(MENU_MIN, W - menuLeft - gap - W * 0.02 - W * 0.35);
  const menuW = Math.min(menuMax, Math.max(MENU_MIN, menuWidth ?? Math.min(440, W * 0.24)));
  const zoneLeft = menuLeft + menuW + gap;
  const zoneRight = W * 0.02;
  /* La barre du bas (~78 px) + 14 px d'écart au cadre + 22 px au bord. */
  const bottom = BOTTOM_BAR + 14 + 22;
  const zoneW = W - zoneLeft - zoneRight;
  const zoneH = H - top - bottom;
  const fit = zoneW / W;
  const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom ?? fit));
  return {
    fit,
    zoom: z,
    vars: {
      ...common,
      "--as-scene-zoom": num(z),
      "--as-scene-dock-x": px(zoneLeft),
      "--as-scene-dock-y": px(top),
      "--as-scene-dock-w": px(zoneW / z),
      "--as-scene-dock-h": px(zoneH / z),
      "--as-scene-menu-left": px(menuLeft),
      "--as-scene-menu-w": px(menuW),
      "--as-scene-gap": px(gap),
      /* Le bord gauche du cadre, centré au premier temps puis posé : le menu
         parcourt EXACTEMENT cette distance pendant le glissement (globals.css,
         `.as-scene-ui-left`), d'où un écart constant entre les deux. */
      "--as-scene-menu-from": px(-(zoneLeft - firstLeft)),
      "--as-scene-frame-left": px(zoneLeft),
      "--as-scene-frame-right": px(zoneRight),
      "--as-scene-frame-bottom": px(top + zoneH),
    },
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
  const split = useRef<HTMLDivElement | null>(null);
  /** Ce que les commandes de zoom affichent, et ce qu'elles déclenchent. */
  const [zoomView, setZoomView] = useState<{ pct: number; fit: boolean }>({ pct: 100, fit: true });
  const zoomApi = useRef<{ step: (dir: 1 | -1) => void; fit: () => void } | null>(null);
  useLayoutEffect(() => {
    if (!fixed) return;
    const html = document.documentElement;
    let menuW = readMenuWidth();
    /** Le zoom choisi, ou null pour « Ajuster » (cf. sceneGeometry). */
    let zoom = readZoom();
    const apply = () => {
      const W = html.clientWidth;
      const H = html.clientHeight;
      const g = sceneGeometry(W, H, menuW, zoom);
      for (const [k, v] of Object.entries(g.vars)) html.style.setProperty(k, v);
      setZoomView({ pct: Math.round(g.zoom * 100), fit: zoom == null });
      return g;
    };
    apply();
    window.addEventListener("resize", apply);

    /* ── Le zoom ──────────────────────────────────────────────────────────
       Changer le zoom change la largeur de mise en page de la scène : le
       profil se remet en page, comme au zoom du navigateur. Sans transition
       (le contenu se remet en page d'un coup, une échelle qui glisserait par
       là-dessus se lirait comme un raté), et en gardant l'endroit qu'on
       lisait : la part défilée est conservée. */
    const el = stage.current;
    const setZoom = (next: number | null) => {
      const before = el && el.scrollHeight > el.clientHeight
        ? el.scrollTop / (el.scrollHeight - el.clientHeight)
        : 0;
      zoom = next == null ? null : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 100) / 100));
      html.classList.add("as-scene-resizing");
      apply();
      if (el) el.scrollTop = before * Math.max(0, el.scrollHeight - el.clientHeight);
      requestAnimationFrame(() => {
        html.classList.remove("as-scene-resizing");
        el?.dispatchEvent(new Event("transitionend")); // recale le pouce
      });
      try {
        if (zoom == null) localStorage.removeItem(ZOOM_KEY);
        else localStorage.setItem(ZOOM_KEY, String(zoom));
      } catch {
        /* stockage refusé : le zoom vaut pour cette édition */
      }
    };
    const current = () => apply().zoom;
    zoomApi.current = {
      step: (dir) => setZoom(current() + dir * ZOOM_STEP),
      fit: () => setZoom(null),
    };
    /* Ctrl + molette sur le cadre : le zoom du PROFIL, pas celui du navigateur
       (qui grossirait aussi le menu et les barres). Écouteur non passif, pour
       pouvoir empêcher le zoom du navigateur. */
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(current() + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
    };
    /* Ctrl + 0 / Ctrl + − / Ctrl + = : mêmes gestes qu'au navigateur. */
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !html.classList.contains("as-scene-docked")) return;
      if (e.key === "0") setZoom(null);
      else if (e.key === "-" || e.key === "_") setZoom(current() - ZOOM_STEP);
      else if (e.key === "=" || e.key === "+") setZoom(current() + ZOOM_STEP);
      else return;
      e.preventDefault();
    };
    el?.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);

    /* ── La poignée entre le menu et le cadre ───────────────────────────
       Tirer élargit l'un et rétrécit l'autre. Le cadre suit EN DIRECT, sans
       transition (`as-scene-resizing`) : une transition de 0,45 s derrière
       le pointeur se lirait comme de la mollesse. Seule la transformation du
       cadre change — pas de mise en page du profil, le geste reste léger. */
    const handle = split.current;
    let drag: { x: number; w: number } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || !handle) return;
      e.preventDefault();
      const cur = parseFloat(getComputedStyle(html).getPropertyValue("--as-scene-menu-w")) || 0;
      drag = { x: e.clientX, w: cur };
      handle.setPointerCapture(e.pointerId);
      html.classList.add("as-scene-resizing");
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      menuW = drag.w + (e.clientX - drag.x);
      apply();
    };
    const onUp = (e: PointerEvent) => {
      if (!drag || !handle) return;
      drag = null;
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      html.classList.remove("as-scene-resizing");
      /* Retenue telle que bornée : la variable porte la largeur réellement
         appliquée, pas celle que le pointeur demandait au-delà des bornes. */
      const applied = parseFloat(getComputedStyle(html).getPropertyValue("--as-scene-menu-w"));
      if (applied > 0) {
        menuW = applied;
        try {
          localStorage.setItem(MENU_KEY, String(Math.round(applied)));
        } catch {
          /* stockage refusé : la largeur vaut pour cette édition */
        }
      }
      /* Le pouce se recale sur le cadre déplacé. */
      stage.current?.dispatchEvent(new Event("transitionend"));
    };
    /* Double-clic : retour à la largeur par défaut. */
    const onReset = () => {
      menuW = null;
      try {
        localStorage.removeItem(MENU_KEY);
      } catch {
        /* rien à oublier */
      }
      html.classList.add("as-scene-resizing");
      apply();
      requestAnimationFrame(() => html.classList.remove("as-scene-resizing"));
    };
    handle?.addEventListener("pointerdown", onDown);
    handle?.addEventListener("pointermove", onMove);
    handle?.addEventListener("pointerup", onUp);
    handle?.addEventListener("pointercancel", onUp);
    handle?.addEventListener("dblclick", onReset);
    return () => {
      window.removeEventListener("resize", apply);
      el?.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
      zoomApi.current = null;
      handle?.removeEventListener("pointerdown", onDown);
      handle?.removeEventListener("pointermove", onMove);
      handle?.removeEventListener("pointerup", onUp);
      handle?.removeEventListener("pointercancel", onUp);
      handle?.removeEventListener("dblclick", onReset);
      html.classList.remove("as-scene-resizing");
    };
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
      /* Rien à faire défiler, ou cadre encore plein écran : pas de pouce. Il
         est DANS le cadre, contre son bord droit (demande du 10/10 : la
         marge le faisait lire comme un objet à part). */
      const visible = room > 0 && r.width < window.innerWidth - 1;
      gu.style.display = visible ? "block" : "none";
      if (!visible) return;
      gu.style.transform = `translate(${r.right - THUMB_GAP - GUTTER_W}px, ${r.top + THUMB_INSET}px)`;
      gu.style.height = `${r.height - 2 * THUMB_INSET}px`;
      th.style.height = `${h}px`;
      th.style.transform = `translateY(${top}px)`;
    };
    /* Pas de suivi image par image pendant les transitions : le pouce est
       invisible à ce moment-là, et une mesure par image coûtait au moment le
       plus chargé. Il se recale à la fin de chaque transition du cadre
       (`transitionend`, plus bas). */

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
      clearTimeout(hide);
      gu.style.display = "none";
      th.classList.remove("is-on", "is-held");
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
      {fixed ? (
        <>
          <div ref={gutter} aria-hidden className="as-scene-gutter">
            <div ref={thumb} className="as-scene-thumb" />
          </div>
          {/* Le zoom, dans le coin bas droit du cadre (choix O5) : on règle la
              taille du profil là où on la regarde. */}
          <div className="as-scene-zoom" role="group" aria-label="Zoom du profil">
            <button
              type="button"
              onClick={() => zoomApi.current?.step(-1)}
              disabled={zoomView.pct <= Math.round(ZOOM_MIN * 100)}
              aria-label="Dézoomer"
              title="Dézoomer (Ctrl + molette)"
            >
              <MinusIcon className="h-4 w-4" strokeWidth={2} />
            </button>
            <span className="as-scene-zoom-pct" aria-live="polite">
              {zoomView.pct} %
            </span>
            <button
              type="button"
              onClick={() => zoomApi.current?.step(1)}
              disabled={zoomView.pct >= Math.round(ZOOM_MAX * 100)}
              aria-label="Zoomer"
              title="Zoomer (Ctrl + molette)"
            >
              <PlusIcon className="h-4 w-4" strokeWidth={2} />
            </button>
            <span aria-hidden className="as-scene-zoom-sep" />
            <button
              type="button"
              onClick={() => zoomApi.current?.fit()}
              disabled={zoomView.fit}
              aria-label="Réinitialiser le zoom"
              title="Réinitialiser : le profil reprend sa largeur habituelle (Ctrl + 0)"
            >
              <ArrowPathIcon className="h-4 w-4" strokeWidth={2} />
            </button>
          </div>
          <div
            ref={split}
            role="separator"
            aria-orientation="vertical"
            title="Glisser pour répartir la place · double-clic pour revenir"
            className="as-scene-split"
          />
        </>
      ) : null}
    </SceneContext.Provider>
  );
}
