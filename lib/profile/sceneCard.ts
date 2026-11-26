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
  /* LE PIED DE PAGE EST-IL PRÈS DE L'ÉCRAN ? (26/11/2026, passe vitesse du
     profil). La mesure lit deux `getBoundingClientRect`, et elle tournait à
     chaque changement de taille de la page — pendant le chargement, une fois
     par bloc qui arrive : autant de mises en page forcées (130 ms sur mobile,
     CPU ×4). Or la case est collée au bas de l'écran : tant que le pied de
     page n'y est pas, il n'y a rien à remonter, sans rien mesurer. Un
     IntersectionObserver (asynchrone, gratuit) dit quand il approche ; `null`
     = pas d'observateur, on mesure comme avant. */
  const near = useRef<boolean | null>(null);
  const update = useCallback(() => {
    const el = card.current;
    if (!el) return;
    if (near.current === false) {
      /* Pied de page loin sous l'écran : la case est à sa place naturelle. */
      if (lifted.current) {
        lifted.current = 0;
        el.style.marginBottom = "";
      }
      return;
    }
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
    const footers = document.querySelectorAll("footer");
    const footer = footers[footers.length - 1];
    let io: IntersectionObserver | null = null;
    if (footer && typeof IntersectionObserver !== "undefined") {
      /* Loin jusqu'à preuve du contraire : le premier rappel arrive aussitôt
         (il y en a toujours un) et mesure si le pied de page est là. Large
         marge : la case se lève 16 px avant lui, et le cadre de la scène
         peut le rapprocher en défilant. */
      near.current = false;
      io = new IntersectionObserver(
        (seen) => {
          near.current = seen[seen.length - 1]?.isIntersecting ?? true;
          update();
        },
        { rootMargin: "0px 0px 200px 0px" },
      );
      io.observe(footer);
    }
    /* `scroll` ne remonte pas : en capture, il attrape la fenêtre comme le cadre de la scène. */
    document.addEventListener("scroll", update, { passive: true, capture: true });
    window.addEventListener("resize", update);
    const size = new ResizeObserver(update);
    size.observe(document.body);
    update();
    return () => {
      io?.disconnect();
      near.current = null;
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
