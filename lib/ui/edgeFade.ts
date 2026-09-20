import { useCallback, useEffect } from "react";

/**
 * LES BORDS ESTOMPÉS D'UN CARROUSEL.
 *
 * Une bande qui défile s'arrête net sur le bord de sa boîte : l'affiche coupée
 * en deux se lit comme un défaut d'affichage, pas comme la suite de la liste. Un
 * masque en dégradé l'éteint sur les derniers pixels — voir `.as-fade-x` dans
 * globals.css, qui porte le masque ; ce hook ne fait que dire OÙ l'appliquer.
 *
 * ET SEULEMENT DU CÔTÉ OÙ IL RESTE QUELQUE CHOSE. Estomper le premier titre
 * alors qu'on est déjà au début de la liste ferait croire à tort qu'on a raté
 * quelque chose à gauche. Les deux longueurs sont donc remises à zéro dès qu'on
 * touche une extrémité.
 *
 * Écrit dans le style du nœud plutôt que dans un état React : c'est une
 * conséquence du défilement, et le repasser par un rendu ferait un rendu par
 * frame de défilement pour deux longueurs de dégradé.
 *
 * Né dans la vitrine du profil, sorti ici pour que les carrousels du site — les
 * recommandations d'une fiche, les rangées de l'accueil — aient EXACTEMENT le
 * même bord, et non trois imitations qui dérivent.
 */

/** La longueur du dégradé. Un seul chiffre, pour que les bords soient les mêmes. */
const FADE_PX = 36;

/** La marge d'erreur : sous quelques pixels, on est au bout. */
const EDGE_SLACK = 4;

export function useEdgeFade<T extends HTMLElement>(
  ref: { current: T | null },
  /**
   * Ce qui, en changeant, change la LONGUEUR de la bande — le nombre de cartes,
   * le plus souvent. Un `ResizeObserver` ne suffit pas : il voit la boîte du
   * conteneur, qui ne bouge pas quand son contenu s'allonge derrière un
   * `overflow: auto`. Sans cette dépendance, une rangée remplie après coup
   * garderait le bord qu'elle avait quand elle était vide.
   */
  contentKey?: unknown,
) {
  const sync = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > EDGE_SLACK;
    const right =
      el.scrollLeft + el.clientWidth < el.scrollWidth - EDGE_SLACK;
    el.style.setProperty("--as-fade-l", left ? `${FADE_PX}px` : "0px");
    el.style.setProperty("--as-fade-r", right ? `${FADE_PX}px` : "0px");
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, sync, contentKey]);

  /** À brancher sur `onScroll` du conteneur. */
  return sync;
}
