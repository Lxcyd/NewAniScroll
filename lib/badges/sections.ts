/**
 * Les sections de l'onglet Badges.
 *
 * Elles ne suivent plus les familles du catalogue : une échelle se replie sur
 * UNE ligne, si bien que Temps cumulé, Anime terminés et Régularité n'affichaient
 * qu'un badge, Sessions et Franchises deux (21/11/2026, Luc). C'est un simple
 * rangement d'affichage : `family` et les ids du catalogue ne changent pas.
 */

import type { BadgeDef } from "./catalog";

export const SECTION_ORDER = [
  "progress", "marathons", "moments", "discovery",
  "fidelity", "player", "genres", "profile",
] as const;
export type Section = (typeof SECTION_ORDER)[number];

const IDS: Record<Exclude<Section, "progress" | "genres">, string[]> = {
  marathons: ["no-pause", "burst-20", "burst-50", "night-12", "session-6h", "session-12h", "one-sitting", "comeback"],
  moments: ["late-night", "midnight", "lunch", "airday-50", "day-one", "halloween", "valentine", "april-fool"],
  discovery: ["first-add", "curious-10", "hidden-gem", "archive-1990", "pioneer-1975", "decades", "big-three", "planning", "blind-pick", "studio-10", "movies-30", "oav", "alphabet", "long-title"],
  fidelity: ["rewatch-1", "rewatch-10", "thrice", "saga-2", "saga-4"],
  player: ["resume", "spotlight", "w2g", "two-voices", "all-players", "never-op", "by-the-end"],
  profile: ["avatar", "share-link", "settings", "custom-list", "showcase-open", "one-year-here", "legendary-5", "secret-50"],
};

const BY_BADGE = new Map<string, Section>(
  Object.entries(IDS).flatMap(([s, ids]) => ids.map((id) => [id, s as Section] as const)),
);

/** La section d'un badge ; `null` pour un secret, qui a la sienne à part. */
export function sectionOf(b: BadgeDef): Section | null {
  if (b.secret) return null;
  if (b.ladder) return "progress";
  if (b.family === "genres") return "genres";
  return BY_BADGE.get(b.id) ?? "discovery";
}
