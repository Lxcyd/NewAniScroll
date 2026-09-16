/**
 * La file des achievements à montrer — un seul à l'écran à la fois.
 *
 * ── POURQUOI PAS `noticeStore` ───────────────────────────────────────────────
 * Le site a déjà un store de notices unifié (lib/notifications/noticeStore.ts),
 * et il serait tentant d'y pousser les badges. Trois choses l'en empêchent :
 *   - la POSITION : les notices s'empilent en bas à droite, l'achievement
 *     surgit en haut au centre ;
 *   - la DURÉE et la forme : l'achievement joue une animation en quatre temps,
 *     il ne se collapse pas dans une pile ni ne s'efface derrière une carte
 *     d'erreur ;
 *   - la FILE : trois badges qui tombent ensemble doivent défiler L'UN APRÈS
 *     L'AUTRE. La pile de notices, elle, les montrerait empilés — ce qui est le
 *     bon comportement pour des messages et le mauvais pour une récompense.
 *
 * Le patron est copié à l'identique (observable simple + `useSyncExternalStore`)
 * pour que les deux se lisent pareil.
 */

import { useSyncExternalStore } from "react";

export type Achievement = {
  /** L'id du badge — le composant va chercher le reste dans le catalogue. */
  id: string;
  /** Clé de rendu : un même badge re-annoncé doit rejouer l'animation. */
  key: number;
};

let queue: string[] = [];
let current: Achievement | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

/** Met des badges dans la file. Le premier part tout de suite s'il n'y a rien. */
export function announce(ids: string[]): void {
  if (!ids.length) return;
  queue = queue.concat(ids);
  if (!current) next();
  else emit();
}

/** Passe au suivant — appelé par le composant quand l'animation s'achève. */
export function next(): void {
  const id = queue.shift();
  current = id ? { id, key: ++seq } : null;
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot() {
  return current;
}

/* Rien à l'écran au rendu serveur : une notification est un événement du
   navigateur, et rendre autre chose ici casserait l'hydratation. */
function getServerSnapshot(): Achievement | null {
  return null;
}

export function useAchievement(): Achievement | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Combien attendent derrière — le composant en fait un « +2 ». */
export function pendingCount(): number {
  return queue.length;
}

/** Vide la file (déconnexion, remise à zéro des données). */
export function clearAchievements(): void {
  queue = [];
  current = null;
  emit();
}
