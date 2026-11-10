/**
 * LE TOUR DU STUDIO (09/11/2026, Luc) : une bulle par menu, « Suivant » ouvre
 * le menu dont elle parle, « Passer » arrête tout. Joué UNE fois par
 * navigateur (`aniscroll:studioTour`).
 *
 * Pas de voile sur l'écran (Luc : « pas trop intrusif ») : la bulle se pose
 * au-dessus de la case de la barre du bas qu'elle présente, la case s'allume
 * (`.as-tour-target`), et le menu s'ouvre à gauche comme au clic. Le profil
 * reste visible et cliquable ; cliquer ailleurs ne ferme pas le tour, la
 * croix et « Passer » si. Même principe que les visites guidées de Notion ou
 * de Linear : une étape = une chose, un bouton pour avancer, un pour sortir.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { XMarkIcon } from "@heroicons/react/24/outline";

const DONE_KEY = "aniscroll:studioTour";

export type TourScope = "image" | "layout" | "widgets" | "avatar" | "badges" | "music";

type Step = {
  id: string;
  /** Le menu à ouvrir en arrivant sur l'étape. */
  scope?: TourScope;
  /** La case de la barre (`data-tour`) au-dessus de laquelle se poser. */
  anchor?: string;
};

const STEPS: Step[] = [
  { id: "intro" },
  { id: "background", scope: "image", anchor: "background" },
  { id: "layout", scope: "layout", anchor: "layout" },
  { id: "widgets", scope: "widgets", anchor: "widgets" },
  { id: "avatar", scope: "avatar", anchor: "avatar" },
  { id: "badges", scope: "badges", anchor: "badges" },
  { id: "music", scope: "music", anchor: "music" },
  { id: "save", anchor: "save" },
];

const W = 320;
const GAP = 14;
const EDGE = 16;

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
  const startScope = useRef<string | null>(null);
  const card = useRef<HTMLDivElement>(null);

  /* Le départ : un temps après l'ouverture, que la scène ait fini d'entrer. */
  useEffect(() => {
    if (!active || step != null || tourDone()) return;
    const id = window.setTimeout(() => {
      startScope.current = currentScope();
      /* Vu dès qu'il démarre : fermer le studio en plein tour démonte ce
         composant sans passer par `end`, et le tour reviendrait sinon. */
      markDone();
      setStep(0);
    }, 900);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const end = useCallback(() => {
    markDone();
    setStep(null);
    setPos(null);
    const back = startScope.current;
    if (back && STEPS.some((s) => s.scope === back)) openScope(back as TourScope);
  }, [openScope]);

  /* Le studio se ferme ou se réduit en plein tour : le tour s'arrête, compté
     comme vu — le rejouer à chaque réouverture deviendrait intrusif. */
  useEffect(() => {
    if (!active && step != null) {
      markDone();
      setStep(null);
    }
  }, [active, step]);

  const cur = step != null ? STEPS[step] : null;

  /* Ouvrir le menu de l'étape. */
  useEffect(() => {
    if (cur?.scope) openScope(cur.scope);
  }, [cur, openScope]);

  /* Placer la bulle, et allumer la case visée. */
  const place = useCallback(() => {
    if (!cur) return;
    const el = cur.anchor ? findAnchor(cur.anchor) : null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(W, vw - EDGE * 2);
    const h = card.current?.offsetHeight ?? 180;
    if (!el) {
      setPos({ left: (vw - w) / 2, top: Math.max(EDGE, (vh - h) / 2), arrow: -1, below: false });
      return;
    }
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const left = Math.min(Math.max(EDGE, cx - w / 2), vw - EDGE - w);
    const below = r.top < vh / 2;
    setPos({
      left,
      ...(below ? { top: r.bottom + GAP } : { bottom: vh - r.top + GAP }),
      arrow: Math.min(Math.max(18, cx - left), w - 18),
      below,
    });
  }, [cur]);

  useLayoutEffect(() => {
    if (!cur) return;
    const el = cur.anchor ? findAnchor(cur.anchor) : null;
    /* Sur téléphone la barre défile : la case visée vient au milieu. */
    el?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    el?.classList.add("as-tour-target");
    place();
    /* Le menu qui s'ouvre et la barre qui défile bougent la case un moment. */
    const ids = [120, 380, 700].map((ms) => window.setTimeout(place, ms));
    window.addEventListener("resize", place);
    return () => {
      ids.forEach((i) => window.clearTimeout(i));
      window.removeEventListener("resize", place);
      el?.classList.remove("as-tour-target");
    };
  }, [cur, place]);

  /* Échap sort du tour (il ne ferme rien d'autre dans le studio). */
  useEffect(() => {
    if (step == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") end();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, end]);

  if (step == null || !cur || typeof document === "undefined") return null;
  const last = step === STEPS.length - 1;
  const w = typeof window !== "undefined" ? Math.min(W, window.innerWidth - EDGE * 2) : W;

  return createPortal(
    <div
      ref={card}
      role="dialog"
      aria-modal="false"
      aria-labelledby="as-tour-title"
      key={cur.id}
      className="as-tour-card fixed z-[10010] rounded-2xl bg-[#15161d] p-4 text-white shadow-[0_24px_60px_rgba(0,0,0,.7)] ring-1 ring-white/10"
      style={{
        width: w,
        left: pos?.left ?? -9999,
        top: pos?.top,
        bottom: pos?.bottom,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {pos && pos.arrow >= 0 ? (
        <span
          aria-hidden
          className={`absolute h-3 w-3 rotate-45 bg-[#15161d] ring-1 ring-white/10 ${
            pos.below ? "-top-1.5 [clip-path:polygon(0_0,100%_0,0_100%)]" : "-bottom-1.5 [clip-path:polygon(100%_0,100%_100%,0_100%)]"
          }`}
          style={{ left: pos.arrow - 6 }}
        />
      ) : null}

      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="m-0 font-karla text-[10.5px] font-bold uppercase tracking-[.12em] text-action">
            {t("profile.studioTour.count", { n: step + 1, total: STEPS.length })}
          </p>
          <h3 id="as-tour-title" className="m-0 mt-1 font-outfit text-[16px] font-bold leading-snug">
            {t(`profile.studioTour.${cur.id}.title`)}
          </h3>
        </div>
        <button
          type="button"
          onClick={end}
          title={t("profile.studioTour.close")}
          aria-label={t("profile.studioTour.close")}
          className="-mr-1.5 -mt-1.5 grid h-8 w-8 shrink-0 place-items-center rounded-full text-white/50 transition-colors hover:bg-white/10 hover:text-white"
        >
          <XMarkIcon className="h-4 w-4" strokeWidth={2} />
        </button>
      </div>

      <p className="m-0 mt-2 font-karla text-[13px] leading-relaxed text-white/70">
        {t(`profile.studioTour.${cur.id}.body`)}
      </p>

      {/* Les points : où on en est, sans chiffre à lire. */}
      <div className="mt-4 flex items-center gap-2">
        <div className="flex flex-1 items-center gap-1" aria-hidden>
          {STEPS.map((s, i) => (
            <span
              key={s.id}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                i === step ? "w-4 bg-action" : i < step ? "w-1.5 bg-white/45" : "w-1.5 bg-white/15"
              }`}
            />
          ))}
        </div>
        {!last ? (
          <button
            type="button"
            onClick={end}
            className="shrink-0 rounded-full px-2.5 py-1.5 font-outfit text-[11.5px] font-bold text-white/50 transition-colors hover:text-white"
          >
            {t("profile.studioTour.skip")}
          </button>
        ) : null}
        {step > 0 ? (
          <button
            type="button"
            onClick={() => setStep(step - 1)}
            className="shrink-0 rounded-full bg-white/[0.08] px-3.5 py-1.5 font-outfit text-[11.5px] font-bold text-white/85 transition-colors hover:bg-white/[0.16] hover:text-white"
          >
            {t("profile.studioTour.prev")}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => (last ? end() : setStep(step + 1))}
          className="shrink-0 rounded-full bg-action px-4 py-1.5 font-outfit text-[11.5px] font-bold text-white transition-transform hover:scale-105"
        >
          {t(last ? "profile.studioTour.finish" : step === 0 ? "profile.studioTour.start" : "profile.studioTour.next")}
        </button>
      </div>
    </div>,
    document.body,
  );
}
