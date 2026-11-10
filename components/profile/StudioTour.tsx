/**
 * LE TOUR DU STUDIO (09/11/2026, Luc) : une bulle par menu, « Suivant » ouvre
 * le menu dont elle parle, « Skip » arrête tout. Compté comme vu seulement
 * après Skip (croix, Échap) ou la dernière étape (`aniscroll:studioTour:N`).
 *
 * Pas de voile sur l'écran (Luc : « pas trop intrusif ») : la bulle se pose
 * au-dessus de la case de la barre du bas qu'elle présente, un CADRE posé
 * par-dessus la case l'entoure, et le menu s'ouvre à gauche comme au clic.
 * Le cadre est un élément à part (portail, position fixe), pas un style
 * injecté dans la case : la barre coupe ce qui déborde, et un liseré intérieur
 * y disparaissait sous le contenu (10/11, « la box rose est buggée »).
 *
 * TOUT ce qui bouge passe par `transform` / `opacity` (le compositeur) : le
 * menu qui s'ouvre occupe le fil principal plusieurs centaines de ms, et une
 * transition sur `left`/`width`, un `box-shadow` ou un `filter` animés
 * saccadaient pendant ce temps (10/11, « très laggy »).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ArrowsPointingOutIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { ecrireOnglet, lireOnglet } from "@/lib/profile/tabHash";

/* Changer le suffixe rejoue le tour pour tout le monde (nouvelle version). */
const DONE_KEY = "aniscroll:studioTour:7";

export type TourScope = "color" | "image" | "video" | "upload" | "layout" | "widgets" | "avatar" | "badges" | "music";

type Step = {
  id: string;
  /** Le menu à ouvrir en arrivant sur l'étape. */
  scope?: TourScope;
  /** La case (`data-tour`) au-dessus de laquelle se poser, et qu'on encadre. */
  anchor?: string;
  /** Un second cadre, dans le profil (`data-tour`), avec sa légende. */
  spot?: string;
  /** L'étape montre l'onglet Aperçu (la grille des widgets n'est que là). */
  overview?: boolean;
};

const STEPS: Step[] = [
  { id: "intro", anchor: "bar" },
  /* Le Fond, bouton par bouton (10/11, Luc). */
  { id: "bgColor", scope: "color", anchor: "bg-color" },
  { id: "bgImage", scope: "image", anchor: "bg-image" },
  { id: "bgVideo", scope: "video", anchor: "bg-video" },
  { id: "bgUpload", scope: "upload", anchor: "bg-upload" },
  { id: "layout", scope: "layout", anchor: "layout" },
  { id: "widgets", scope: "widgets", anchor: "widgets", spot: "grid", overview: true },
  { id: "avatar", scope: "avatar", anchor: "avatar" },
  { id: "badges", scope: "badges", anchor: "badges" },
  { id: "music", scope: "music", anchor: "music" },
  { id: "save", anchor: "save" },
];

const W = 320;
const GAP = 14;
const EDGE = 16;
const EASE = "cubic-bezier(.22,1,.36,1)";

function tourDone(): boolean {
  try {
    /* `?tour` dans l'adresse : rejouer le tour (tests). */
    if (new URLSearchParams(location.search).has("tour")) return false;
    return localStorage.getItem(DONE_KEY) != null;
  } catch {
    /* stockage refusé : on ne rejoue pas un tour qu'on ne pourrait pas clore */
    return true;
  }
}
function markDone() {
  try {
    localStorage.setItem(DONE_KEY, String(Date.now()));
  } catch {
    /* rien à retenir */
  }
}

/** La première case `data-tour` VISIBLE (le bouton Enregistrer existe aussi
 *  dans la pilule réduite). */
function findAnchor(name: string): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`);
  for (const el of all) if (el.getClientRects().length) return el;
  return null;
}

type Box = { left: number; top: number; width: number; height: number };

/** Le rectangle ramené à l'écran (et au-dessus de `floor`) ; rien s'il n'en
 *  reste presque rien. */
function clip(r: DOMRect, pad: number, floor = Infinity, within?: DOMRect): Box | null {
  const l = Math.max(r.left - pad, 4, within ? within.left + 6 : 0);
  const t = Math.max(r.top - pad, 4, within ? within.top + 6 : 0);
  const rt = Math.min(r.right + pad, window.innerWidth - 4, within ? within.right - 6 : Infinity);
  const b = Math.min(r.bottom + pad, window.innerHeight - 4, floor, within ? within.bottom - 6 : Infinity);
  if (rt - l < 12 || b - t < 12) return null;
  return { left: l, top: t, width: rt - l, height: b - t };
}

/** Le cadre qui fait défiler `el` (la scène du profil) : les pointillés
 *  restent dedans au lieu de déborder sur la page. */
function scroller(el: HTMLElement): DOMRect | undefined {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") return p.getBoundingClientRect();
  }
  return undefined;
}

/** Le rectangle des blocs eux-mêmes (`[data-widget]`) : la boîte de la grille
 *  garde sous eux une rangée vide où déposer, et le cadre tombait trop bas. */
function contentRect(el: HTMLElement): DOMRect {
  const items = el.querySelectorAll<HTMLElement>("[data-widget]");
  if (!items.length) return el.getBoundingClientRect();
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const it of items) {
    const q = it.getBoundingClientRect();
    if (!q.width) continue;
    l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom);
  }
  return l === Infinity ? el.getBoundingClientRect() : new DOMRect(l, t, r - l, b - t);
}

type Pos = { x: number; y: number; arrow: number; below: boolean } | null;

export default function StudioTour({
  active,
  openScope,
  currentScope,
}: {
  /** Le studio est ouvert en scène (pas réduit). */
  active: boolean;
  openScope: (s: TourScope) => void;
  /** Le menu ouvert au départ, rouvert à la fin du tour. */
  currentScope: () => string | null;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<number | null>(null);
  const [pos, setPos] = useState<Pos>(null);
  const [ring, setRing] = useState<Box | null>(null);
  const [spot, setSpot] = useState<Box | null>(null);
  const startScope = useRef<string | null>(null);
  const card = useRef<HTMLDivElement>(null);
  /* La bulle et le cadre glissent d'une case à l'autre, mais pas depuis leur
     place de départ (hors écran). */
  const [glide, setGlide] = useState(false);
  const [leaving, setLeaving] = useState(false);

  /* Le départ : un temps après l'ouverture, que la scène ait fini d'entrer. */
  useEffect(() => {
    if (!active || step != null || tourDone()) return;
    const id = window.setTimeout(() => {
      startScope.current = currentScope();
      setStep(0);
    }, 900);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const reset = () => {
    setStep(null);
    setPos(null);
    setRing(null);
    setSpot(null);
    setGlide(false);
  };

  const end = useCallback(() => {
    markDone();
    reset();
    const back = startScope.current;
    if (back && STEPS.some((s) => s.scope === back)) openScope(back as TourScope);
  }, [openScope]);

  /* Le studio se ferme ou se réduit en plein tour : la bulle s'en va, mais le
     tour n'est PAS compté comme vu (Luc, 10/11) — seuls Skip, la croix, Échap
     ou la dernière étape le closent. Il repart du début à la réouverture. */
  useEffect(() => {
    if (!active && step != null) reset();
  }, [active, step]);

  /* Sortie : la bulle s'efface avant de disparaître. */
  const close = useCallback(() => {
    setLeaving(true);
    window.setTimeout(() => {
      setLeaving(false);
      end();
    }, 200);
  }, [end]);

  const cur = step != null ? STEPS[step] : null;

  useEffect(() => {
    if (!pos || glide) return;
    const id = requestAnimationFrame(() => setGlide(true));
    return () => cancelAnimationFrame(id);
  }, [pos, glide]);

  /* Ouvrir le menu de l'étape ; revenir sur Aperçu si elle en a besoin (les
     deux pages de profil suivent `hashchange`, cf. lib/profile/tabHash.ts). */
  useEffect(() => {
    if (cur?.scope) openScope(cur.scope);
    if (cur?.overview && lireOnglet() !== "overview") {
      ecrireOnglet("overview");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
  }, [cur, openScope]);

  /* Placer la bulle et les cadres. */
  const place = useCallback(() => {
    if (!cur) return;
    const el = cur.anchor ? findAnchor(cur.anchor) : null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(W, vw - EDGE * 2);
    const h = card.current?.offsetHeight ?? 180;

    const bar = findAnchor("bar");
    const sp = cur.spot ? findAnchor(cur.spot) : null;
    setSpot(sp ? clip(contentRect(sp), 8, bar ? bar.getBoundingClientRect().top - 10 : Infinity, scroller(sp)) : null);

    if (!el) {
      setRing(null);
      setPos({ x: (vw - w) / 2, y: Math.max(EDGE, (vh - h) / 2), arrow: -1, below: false });
      return;
    }
    const r = el.getBoundingClientRect();
    /* Le bouton Enregistrer est une pilule : un cadre un peu plus large. */
    setRing(clip(r, el.tagName === "BUTTON" ? 4 : 0));
    const cx = r.left + r.width / 2;
    const left = Math.min(Math.max(EDGE, cx - w / 2), vw - EDGE - w);
    const below = r.top < vh / 2;
    setPos({
      x: left,
      y: below ? r.bottom + GAP : Math.max(EDGE, Math.max(r.top, 0) - GAP - h),
      arrow: Math.min(Math.max(18, cx - left), w - 18),
      below,
    });
  }, [cur]);

  useLayoutEffect(() => {
    if (!cur) return;
    const el = cur.anchor ? findAnchor(cur.anchor) : null;
    /* Sur téléphone la barre défile : la case visée vient au milieu. */
    if (cur.anchor !== "bar") el?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    place();
    /* Le menu qui s'ouvre, l'onglet qui change, la barre qui défile bougent
       les choses un moment. */
    const ids = [120, 380, 700, 1100].map((ms) => window.setTimeout(place, ms));
    const scroll = cur.spot
      ? window.setTimeout(() => findAnchor(cur.spot!)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 160)
      : 0;
    let raf = 0;
    const onMove = () => {
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), place()));
    };
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    /* Le liseré du menu actif ferait doublon avec le cadre. */
    document.documentElement.classList.add("as-touring");
    return () => {
      ids.forEach((i) => window.clearTimeout(i));
      window.clearTimeout(scroll);
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
      document.documentElement.classList.remove("as-touring");
    };
  }, [cur, place]);

  /* Échap sort du tour (il ne ferme rien d'autre dans le studio). */
  useEffect(() => {
    if (step == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, close]);

  if (step == null || !cur || typeof document === "undefined") return null;
  const last = step === STEPS.length - 1;
  const w = typeof window !== "undefined" ? Math.min(W, window.innerWidth - EDGE * 2) : W;
  const slide = glide ? `transform .5s ${EASE}` : "none";
  /* Le contenu de chaque étape monte en cascade. */
  const rise = (n: number) => ({ style: { animationDelay: `${60 + n * 55}ms` } });

  return createPortal(
    <>
      {ring ? (
        <div
          aria-hidden
          key={`ring-${cur.id}`}
          className="pointer-events-none fixed left-0 top-0 z-[10009]"
          style={{ transform: `translate3d(${ring.left}px,${ring.top}px,0)`, width: ring.width, height: ring.height }}
        >
          <div className={`as-tour-ring h-full w-full rounded-xl ${leaving ? "is-leaving" : ""}`} />
        </div>
      ) : null}

      {spot ? (
        <div
          aria-hidden
          key={`spot-${cur.id}`}
          className="pointer-events-none fixed left-0 top-0 z-[10009]"
          style={{ transform: `translate3d(${spot.left}px,${spot.top}px,0)`, width: spot.width, height: spot.height }}
        >
          <div className={`as-tour-spot relative h-full w-full ${leaving ? "is-leaving" : ""}`}>
            <svg className="absolute inset-0 h-full w-full overflow-visible">
              <rect
                x="1"
                y="1"
                rx="16"
                width={Math.max(0, spot.width - 2)}
                height={Math.max(0, spot.height - 2)}
                fill="none"
                stroke="#E94560"
                strokeWidth="2"
                strokeDasharray="8 8"
                strokeLinecap="round"
              />
            </svg>
            <span className="as-tour-chip absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-action px-3 py-1.5 font-outfit text-[11.5px] font-bold text-white shadow-[0_4px_12px_rgba(233,69,96,.35)]">
              <ArrowsPointingOutIcon className="as-tour-nudge h-3.5 w-3.5" strokeWidth={2.2} />
              {t(`profile.studioTour.${cur.id}.spot`)}
            </span>
          </div>
        </div>
      ) : null}

      <div
        className="fixed left-0 top-0 z-[10010]"
        style={{
          width: w,
          transform: pos ? `translate3d(${pos.x}px,${pos.y}px,0)` : "translate3d(-9999px,0,0)",
          visibility: pos ? "visible" : "hidden",
          transition: slide,
        }}
      >
      <div
        ref={card}
        role="dialog"
        aria-modal="false"
        aria-labelledby="as-tour-title"
        className={`as-tour-card relative rounded-2xl bg-[#15161d] p-4 text-white shadow-[0_12px_32px_rgba(0,0,0,.55)] ring-1 ring-white/10 ${
          leaving ? "is-leaving" : ""
        }`}
      >
        {pos && pos.arrow >= 0 ? (
          <span
            aria-hidden
            /* LOSANGE ARRONDI (10/11, Luc, choix 1 sur 10) : la pointe est
               arrondie, le liseré ne suit que les deux bords extérieurs. */
            className={`absolute left-0 h-3.5 w-3.5 bg-[#15161d] ${
              pos.below
                ? "-top-[7px] rounded-tl-[4px] shadow-[-1px_-1px_0_rgba(255,255,255,.1)]"
                : "-bottom-[7px] rounded-br-[4px] shadow-[1px_1px_0_rgba(255,255,255,.1)]"
            }`}
            style={{ transform: `translateX(${pos.arrow - 7}px) rotate(45deg)`, transition: slide }}
          />
        ) : null}

        <div key={cur.id}>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p {...rise(0)} className="as-tour-rise m-0 font-karla text-[10.5px] font-bold uppercase tracking-[.12em] text-action">
                {t("profile.studioTour.count", { n: step + 1, total: STEPS.length })}
              </p>
              <h3 id="as-tour-title" {...rise(1)} className="as-tour-rise m-0 mt-1 font-outfit text-[16px] font-bold leading-snug">
                {t(`profile.studioTour.${cur.id}.title`)}
              </h3>
            </div>
            <button
              type="button"
              onClick={close}
              title={t("profile.studioTour.close")}
              aria-label={t("profile.studioTour.close")}
              className="-mr-1.5 -mt-1.5 grid h-8 w-8 shrink-0 place-items-center rounded-full text-white/50 transition-all duration-200 hover:rotate-90 hover:bg-white/10 hover:text-white"
            >
              <XMarkIcon className="h-4 w-4" strokeWidth={2} />
            </button>
          </div>

          <p {...rise(2)} className="as-tour-rise m-0 mt-2 font-karla text-[13px] leading-relaxed text-white/70">
            {t(`profile.studioTour.${cur.id}.body`)}
          </p>

          <div {...rise(3)} className="as-tour-rise mt-4 flex items-center justify-end gap-2">
            {!last ? (
              <button
                type="button"
                onClick={close}
                className="mr-auto shrink-0 rounded-full px-2 py-1.5 font-outfit text-[11.5px] font-bold text-white/45 transition-colors hover:text-white"
              >
                {t("profile.studioTour.skip")}
              </button>
            ) : null}
            {step > 0 ? (
              <button
                type="button"
                onClick={() => setStep(step - 1)}
                className="shrink-0 rounded-full bg-white/[0.08] px-3.5 py-1.5 font-outfit text-[11.5px] font-bold text-white/85 transition-all duration-200 hover:-translate-y-px hover:bg-white/[0.16] hover:text-white"
              >
                {t("profile.studioTour.prev")}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => (last ? close() : setStep(step + 1))}
              className="as-tour-cta shrink-0 rounded-full bg-action px-4 py-1.5 font-outfit text-[11.5px] font-bold text-white"
            >
              {t(last ? "profile.studioTour.finish" : step === 0 ? "profile.studioTour.start" : "profile.studioTour.next")}
            </button>
          </div>
        </div>
      </div>
      </div>
    </>,
    document.body,
  );
}
