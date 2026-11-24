/**
 * LA MUSIQUE PASSE AVANT LE SON DE LA VIDÉO (24/11/2026, Luc) : une bulle du
 * style du tour (StudioTour) posée au-dessus de l'icône de volume de la
 * vidéo (`data-sound-tip`), sans cadre autour (Luc). Remplace la fenêtre
 * centrée qui ne s'affichait qu'une fois par navigateur : celle-ci revient à
 * chaque fois qu'une vidéo a du son alors qu'une musique est choisie.
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { XMarkIcon } from "@heroicons/react/24/outline";

const W = 280;
const GAP = 14;
const EDGE = 16;

type Pos = { x: number; y: number; arrow: number };

function findAnchor(): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>("[data-sound-tip]")) if (el.getClientRects().length) return el;
  return null;
}

export default function SoundTip({ show, onClose }: { show: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const card = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  const [leaving, setLeaving] = useState(false);

  const place = useCallback(() => {
    const el = findAnchor();
    if (!el) return setPos(null);
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const w = Math.min(W, vw - EDGE * 2);
    const h = card.current?.offsetHeight ?? 150;
    const cx = r.left + r.width / 2;
    const x = Math.min(Math.max(EDGE, cx - w / 2), vw - EDGE - w);
    setPos({
      x,
      y: Math.max(EDGE, r.top - GAP - h),
      arrow: Math.min(Math.max(18, cx - x), w - 18),
    });
  }, []);

  useLayoutEffect(() => {
    if (!show) return;
    place();
    /* La carte se mesure après son premier rendu ; le menu bouge en s'ouvrant. */
    const ids = [60, 300, 700].map((ms) => window.setTimeout(place, ms));
    let raf = 0;
    const onMove = () => {
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), place()));
    };
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      ids.forEach((i) => window.clearTimeout(i));
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [show, place]);

  const close = useCallback(() => {
    setLeaving(true);
    window.setTimeout(() => {
      setLeaving(false);
      onClose();
    }, 200);
  }, [onClose]);

  if (!show || typeof document === "undefined") return null;
  const w = Math.min(W, window.innerWidth - EDGE * 2);

  return createPortal(
    <>
      <div
        className="fixed left-0 top-0 z-[10010]"
        style={{
          width: w,
          transform: pos ? `translate3d(${pos.x}px,${pos.y}px,0)` : "translate3d(-9999px,0,0)",
          visibility: pos ? "visible" : "hidden",
        }}
      >
        <div
          ref={card}
          role="dialog"
          aria-modal="false"
          aria-labelledby="as-sound-tip"
          className={`as-tour-card relative rounded-2xl as-menu-bg p-4 text-white shadow-[0_12px_32px_rgba(0,0,0,.55)] ring-1 ring-white/10 ${
            leaving ? "is-leaving" : ""
          }`}
        >
          {pos ? (
            <span
              aria-hidden
              className="absolute -bottom-[7px] left-0 h-3.5 w-3.5 rounded-br-[4px] bg-[#14161c] shadow-[1px_1px_0_rgba(255,255,255,.1)]"
              style={{ transform: `translateX(${pos.arrow - 7}px) rotate(45deg)` }}
            />
          ) : null}
          <div className="flex items-start gap-3">
            <h3 id="as-sound-tip" className="as-tour-rise m-0 min-w-0 flex-1 font-outfit text-[16px] font-bold leading-snug">
              {t("profile.studioSoundTipTitle", { defaultValue: "La musique passe en premier" })}
            </h3>
            <button
              type="button"
              onClick={close}
              aria-label={t("common.close", { defaultValue: "Close" })}
              className="-mr-1.5 -mt-1.5 grid h-8 w-8 shrink-0 place-items-center rounded-full text-white/50 transition-all duration-200 hover:bg-white/10 hover:text-white"
            >
              <XMarkIcon className="h-4 w-4" strokeWidth={2} />
            </button>
          </div>
          <p className="as-tour-rise m-0 mt-2 font-karla text-[13px] leading-relaxed text-white/70" style={{ animationDelay: "60ms" }}>
            {t("profile.studioSoundTipBody", {
              defaultValue:
                "Tant qu'une musique est choisie, elle est prioritaire sur le son de la vidéo, même en pause. Retire-la pour entendre la vidéo.",
            })}
          </p>
          <div className="as-tour-rise mt-4 flex justify-end" style={{ animationDelay: "115ms" }}>
            <button
              type="button"
              onClick={close}
              className="as-tour-cta shrink-0 rounded-full bg-action px-4 py-1.5 font-outfit text-[11.5px] font-bold text-white"
            >
              {t("profile.studioSoundTipOk", { defaultValue: "Compris" })}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
