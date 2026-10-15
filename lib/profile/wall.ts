/**
 * LE MUR D'ANIMÉS — un fond fait des affiches de sa propre liste.
 *
 * Né de l'agencement 11 « Mur d'affiches » des maquettes (15/10/2026) : au lieu
 * d'une illustration choisie, le profil porte en fond les affiches des animés
 * qu'on a vus, en colonnes qui peuvent défiler. Le réglage dit QUELLES affiches
 * — une ou plusieurs listes, une plage de notes, comme la vitrine des favoris
 * (cf. `showcaseFor`, lib/profile/insights.ts) — et COMMENT elles bougent.
 *
 * Rien n'est stocké des affiches elles-mêmes : seulement le filtre. Le mur se
 * recompose à chaque rendu à partir de la liste que la page a déjà (`entries`),
 * donc il suit la liste sans jamais être resauvegardé, et aucune URL arbitraire
 * n'entre dans l'habillage — il n'y a rien à mettre en liste blanche.
 *
 * Importé par l'API ET par le navigateur : ni base, ni `window`.
 */

import { STATUS_TO_LIST } from "@/components/anime/v2/helpers";
import type { ProfileEntry } from "./types";

/** Le sens du défilement. « alt » : une colonne sur deux monte, l'autre descend. */
export type WallDir = "up" | "down" | "alt";
export const WALL_DIRS: WallDir[] = ["up", "down", "alt"];

export type DressingWall = {
  /**
   * Les listes dont viennent les affiches : `favourites`, une liste de statut
   * au sens de STATUS_TO_LIST (`Completed`…), ou `custom:<nom>`. Vide = toute
   * la liste. Plusieurs = leur UNION — « Terminés + En cours ».
   */
  lists: string[];
  /** La plage de notes retenue, sur 10. */
  scores: [number, number];
  /** Les titres sans note en font partie. */
  unrated: boolean;
  /** Les colonnes défilent. */
  anim: boolean;
  dir: WallDir;
  /** Vitesse du défilement, en px par seconde. */
  speed: number;
};

export const WALL_SPEED_MIN = 4;
export const WALL_SPEED_MAX = 60;
export const WALL_SPEED_DEFAULT = 18;
/** Un garde-fou, pas un plafond d'usage : le mur ne rend que ce qui est à
    l'écran (AnimeWall), toute la sélection y passe. Il borne seulement le tri
    d'une liste démesurée. */
export const WALL_MAX = 5000;
const MAX_LISTS = 16;

export function defaultWall(): DressingWall {
  return {
    lists: [],
    scores: [0, 10],
    unrated: true,
    anim: true,
    dir: "up",
    speed: WALL_SPEED_DEFAULT,
  };
}

export function clampWallSpeed(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return WALL_SPEED_DEFAULT;
  return Math.max(WALL_SPEED_MIN, Math.min(WALL_SPEED_MAX, Math.round(n)));
}

const LIST_VALUES = new Set(["favourites", ...Object.values(STATUS_TO_LIST)]);
const CUSTOM = "custom:";

/** Relit un réglage stocké. Tout ce qui est illisible reprend le défaut. */
export function normalizeWall(raw: unknown): DressingWall {
  const d = defaultWall();
  if (!raw || typeof raw !== "object") return d;
  const o = raw as Record<string, unknown>;
  const lists = Array.isArray(o.lists)
    ? [
        ...new Set(
          o.lists.filter(
            (l): l is string =>
              typeof l === "string" &&
              l.length <= 60 &&
              (LIST_VALUES.has(l) || (l.startsWith(CUSTOM) && l.length > CUSTOM.length)),
          ),
        ),
      ].slice(0, MAX_LISTS)
    : d.lists;
  let scores = d.scores;
  if (Array.isArray(o.scores) && o.scores.length === 2) {
    const lo = Math.round(Number(o.scores[0]) * 2) / 2;
    const hi = Math.round(Number(o.scores[1]) * 2) / 2;
    if (lo >= 0 && hi <= 10 && lo <= hi) scores = [lo, hi];
  }
  return {
    lists,
    scores,
    unrated: typeof o.unrated === "boolean" ? o.unrated : d.unrated,
    anim: typeof o.anim === "boolean" ? o.anim : d.anim,
    dir: WALL_DIRS.includes(o.dir as WallDir) ? (o.dir as WallDir) : d.dir,
    speed: o.speed === undefined ? d.speed : clampWallSpeed(o.speed),
  };
}

/** Une entrée appartient-elle à la liste `list` ? */
export function inList(e: ProfileEntry, list: string): boolean {
  if (list === "favourites") return !!e.favourite;
  if (list.startsWith(CUSTOM)) return !!e.customLists?.includes(list.slice(CUSTOM.length));
  return STATUS_TO_LIST[(e.status || "").toUpperCase()] === list;
}

/** La note retenue ? Une entrée sans note ne passe que si `unrated`. */
export function inScores(e: ProfileEntry, scores: [number, number], unrated: boolean): boolean {
  if (e.score == null || e.score === 0) return unrated;
  return e.score >= scores[0] && e.score <= scores[1];
}

/** Un mélange STABLE : le même mur à chaque visite, sans voisins de même liste. */
function melange(id: number): number {
  let h = id | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Les affiches du mur, dans l'ordre où elles se posent.
 *
 * Mélangées et non classées par note : un mur rangé du meilleur au moins bon
 * met toutes les affiches d'une même série côte à côte en haut, et le reste ne
 * se lit plus que comme du remplissage.
 */
export function wallEntries(entries: ProfileEntry[], wall: DressingWall): ProfileEntry[] {
  return entries
    .filter(
      (e) =>
        !!e.cover &&
        (wall.lists.length === 0 || wall.lists.some((l) => inList(e, l))) &&
        inScores(e, wall.scores, wall.unrated),
    )
    .sort((a, b) => melange(a.mediaId) - melange(b.mediaId))
    .slice(0, WALL_MAX);
}

export function wallCovers(entries: ProfileEntry[], wall: DressingWall): string[] {
  return wallEntries(entries, wall).map((e) => e.cover!);
}
