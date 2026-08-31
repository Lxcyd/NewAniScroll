/**
 * Ce que la liste d'un profil sait dire d'elle-même.
 *
 * Fonctions pures, une par bloc : elles prennent des ProfileEntry[] et rendent
 * de quoi peindre, sans jamais inventer. Quand la source ne porte pas
 * l'information (une liste locale ignore les genres, les formats et les
 * studios), la fonction rend une liste VIDE et le bloc affiche son état vide —
 * c'est la règle du 31/08/2026 : pas de chiffre faux sur un profil.
 *
 * Isomorphe, comme sources.ts : la page appelle depuis getServerSideProps, la
 * version locale depuis le navigateur.
 */

import type { ProfileEntry } from "./types";

/** Les statuts d'AniList, dans l'ordre où un profil se lit. */
export const STATUS_ORDER = [
  "CURRENT",
  "REPEATING",
  "COMPLETED",
  "PLANNING",
  "PAUSED",
  "DROPPED",
] as const;

export type StatusKey = (typeof STATUS_ORDER)[number];

export const STATUS_COLOR: Record<StatusKey, string> = {
  CURRENT: "#22c55e",
  REPEATING: "#06b6d4",
  COMPLETED: "#3b82f6",
  PLANNING: "#a855f7",
  PAUSED: "#f97316",
  DROPPED: "#ef4444",
};

export type Tally = { key: string; label: string; count: number };

export function statusCounts(entries: ProfileEntry[]): Tally[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const k = (e.status || "PLANNING").toUpperCase();
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return STATUS_ORDER.filter((k) => counts.get(k))
    .map((k) => ({ key: k, label: k, count: counts.get(k) as number }));
}

/** Répartition des notes /10, index 0 = note 1. Vide si personne n'a noté. */
export function scoreHistogram(entries: ProfileEntry[]): number[] {
  const bins = new Array(10).fill(0);
  let any = false;
  for (const e of entries) {
    const s = e.score;
    if (!s || s <= 0) continue;
    const bin = Math.min(9, Math.max(0, Math.ceil(s) - 1));
    bins[bin] += 1;
    any = true;
  }
  return any ? bins : [];
}

export function formatCounts(entries: ProfileEntry[]): Tally[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (!e.format) continue;
    counts.set(e.format, (counts.get(e.format) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: key, count }))
    .sort((a, b) => b.count - a.count);
}

/** Décennies de sortie, de la plus ancienne à la plus récente. */
export function decadeCounts(entries: ProfileEntry[]): Tally[] {
  const counts = new Map<number, number>();
  for (const e of entries) {
    if (!e.year || e.year < 1900) continue;
    const d = Math.floor(e.year / 10) * 10;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([d, count]) => ({ key: String(d), label: `${String(d).slice(2)}s`, count }));
}

/**
 * Les genres les plus présents. `max` bornes le radar : au-delà de huit
 * branches la figure devient illisible et ne dit plus rien de plus.
 */
export function genreCounts(entries: ProfileEntry[], max = 8): Tally[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    for (const g of e.genres || []) {
      if (!g) continue;
      counts.set(g, (counts.get(g) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, max);
}

export type StudioRank = {
  name: string;
  count: number;
  /** Moyenne des notes DU SPECTATEUR sur ce studio, /10, ou null. */
  score: number | null;
};

/**
 * Les studios classés par note moyenne du spectateur.
 *
 * `minTitles` existe parce qu'une moyenne sur un seul titre n'est pas une
 * moyenne : sans ce seuil, le studio d'un unique 10/10 coiffe celui de quinze
 * titres à 8,5 — un classement qui ne dit rien de ce que le spectateur aime.
 */
export function studioRanks(entries: ProfileEntry[], minTitles = 2): StudioRank[] {
  const acc = new Map<string, { count: number; sum: number; rated: number }>();
  for (const e of entries) {
    if (!e.studio) continue;
    const cur = acc.get(e.studio) || { count: 0, sum: 0, rated: 0 };
    cur.count += 1;
    if (e.score && e.score > 0) {
      cur.sum += e.score;
      cur.rated += 1;
    }
    acc.set(e.studio, cur);
  }
  return [...acc.entries()]
    .filter(([, v]) => v.count >= minTitles)
    .map(([name, v]) => ({
      name,
      count: v.count,
      score: v.rated ? Math.round((v.sum / v.rated) * 10) / 10 : null,
    }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.count - a.count);
}

/** Les titres en cours, les plus avancés d'abord. */
export function currentlyWatching(entries: ProfileEntry[], max = 6): ProfileEntry[] {
  return entries
    .filter((e) => {
      const s = (e.status || "").toUpperCase();
      return s === "CURRENT" || s === "REPEATING";
    })
    .sort((a, b) => (b.progress || 0) - (a.progress || 0))
    .slice(0, max);
}

/** Le vivier de la roulette : ce qui est prévu, et jamais commencé. */
export function plannedPool(entries: ProfileEntry[]): ProfileEntry[] {
  return entries.filter((e) => (e.status || "").toUpperCase() === "PLANNING");
}

/**
 * La vitrine des favoris : les favoris AniList d'abord, complétés par les mieux
 * notés. Un profil sans favori déclaré n'affiche donc pas un bloc vide, il
 * affiche ce que le spectateur a le mieux noté — ce qui est le même propos.
 */
export function favoriteShowcase(entries: ProfileEntry[], max = 8): ProfileEntry[] {
  const rated = (e: ProfileEntry) => e.score || 0;
  const fav = entries.filter((e) => e.favourite).sort((a, b) => rated(b) - rated(a));
  if (fav.length >= max) return fav.slice(0, max);
  const rest = entries
    .filter((e) => !e.favourite && rated(e) > 0)
    .sort((a, b) => rated(b) - rated(a));
  return fav.concat(rest).slice(0, max);
}

/** Le titre d'une entrée, dans l'ordre de préférence habituel. */
export function entryTitle(e: ProfileEntry | null | undefined): string {
  if (!e) return "";
  return (
    e.title?.english ||
    e.title?.romaji ||
    e.title?.userPreferred ||
    e.title?.native ||
    `#${e.mediaId}`
  );
}
