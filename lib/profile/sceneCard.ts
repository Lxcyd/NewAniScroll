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

/**
 * LA CASE RESTE DANS LA PAGE (05/11/2026, Luc) : en bas de page, elle ne passe
 * pas sur le pied de page. Elle remonte d'autant qu'il faut — `margin-bottom`,
 * qui décale une case `fixed` depuis le bas sans toucher à son `transform`
 * (celui de la scène) ni à son `translate` (celui du défilement du cadre).
 *
 * Le bas « naturel » de la case se déduit de sa position mesurée moins le
 * décalage déjà posé : la même mesure marche sur le profil, dans le cadre de la
 * scène et dans le studio, sans connaître leurs transformations.
 */
export function useAboveFooter(): (el: HTMLDivElement | null) => void {
  const card = useRef<HTMLDivElement | null>(null);
  const lifted = useRef(0);
  const update = useCallback(() => {
    const el = card.current;
    if (!el) return;
    const footers = document.querySelectorAll("footer");
    const footer = footers[footers.length - 1];
    const natural = el.getBoundingClientRect().bottom + lifted.current;
    const lift = footer ? Math.max(0, Math.round(natural - (footer.getBoundingClientRect().top - 16))) : 0;
    if (lift === lifted.current) return;
    lifted.current = lift;
    el.style.marginBottom = lift ? `${lift}px` : "";
  }, []);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      card.current?.removeEventListener("transitionend", update);
      card.current = el;
      /* La case glisse avec le cadre (transition de `transform`) : on remesure à l'arrivée. */
      el?.addEventListener("transitionend", update);
      update();
    },
    [update],
  );
  useEffect(() => {
    /* `scroll` ne remonte pas : en capture, il attrape la fenêtre comme le cadre de la scène. */
    document.addEventListener("scroll", update, { passive: true, capture: true });
    window.addEventListener("resize", update);
    const size = new ResizeObserver(update);
    size.observe(document.body);
    update();
    return () => {
      size.disconnect();
      document.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [update]);
  return ref;
}

/** Les deux ensemble, pour la case du profil. */
export function useSceneCard(): (el: HTMLDivElement | null) => void {
  const a = useSceneScrollFix();
  const b = useAboveFooter();
  return useCallback(
    (el: HTMLDivElement | null) => {
      a(el);
      b(el);
    },
    [a, b],
  );
}
