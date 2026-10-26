/**
 * FAIRE GLISSER UN CARROUSEL, SANS DÉPENDRE DU NAVIGATEUR (24/10/2026, Luc :
 * « les flèches doivent faire une animation pour déplacer les cards »).
 *
 * `scrollBy({ behavior: "smooth" })` était déjà là, et ne se voyait pas : Chrome
 * coupe le défilement doux quand le système demande moins d'animations — ce
 * qui est le cas du poste de Luc (cf. la note sur `prefers-reduced-motion`).
 * Les cartes sautaient donc d'un coup. L'animation est faite ici, image par
 * image, et ne dépend plus de ce réglage.
 */
const running = new WeakMap<HTMLElement, number>();

/** Fait défiler `el` de `dx` pixels en ~420 ms, avec une sortie douce. Un
    second appel pendant le premier repart de la position courante vers la
    nouvelle cible (deux clics rapides avancent de deux pas). */
export function glideScrollBy(el: HTMLElement, dx: number, ms = 420) {
  const prev = running.get(el);
  const pending = prev != null ? Number(el.dataset.glideTarget ?? el.scrollLeft) - el.scrollLeft : 0;
  if (prev != null) cancelAnimationFrame(prev);

  const max = el.scrollWidth - el.clientWidth;
  const from = el.scrollLeft;
  const to = Math.max(0, Math.min(max, from + pending + dx));
  el.dataset.glideTarget = String(to);
  const t0 = performance.now();
  // easeOutCubic : part vite, se pose doucement.
  const ease = (t: number) => 1 - Math.pow(1 - t, 3);

  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / ms);
    el.scrollLeft = from + (to - from) * ease(t);
    if (t < 1) running.set(el, requestAnimationFrame(step));
    else {
      running.delete(el);
      delete el.dataset.glideTarget;
    }
  };
  running.set(el, requestAnimationFrame(step));
}
