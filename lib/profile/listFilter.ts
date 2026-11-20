/**
 * Tri et filtres de l'onglet Liste du profil (panneau « Sort & Filter »).
 *
 * Calqué sur la version de référence (s00295653.github.io/AniScroll) à la
 * demande de Luc, le 08/11/2026. Pur : aucun React, aucun réseau, pour que la
 * liste et le compteur du bouton « Show N results » lisent la même sélection.
 */

import type { ProfileEntry } from "./types";

/* « status » = par liste, dans l'ordre du menu Statut (En cours, Revisionnage,
   Terminé…), avec un intertitre par statut ; le défaut depuis le 16/11 (Luc).
   Dans un statut, le dernier mis à jour d'abord (le sens inverse ce dernier). */
export type SortKey = "status" | "updated" | "favourites" | "title" | "score" | "rating" | "episodes" | "year";
export const SORT_KEYS: SortKey[] = ["status", "updated", "favourites", "title", "score", "rating", "episodes", "year"];

export const AIR_STATUSES = ["RELEASING", "NOT_YET_RELEASED", "FINISHED", "CANCELLED", "HIATUS"];
export const FORMATS = ["TV", "MOVIE", "OVA", "ONA", "TV_SHORT", "SPECIAL", "MUSIC"];
export const SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"];
export const SOURCES = [
  "ORIGINAL", "MANGA", "LIGHT_NOVEL", "VISUAL_NOVEL", "WEB_NOVEL", "NOVEL",
  "VIDEO_GAME", "GAME", "COMIC", "PICTURE_BOOK", "MULTIMEDIA_PROJECT", "OTHER",
];
export const COUNTRIES = ["JP", "CN", "KR", "TW"];

export type SetKey = "air" | "format" | "season" | "source" | "country" | "genres" | "studio" | "tags";
export type RangeKey = "year" | "score" | "episodes";

export type ListFilters = {
  sort: SortKey;
  desc: boolean;
  sets: Record<SetKey, string[]>;
  ranges: Record<RangeKey, [number, number]>;
  adult: "" | "no" | "yes";
};

export type Bounds = Record<RangeKey, [number, number]>;

const THIS_YEAR = new Date().getFullYear();

/** Les bornes des curseurs. Épisodes : jusqu'au plus long titre de la liste. */
export function boundsOf(entries: ProfileEntry[]): Bounds {
  let ep = 1;
  for (const e of entries) if (e.total && e.total > ep) ep = e.total;
  return { year: [1940, THIS_YEAR + 1], score: [0, 10], episodes: [1, ep] };
}

export function freshFilters(b: Bounds): ListFilters {
  return {
    sort: "status",
    desc: true,
    sets: { air: [], format: [], season: [], source: [], country: [], genres: [], studio: [], tags: [] },
    ranges: { year: [...b.year], score: [...b.score], episodes: [...b.episodes] },
    adult: "",
  };
}

export const rangeIsFull = (f: ListFilters, b: Bounds, k: RangeKey) =>
  f.ranges[k][0] <= b[k][0] && f.ranges[k][1] >= b[k][1];

export function activeCount(f: ListFilters, b: Bounds): number {
  let n = 0;
  for (const k of Object.keys(f.sets) as SetKey[]) n += f.sets[k].length;
  for (const k of ["year", "score", "episodes"] as RangeKey[]) if (!rangeIsFull(f, b, k)) n++;
  return n + (f.adult ? 1 : 0);
}

/** Valeur(s) d'une entrée pour une section à puces. */
function valuesOf(e: ProfileEntry, k: SetKey): string[] {
  switch (k) {
    case "air": return e.airStatus ? [e.airStatus] : [];
    case "format": return e.format ? [e.format] : [];
    case "season": return e.season ? [e.season] : [];
    case "source": return e.source ? [e.source] : [];
    case "country": return e.country ? [e.country] : [];
    case "genres": return e.genres ?? [];
    /* Tous les studios et tous les tags du titre quand on les a (profil
       AniList), comme AniList les compte ; sinon le principal / les tags
       pertinents (liste locale, ancienne réponse). */
    case "studio": return e.studios?.length ? e.studios : e.studio ? [e.studio] : [];
    case "tags": return e.allTags?.length ? e.allTags : e.tags ?? [];
  }
}

/** Les valeurs présentes dans la liste, triées — Genres, Studio et Tags. */
/** Combien de titres portent chaque valeur (un titre compte une fois par valeur). */
export function valueCounts(entries: ProfileEntry[], k: SetKey): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entries) for (const v of new Set(valuesOf(e, k))) m.set(v, (m.get(v) || 0) + 1);
  return m;
}

/* Une borne resserrée écarte les titres dont la valeur est INCONNUE (une liste
   locale n'a pas d'année) : on ne peut pas dire qu'ils sont dedans. Laissée
   pleine, elle les garde tous. */
function inRange(v: number | null | undefined, f: ListFilters, b: Bounds, k: RangeKey) {
  if (rangeIsFull(f, b, k)) return true;
  if (v == null) return false;
  return v >= f.ranges[k][0] && v <= f.ranges[k][1];
}

export function applyFilters(entries: ProfileEntry[], f: ListFilters, b: Bounds): ProfileEntry[] {
  const sets = (Object.keys(f.sets) as SetKey[]).filter((k) => f.sets[k].length);
  return entries.filter((e) => {
    for (const k of sets) {
      const vals = valuesOf(e, k);
      if (!vals.some((v) => f.sets[k].includes(v))) return false;
    }
    if (f.adult === "no" && e.isAdult) return false;
    if (f.adult === "yes" && !e.isAdult) return false;
    return (
      inRange(e.year, f, b, "year") &&
      inRange(e.score ?? 0, f, b, "score") &&
      inRange(e.total, f, b, "episodes")
    );
  });
}

export function sortEntries(
  entries: ProfileEntry[],
  f: ListFilters,
  titleOf: (e: ProfileEntry) => string,
  /** Tri « status » : l'ordre des statuts (celui du menu Statut). */
  statusOrder: string[] = [],
): ProfileEntry[] {
  const dir = f.desc ? -1 : 1;
  if (f.sort === "status") {
    const rank = (e: ProfileEntry) => {
      const i = statusOrder.indexOf(e.status || "PLANNING");
      return i < 0 ? statusOrder.length : i;
    };
    return entries
      .slice()
      // Dans un statut, comme AniList : meilleure note d'abord (sans note = en
      // dernier), puis titre alphabétique.
      .sort((a, b) =>
        rank(a) - rank(b) ||
        (b.score ?? 0) - (a.score ?? 0) ||
        titleOf(a).localeCompare(titleOf(b)));
  }
  const num = (e: ProfileEntry): number | null => {
    switch (f.sort) {
      case "updated": return e.updatedAt ?? null;
      case "favourites": return (e.favourite ? 1e15 : 0) + (e.updatedAt ?? 0);
      case "score": return e.score ?? null;
      case "rating": return e.rating ?? null;
      case "episodes": return e.total ?? null;
      case "year": return e.year ?? null;
      default: return null;
    }
  };
  const out = entries.slice();
  if (f.sort === "title") {
    out.sort((a, b) => dir * titleOf(a).localeCompare(titleOf(b)));
  } else {
    // Les valeurs inconnues vont toujours à la fin, dans un sens comme dans l'autre.
    out.sort((a, b) => {
      const x = num(a), y = num(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return dir * (x - y);
    });
  }
  return out;
}
