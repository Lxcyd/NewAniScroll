/**
 * LA CASE EN BAS À DROITE DU PROFIL, PENDANT LA SCÈNE DU STUDIO (22/10/2026).
 *
 * Elle est `fixed`, mais sous un ancêtre transformé — le cadre de la scène,
 * `.as-stage.is-fixed` (ProfileStage) — `fixed` se place par rapport à ce
 * cadre, et le cadre DÉFILE : défilé de S pixels, la case remontait de S et
 * sortait de son coin. Elle est décalée d'autant, le temps que la scène
 * dure ; hors scène le décalage est retiré.
 *
 * Rien à animer ici : le cadre la porte, la transformation fait le reste.
 */
import { useCallback, useEffect, useRef } from "react";

export function useSceneScrollFix(): (el: HTMLDivElement | null) => void {
  const card = useRef<HTMLDivElement | null>(null);
  const update = useCallback(() => {
    const el = card.current;
    if (!el) return;
    const stage = document.querySelector<HTMLElement>(".as-stage.is-fixed");
    const scrolled = stage ? stage.scrollTop : 0;
    /* LA CASE RESTE DANS LA PAGE (05/11/2026, Luc) : arrivée au pied de la
       page, elle ne passe pas sur le pied de page — elle remonte d'autant que
       celui-ci entre dans l'écran, et garde 16 px d'air au-dessus. */
    const footer = document.querySelector("footer");
    const lift = footer ? Math.max(0, window.innerHeight - footer.getBoundingClientRect().top - 8) : 0;
    const y = scrolled - lift;
    el.style.translate = y ? `0 ${y}px` : "";
  }, []);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      card.current = el;
      update();
    },
    [update],
  );
  useEffect(() => {
    const stage = document.querySelector<HTMLElement>(".as-stage");
    const obs = new MutationObserver(update);
    if (stage) {
      obs.observe(stage, { attributes: true, attributeFilter: ["class"] });
      stage.addEventListener("scroll", update, { passive: true });
    }
    /* La page défile (ou se redimensionne) : le pied de page monte ou descend. */
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    const size = new ResizeObserver(update);
    size.observe(document.body);
    update();
    return () => {
      obs.disconnect();
      size.disconnect();
      stage?.removeEventListener("scroll", update);
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [update]);
  return ref;
}
