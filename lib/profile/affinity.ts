/**
 * L'AFFINITÉ DE GOÛTS (03/11/2026, Luc).
 *
 * Chez soi, le bloc compare sa liste à celle de ses AMIS D'ANISCROLL : chacun
 * range ses goûts sur son compte en ouvrant son profil (lib/auth/friends.ts,
 * `sendMyTaste`). Chez un autre, il compare le visiteur au profil visité, avec
 * la liste du visiteur rangée sur CET appareil (`rememberMe`).
 *
 * Le calcul : sur les titres vus des deux côtés (hors « à voir »), la
 * CORRÉLATION des notes quand au moins cinq sont notés des deux côtés — deux
 * personnes qui notent haut et bas les mêmes titres s'accordent, même si l'une
 * note plus sévèrement. En dessous, faute de notes, la part de titres en
 * commun (indice de Jaccard), qui dit au moins qu'on regarde les mêmes choses.
 */

import type { ProfileEntry } from "./types";

const KEY = "aniscroll:affinity";
const MAX_TITLES = 1500;

export type Taste = Record<string, number>;
/* `others` : les profils visités, rangés jusqu'au 03/11/2026 ; ce sont
   désormais les amis du site qui servent de comparaison (lib/auth/friends.ts). */
type Store = { me?: Taste; meFav?: string[]; others: unknown[] };

/** Les favoris d'une liste, en ids (04/11/2026). */
export function favsOf(entries: ProfileEntry[]): string[] {
  return entries.filter((e) => e.favourite).map((e) => String(e.mediaId)).slice(0, 200);
}

/** Ce qu'une liste dit des goûts : chaque titre vu, avec sa note (0 = non noté). */
export function tasteOf(entries: ProfileEntry[]): Taste {
  const out: Taste = {};
  let n = 0;
  for (const e of entries) {
    if (e.status === "PLANNING") continue;
    out[e.mediaId] = e.score && e.score > 0 ? e.score : 0;
    if (++n >= MAX_TITLES) break;
  }
  return out;
}

function read(): Store {
  if (typeof window === "undefined") return { others: [] };
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || "null");
    return { me: p?.me ?? undefined, meFav: Array.isArray(p?.meFav) ? p.meFav : undefined, others: Array.isArray(p?.others) ? p.others : [] };
  } catch {
    return { others: [] };
  }
}

function write(s: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* Stockage plein ou bloqué : l'affinité n'est qu'un bonus. */
  }
}

export function rememberMe(entries: ProfileEntry[]) {
  if (!entries.length) return;
  const s = read();
  s.me = tasteOf(entries);
  s.meFav = favsOf(entries);
  write(s);
}

export function readAffinity(): Store {
  return read();
}

export type Match = { pct: number; shared: number; rated: number };

export function affinity(a: Taste, b: Taste): Match {
  const ka = Object.keys(a);
  const kb = new Set(Object.keys(b));
  const shared = ka.filter((k) => kb.has(k));
  const both = shared.filter((k) => a[k] > 0 && b[k] > 0);
  if (both.length >= 5) {
    const xs = both.map((k) => a[k]);
    const ys = both.map((k) => b[k]);
    const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
    const my = ys.reduce((s, y) => s + y, 0) / ys.length;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      dx += (xs[i] - mx) ** 2;
      dy += (ys[i] - my) ** 2;
    }
    /* Deux listes notées uniformément (tout à 8) n'ont pas de variance : on
       retombe sur l'écart moyen des notes. */
    const r =
      dx && dy
        ? num / Math.sqrt(dx * dy)
        : 1 - (2 * xs.reduce((s, x, i) => s + Math.abs(x - ys[i]), 0)) / (xs.length * 10);
    return { pct: Math.round(((Math.max(-1, Math.min(1, r)) + 1) / 2) * 100), shared: shared.length, rated: both.length };
  }
  const union = new Set([...ka, ...Array.from(kb)]).size;
  const j = union ? shared.length / union : 0;
  /* La racine relève les petites intersections : 10 % de titres en commun,
     c'est déjà beaucoup entre deux listes de plusieurs centaines. */
  return { pct: Math.round(Math.sqrt(j) * 100), shared: shared.length, rated: both.length };
}
