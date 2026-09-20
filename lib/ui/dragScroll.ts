import { useCallback, useEffect, useRef } from "react";

/**
 * Le « attraper et tirer » des carrousels du site.
 *
 * Extrait tel quel de components/anime/v2/Recommendations.tsx, qui reste son
 * premier appelant : le carrousel de recommandations EST la référence, et un
 * second carrousel qui se comporterait « presque » pareil serait pire qu'un
 * carrousel qui ne se tire pas du tout.
 *
 * DEUX DÉCISIONS QUI ONT COÛTÉ CHER, ET QUI VOYAGENT AVEC LE CODE.
 *
 * 1. PAS de `setPointerCapture`. Capturer le pointeur sur le conteneur vole le
 *    `click` final au <Link> enfant : un simple clic sur une carte ne naviguait
 *    plus. D'où `mousemove`/`mouseup` posés sur `window` le temps du glissement.
 * 2. La SOURIS seulement. Le tactile est laissé au défilement natif, sans une
 *    ligne de JS : une tape reste une tape, et le doigt garde son inertie.
 *
 * `onClickCapture` est le pendant du 1 : après un vrai glissement il annule le
 * clic qui suit, sans quoi relâcher au-dessus d'une carte ouvrirait sa fiche.
 */

/** Au-delà de ce déplacement en px, c'est un glissement et plus un clic. */
const DRAG_THRESHOLD = 8;

export function useDragScroll<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const movedRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let isDown = false;
    let startX = 0;
    let startScroll = 0;

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      isDown = true;
      startX = e.clientX;
      startScroll = el.scrollLeft;
      movedRef.current = false;
    };
    const onMove = (e: MouseEvent) => {
      if (!isDown) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > DRAG_THRESHOLD) movedRef.current = true;
      el.scrollLeft = startScroll - dx;
    };
    const onUp = () => {
      isDown = false;
    };

    el.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      el.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (movedRef.current) {
      e.preventDefault();
      e.stopPropagation();
      movedRef.current = false;
    }
  }, []);

  return { ref, onClickCapture };
}
