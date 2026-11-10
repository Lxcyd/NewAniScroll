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
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ArrowsPointingOutIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { ecrireOnglet, lireOnglet } from "@/lib/profile/tabHash";

/* Changer le suffixe rejoue le tour pour tout le monde (nouvelle version). */
const DONE_KEY = "aniscroll:studioTour:5";

export type TourScope = "image" | "layout" | "widgets" | "avatar" | "badges" | "music";

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
  { id: "background", scope: "image", anchor: "background" },
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
function clip(r: DOMRect, pad: number, floor = Infinity): Box | null {
  const l = Math.max(r.left - pad, 4);
  const t = Math.max(r.top - pad, 4);
  const rt = Math.min(r.right + pad, window.innerWidth - 4);
  const b = Math.min(r.bottom + pad, window.innerHeight - 4, floor);
  if (rt - l < 12 || b - t < 12) return null;
  return { left: l, top: t, width: rt - l, height: b - t };
}

type Pos = { left: number; top?: number; bottom?: number; arrow: number; below: boolean } | null;

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
    setSpot(sp ? clip(sp.getBoundingClientRect(), 8, bar ? bar.getBoundingClientRect().top - 10 : Infinity) : null);

    if (!el) {
      setRing(null);
      setPos({ left: (vw - w) / 2, top: Math.max(EDGE, (vh - h) / 2), arrow: -1, below: false });
      return;
    }
    const r = el.getBoundingClientRect();
    /* Le bouton Enregistrer est une pilule : un cadre un peu plus large. */
    setRing(clip(r, el.tagName === "BUTTON" ? 4 : 0));
    const cx = r.left + r.width / 2;
    const left = Math.min(Math.max(EDGE, cx - w / 2), vw - EDGE - w);
    const below = r.top < vh / 2;
    setPos({
      left,
      ...(below ? { top: r.bottom + GAP } : { bottom: vh - Math.max(r.top, 0) + GAP }),
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
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      ids.forEach((i) => window.clearTimeout(i));
      window.clearTimeout(scroll);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
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
  const move = glide ? `left .5s ${EASE}, top .5s ${EASE}, width .5s ${EASE}, height .5s ${EASE}, bottom .5s ${EASE}` : "none";
  /* Le contenu de chaque étape monte en cascade. */
  const rise = (n: number) => ({ style: { animationDelay: `${60 + n * 55}ms` } });

  return createPortal(
    <>
      {ring ? (
        <div
          aria-hidden
          className={`as-tour-ring pointer-events-none fixed z-[10009] rounded-xl ${leaving ? "is-leaving" : ""}`}
          style={{ ...ring, transition: move }}
        />
      ) : null}

      {spot ? (
        <div
          aria-hidden
          key={`spot-${cur.id}`}
          className={`as-tour-spot pointer-events-none fixed z-[10009] ${leaving ? "is-leaving" : ""}`}
          style={spot}
        >
          <span className="as-tour-chip absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-action px-3 py-1.5 font-outfit text-[11.5px] font-bold text-white shadow-[0_6px_18px_rgba(233,69,96,.45)]">
            <ArrowsPointingOutIcon className="as-tour-nudge h-3.5 w-3.5" strokeWidth={2.2} />
            {t(`profile.studioTour.${cur.id}.spot`)}
          </span>
        </div>
      ) : null}

      <div
        ref={card}
        role="dialog"
        aria-modal="false"
        aria-labelledby="as-tour-title"
        className={`as-tour-card fixed z-[10010] rounded-2xl bg-[#15161d] p-4 text-white shadow-[0_24px_60px_rgba(0,0,0,.7)] ring-1 ring-white/10 ${
          leaving ? "is-leaving" : ""
        }`}
        style={{
          width: w,
          left: pos?.left ?? -9999,
          top: pos?.top,
          bottom: pos?.bottom,
          visibility: pos ? "visible" : "hidden",
          transition: move,
        }}
      >
        {pos && pos.arrow >= 0 ? (
          <span
            aria-hidden
            className={`absolute h-3 w-3 rotate-45 bg-[#15161d] ring-1 ring-white/10 ${
              pos.below ? "-top-1.5 [clip-path:polygon(0_0,100%_0,0_100%)]" : "-bottom-1.5 [clip-path:polygon(100%_0,100%_100%,0_100%)]"
            }`}
            style={{ left: pos.arrow - 6, transition: glide ? `left .5s ${EASE}` : "none" }}
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
    </>,
    document.body,
  );
}
