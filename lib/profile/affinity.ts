/**
 * L'AFFINITÉ DE GOÛTS (03/11/2026, Luc), sans système d'amis.
 *
 * Il n'y a pas d'amis sur AniScroll. Le bloc compare donc avec ce qu'on a sous
 * la main : les PROFILS QU'ON A VISITÉS. Chaque visite range, sur cet appareil
 * seulement, la liste notée du profil (identifiant → note) ; ouvrir son propre
 * profil range la sienne. Rien ne part sur le serveur, et un profil privé ne
 * passe jamais par ici (sa liste n'arrive pas dans la page).
 *
 * Le calcul : sur les titres vus des deux côtés (hors « à voir »), la
 * CORRÉLATION des notes quand au moins cinq sont notés des deux côtés — deux
 * personnes qui notent haut et bas les mêmes titres s'accordent, même si l'une
 * note plus sévèrement. En dessous, faute de notes, la part de titres en
 * commun (indice de Jaccard), qui dit au moins qu'on regarde les mêmes choses.
 */

import type { ProfileEntry } from "./types";

const KEY = "aniscroll:affinity";
const MAX_PROFILES = 20;
const MAX_TITLES = 1500;

export type Taste = Record<string, number>;
export type Visited = { name: string; avatar: string | null; href: string; at: number; taste: Taste };
type Store = { me?: Taste; others: Visited[] };

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
    return { me: p?.me ?? undefined, others: Array.isArray(p?.others) ? p.others : [] };
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
  write(s);
}

export function rememberProfile(who: { name: string; avatar: string | null; href: string }, entries: ProfileEntry[]) {
  if (!entries.length || !who.name) return;
  const s = read();
  const others = s.others.filter((o) => o.href !== who.href);
  others.unshift({ ...who, at: Date.now(), taste: tasteOf(entries) });
  s.others = others.slice(0, MAX_PROFILES);
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
