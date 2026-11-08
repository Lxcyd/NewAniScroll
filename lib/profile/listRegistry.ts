/**
 * LE REGISTRE DES LISTES — ce que règle le gestionnaire « + » de l'onglet Liste.
 *
 * Comme la version de référence (s00295653.github.io/AniScroll, 08/11/2026,
 * Luc : « comme sur la référence ») : elle LIT les listes perso d'AniList mais
 * n'écrit rien chez AniList ; ce qu'on crée dans son gestionnaire reste de son
 * côté. Ici, une clé localStorage, sur cet appareil :
 *   - l'ordre et la couleur des six statuts ;
 *   - les listes perso créées dans AniScroll, avec leur couleur et leurs titres
 *     (par mediaId) ;
 *   - une couleur choisie pour une liste perso AniList, dont on ne touche pas
 *     au contenu.
 *
 * Une clé, un événement pour le même onglet, un hook : le patron de
 * lib/prefs/titlePref.ts.
 */

import { useEffect, useState } from "react";

export const STATUS_KEYS = ["CURRENT", "REPEATING", "COMPLETED", "PLANNING", "PAUSED", "DROPPED"];

export type LocalCustomList = { name: string; color: string; ids: number[] };

export type ListRegistry = {
  statusOrder: string[];
  statusColors: Record<string, string>;
  /** Listes créées dans AniScroll, dans l'ordre du gestionnaire. */
  lists: LocalCustomList[];
  /** Couleurs choisies pour des listes perso venues d'AniList. */
  anilistColors: Record<string, string>;
  /** L'ordre de TOUTES les listes perso (AniScroll et AniList mêlées), par nom,
   *  tel que réglé dans le gestionnaire. Un nom absent se range après. */
  customOrder: string[];
};

const KEY = "aniscroll:listRegistry";
const EVT = "aniscroll:listRegistry";

export const EMPTY_REGISTRY: ListRegistry = {
  statusOrder: STATUS_KEYS,
  statusColors: {},
  lists: [],
  anilistColors: {},
  customOrder: [],
};

/** La palette du sélecteur de couleur (celle de la référence, aux tons du site). */
export const LIST_PALETTE = [
  "#22c55e", "#06b6d4", "#3b82f6", "#a855f7", "#f97316", "#ef4444", "#E94560", "#FF7F57",
  "#facc15", "#84cc16", "#14b8a6", "#38bdf8", "#6366f1", "#ec4899", "#a3a3a3", "#78716c",
];

function clean(raw: any): ListRegistry {
  const order = Array.isArray(raw?.statusOrder) ? raw.statusOrder.filter((s: any) => STATUS_KEYS.includes(s)) : [];
  // Un statut oublié (registre ancien, saisie abîmée) reprend sa place à la fin.
  for (const s of STATUS_KEYS) if (!order.includes(s)) order.push(s);
  const lists: LocalCustomList[] = Array.isArray(raw?.lists)
    ? raw.lists
        .filter((l: any) => l && typeof l.name === "string" && l.name.trim())
        .map((l: any) => ({
          name: String(l.name).trim().slice(0, 40),
          color: typeof l.color === "string" ? l.color : LIST_PALETTE[0],
          ids: Array.isArray(l.ids) ? l.ids.filter((x: any) => typeof x === "number") : [],
        }))
    : [];
  const obj = (o: any) => (o && typeof o === "object" ? o : {});
  const customOrder = Array.isArray(raw?.customOrder)
    ? raw.customOrder.filter((n: any) => typeof n === "string")
    : [];
  return { statusOrder: order, statusColors: obj(raw?.statusColors), lists, anilistColors: obj(raw?.anilistColors), customOrder };
}

/** Range des listes perso selon `customOrder` ; les inconnues gardent leur
 *  ordre d'arrivée, après. */
export function orderCustom<T>(items: T[], nameOf: (x: T) => string, order: string[]): T[] {
  const rank = (x: T) => {
    const i = order.indexOf(nameOf(x));
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return items
    .map((x, i) => ({ x, i }))
    .sort((a, b) => rank(a.x) - rank(b.x) || a.i - b.i)
    .map((o) => o.x);
}

export function getListRegistry(): ListRegistry {
  if (typeof window === "undefined") return EMPTY_REGISTRY;
  try {
    return clean(JSON.parse(window.localStorage.getItem(KEY) || "null"));
  } catch {
    return EMPTY_REGISTRY;
  }
}

export function setListRegistry(next: ListRegistry): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  window.dispatchEvent(new CustomEvent(EVT));
}

export function updateListRegistry(fn: (r: ListRegistry) => ListRegistry): void {
  setListRegistry(clean(fn(getListRegistry())));
}

/** Ajoute ou retire un titre d'une liste créée dans AniScroll. */
export function toggleInLocalList(name: string, mediaId: number): void {
  updateListRegistry((r) => ({
    ...r,
    lists: r.lists.map((l) =>
      l.name !== name
        ? l
        : { ...l, ids: l.ids.includes(mediaId) ? l.ids.filter((x) => x !== mediaId) : l.ids.concat(mediaId) },
    ),
  }));
}

/** Le registre en direct. Vide au premier rendu (serveur et client d'accord),
 *  rempli après le montage. */
export function useListRegistry(): ListRegistry {
  const [reg, setReg] = useState<ListRegistry>(EMPTY_REGISTRY);
  useEffect(() => {
    const read = () => setReg(getListRegistry());
    read();
    const onStorage = (e: StorageEvent) => e.key === KEY && read();
    window.addEventListener(EVT, read);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVT, read);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return reg;
}
