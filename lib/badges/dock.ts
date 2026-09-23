/**
 * LE QUAI — où va le jeton quand la notification s'en va, et ce qu'il y laisse.
 *
 * ── LE PROBLÈME ──────────────────────────────────────────────────────────────
 * Une récompense qui s'évapore n'en est pas une. Le jeton surgissait, la carte
 * s'ouvrait, tout remontait par le haut de l'écran, et il ne restait RIEN : ni
 * trace, ni chemin vers l'endroit où le badge est rangé. Quelqu'un qui n'était
 * pas devant son écran à cet instant précis ne saurait jamais qu'il a gagné
 * quelque chose.
 *
 * Deux choses vivent donc ici :
 *
 *   - LE QUAI lui-même : l'avatar de la navbar s'inscrit (`setDock`), et la
 *     notification lui demande sa position pour y envoyer le jeton. Même patron
 *     que lib/notifications/playerSurface.ts, et pour la même raison : deux
 *     composants qui ne se connaissent pas, montés dans des arbres différents,
 *     dont l'un a besoin d'un élément de l'autre. `null` quand la navbar est
 *     absente (page de visionnage, pleine page) — et le jeton repart alors par
 *     le haut, comme avant.
 *
 *   - LES NON-VUS : la liste des badges annoncés que personne n'est encore allé
 *     regarder. C'est elle qui allume la pastille sur l'avatar, et l'onglet
 *     Badges la vide en s'ouvrant.
 *
 * ── POURQUOI UNE LISTE D'IDS ET PAS UN COMPTEUR ──────────────────────────────
 * Un entier qu'on incrémente dérive : deux onglets ouverts l'incrémentent deux
 * fois pour le même badge, et rien ne permet de le rattraper. Une liste d'ids
 * est idempotente — annoncer deux fois le même badge ne change rien — et elle
 * dit AUSSI lesquels surligner quand l'onglet s'ouvre, ce qu'un compteur ne
 * saurait pas faire.
 */

import { useEffect, useState, useSyncExternalStore } from "react";

/* ── Le quai ──────────────────────────────────────────────────────────────── */

let dock: HTMLElement | null = null;
const dockListeners = new Set<() => void>();

export function setDock(el: HTMLElement | null): void {
  if (dock === el) return;
  dock = el;
  dockListeners.forEach((l) => l());
}

/** La position du quai À L'INSTANT où on la demande, ou `null`.
 *
 *  Mesurée au vol plutôt que mémorisée : la navbar se rétracte au défilement,
 *  et un rectangle gardé de côté enverrait le jeton là où l'avatar était il y a
 *  trois secondes. `null` aussi quand l'élément est hors de l'écran (navbar
 *  cachée) — on ne vise pas une cible qu'on ne voit pas. */
export function dockRect(): DOMRect | null {
  if (!dock || !dock.isConnected) return null;
  const r = dock.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  if (r.bottom < 0 || r.top > window.innerHeight) return null;
  return r;
}

export function useDockPresent(): boolean {
  return useSyncExternalStore(
    (cb) => {
      dockListeners.add(cb);
      return () => dockListeners.delete(cb);
    },
    () => dock != null,
    () => false,
  );
}

/* ── Les non-vus ──────────────────────────────────────────────────────────── */

const CLE = "aniscroll:badges:unseen";
const EVT = "aniscroll:badges:unseen:change";

function lire(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const v = JSON.parse(window.localStorage.getItem(CLE) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function ecrire(ids: string[]): void {
  try {
    /* Borné à 50 : au-delà, la pastille dit « 50+ » et la liste ne sert plus
       qu'à surligner — garder mille ids ne rendrait service à personne. */
    window.localStorage.setItem(CLE, JSON.stringify(ids.slice(-50)));
  } catch {
    /* au mieux */
  }
  window.dispatchEvent(new CustomEvent(EVT));
}

/** Appelé quand un badge a fini d'être annoncé : il attend maintenant qu'on
 *  aille le voir. */
export function markUnseen(id: string): void {
  if (typeof window === "undefined") return;
  const ids = lire();
  if (ids.includes(id)) return;
  ecrire(ids.concat(id));
}

/** Les ids en attente, rendus une fois — l'onglet s'en sert pour surligner. */
export function unseenIds(): string[] {
  return lire();
}

/** L'onglet Badges s'ouvre : tout est vu. */
export function clearUnseen(): void {
  if (typeof window === "undefined") return;
  if (!lire().length) return;
  ecrire([]);
}

export function useUnseenCount(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const read = () => setN(lire().length);
    read();
    window.addEventListener(EVT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(EVT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return n;
}
