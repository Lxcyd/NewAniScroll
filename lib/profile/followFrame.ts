/**
 * LA CASE EN BAS À DROITE COLLE AU CADRE DE LA SCÈNE (22/10/2026, Luc) : à
 * chaque image, 24 px de son coin bas droit, à son échelle — pendant le
 * recul, le glissement, le retour et la poignée. Des transitions CSS sur les
 * variables de la scène sautaient d'un temps à l'autre au lieu de suivre.
 *
 * Le studio (BannerStudio) s'en sert tant qu'il est ouvert, le profil
 * (ProfileHero) pendant le retour. Sans cadre (scène finie), la case reprend
 * sa place de classe : les styles posés ici sont retirés.
 */
import { useCallback, useEffect, useRef } from "react";

export function useFollowFrame(active: boolean): (el: HTMLDivElement | null) => void {
  const card = useRef<HTMLDivElement | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    card.current = el;
  }, []);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = "";
    let lastEl: HTMLDivElement | null = null;
    const clear = (el: HTMLDivElement) => {
      el.style.right = el.style.bottom = el.style.transform = el.style.zIndex = "";
      last = "";
    };
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = card.current;
      if (!el) return;
      if (el !== lastEl) {
        lastEl = el;
        last = "";
      }
      const fr = document.querySelector<HTMLElement>(".as-scene-screen.is-fixed");
      if (!fr || !fr.offsetWidth) {
        if (last) clear(el);
        return;
      }
      const r = fr.getBoundingClientRect();
      const z = r.width / fr.offsetWidth;
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const right = Math.round((vw - r.right + 24 * z) * 10) / 10;
      const bottom = Math.round((vh - r.bottom + 24 * z) * 10) / 10;
      const zz = Math.round(z * 1000) / 1000;
      const key = `${right}|${bottom}|${zz}`;
      if (key === last) return;
      last = key;
      el.style.right = `${right}px`;
      el.style.bottom = `${bottom}px`;
      el.style.transform = `scale(${zz})`;
      el.style.transformOrigin = "bottom right";
      /* Au-dessus de l'écran de la scène (z 10001-10002). */
      el.style.zIndex = "10004";
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      if (lastEl) clear(lastEl);
    };
  }, [active]);
  return ref;
}
