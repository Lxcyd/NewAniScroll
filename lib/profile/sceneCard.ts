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
    el.style.translate = stage && stage.scrollTop ? `0 ${stage.scrollTop}px` : "";
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
    if (!stage) return;
    const obs = new MutationObserver(update);
    obs.observe(stage, { attributes: true, attributeFilter: ["class"] });
    stage.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      obs.disconnect();
      stage.removeEventListener("scroll", update);
    };
  }, [update]);
  return ref;
}
