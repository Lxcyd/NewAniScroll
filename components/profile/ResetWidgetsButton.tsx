import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowPathIcon } from "@heroicons/react/24/solid";

import { WIDGETS_RESET_EVENT } from "@/lib/profile/widgetBridge";

/** L'entrée d'un bouton de l'en-tête quand le studio s'ouvre ou se ferme.
    Une référence STABLE (hors composant) : passée en `ref`, elle ne joue
    qu'au montage. Animation en JS (Web Animations) : le Chrome de Luc est en
    `prefers-reduced-motion`, une animation CSS y serait coupée. */
export function popIn(el: HTMLElement | null) {
  el?.animate(
    [
      { opacity: 0, transform: "translateY(6px) scale(0.92)" },
      { opacity: 1, transform: "none" },
    ],
    { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" },
  );
}

/**
 * RÉINITIALISER LES WIDGETS (08/11/2026, Luc), dans le studio, à la place de
 * « Personnaliser le profil ». Même flou que les widgets (`as-stat-card`).
 *
 * LA VÉRIFICATION : une bulle sous le bouton dit ce qui va se passer et
 * demande de choisir entre « Annuler » et « Réinitialiser » (le double clic du
 * premier jet n'était pas clair, même jour). Échap ou un clic ailleurs
 * annulent.
 */
export default function ResetWidgetsButton() {
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => popIn(btn.current), []);

  /* LA BULLE SORT AUSSI EN ANIMATION (08/11/2026, Luc) : elle reste montée
     le temps de redescendre en s'effaçant, puis disparaît. */
  const closing = useRef(false);
  const close = () => {
    const el = box.current;
    if (!el || closing.current) return;
    closing.current = true;
    const run = el.animate(
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: "translateY(6px) scale(0.95)" },
      ],
      { duration: 180, easing: "ease-in", fill: "forwards" },
    );
    run.onfinish = run.oncancel = () => {
      closing.current = false;
      setAsking(false);
    };
  };

  useEffect(() => {
    if (!asking) return;
    popIn(box.current);
    cancel.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const down = (e: PointerEvent) => {
      const n = e.target as Node;
      if (!box.current?.contains(n) && !btn.current?.contains(n)) close();
    };
    window.addEventListener("keydown", key);
    window.addEventListener("pointerdown", down, true);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("pointerdown", down, true);
    };
  }, [asking]);

  return (
    <div className="relative">
      <button
        ref={btn}
        type="button"
        aria-expanded={asking}
        onClick={() => (asking ? close() : setAsking(true))}
        /* Le liseré des cartes du profil (`outline` blanc à 10 %, rentré d'un
           pixel), pas un `ring` : ses teintes à opacité retombaient ici sur
           le bleu par défaut (08/11/2026, Luc). */
        className={`as-stat-card inline-flex items-center gap-2 rounded-full px-5 py-2.5 font-karla text-sm font-bold outline outline-1 outline-offset-[-1px] transition-colors duration-200 ${
          asking ? "text-white outline-white/25" : "text-white/85 outline-white/10 hover:text-white hover:outline-white/20"
        }`}
      >
        <ArrowPathIcon className="h-5 w-5" />
        {t("profile.widgets.reset")}
      </button>
      {asking ? (
        <div
          ref={box}
          role="alertdialog"
          aria-labelledby="as-reset-title"
          aria-describedby="as-reset-body"
          className="absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-2xl border-2 border-[#2c2d36] bg-[#15161d] p-4 text-left shadow-[0_18px_44px_rgba(0,0,0,0.6)]"
        >
          <p id="as-reset-title" className="font-outfit text-base font-bold text-white">
            {t("profile.widgets.resetTitle")}
          </p>
          <p id="as-reset-body" className="mt-1.5 font-karla text-[13px] leading-snug text-white/65">
            {t("profile.widgets.resetBody")}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <button
              ref={cancel}
              type="button"
              onClick={close}
              className="rounded-full bg-white/10 px-4 py-2 font-karla text-[13px] font-bold text-white/85 outline outline-1 outline-offset-[-1px] outline-white/10 transition-colors hover:bg-white/15 hover:text-white"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={() => {
                close();
                window.dispatchEvent(new Event(WIDGETS_RESET_EVENT));
              }}
              className="inline-flex items-center gap-1.5 rounded-full bg-action px-4 py-2 font-karla text-[13px] font-bold text-white transition-[filter] hover:brightness-110"
            >
              <ArrowPathIcon className="h-4 w-4" />
              {t("profile.widgets.reset")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
