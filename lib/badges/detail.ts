/**
 * Le DÉTAIL d'un badge : ce qui le remplit, case par case.
 *
 * `measure` ne rend qu'un couple (22, 57) — assez pour une barre, pas pour
 * savoir QUOI regarder ensuite. « Toutes les années » à 22 / 57 pose
 * immédiatement la question « lesquelles me manquent ? », et « A à Z » la même
 * avec des lettres. Ce module répond, avec les mêmes données et les mêmes
 * règles que le compte (lib/badges/derive.ts) : une case remplie ici est une
 * case comptée là-bas, jamais une interprétation voisine.
 *
 * Deux formes :
 *   - `grid` : un ensemble FIXE à couvrir (années, lettres, genres, tags,
 *     lecteurs) — chaque case, remplie ou non, avec les anime qui la
 *     remplissent. Les studios passent aussi par là, sans cases vides : il n'y a
 *     pas de liste des studios à couvrir, seulement un classement.
 *   - `list` : les anime qui comptent pour un seuil (30 d'action, 30 films…).
 *
 * Calculé à l'OUVERTURE du détail, pour un badge : pas 176 fois par rendu.
 */

import type { BadgeDef } from "./catalog";
import { fuzzyDay, titleOf, type Derived } from "./derive";
import type { LocalEntry } from "../list/localList";

export type DetailCell = {
  key: string;
  label: string;
  /** Les anime terminés qui remplissent la case. Vide pour les lecteurs. */
  items: LocalEntry[];
  done: boolean;
};

export type Detail =
  | {
      kind: "grid";
      cells: DetailCell[];
      /** Les libellés sont des genres AniList, à traduire à l'affichage. */
      labels?: "genre";
      /** Les cases portent des anime qu'on peut ouvrir (pas les lecteurs). */
      browsable: boolean;
    }
  | { kind: "list"; items: LocalEntry[] };

const GRID = new Set(["years", "alphabet", "allGenres", "allTags", "hosts", "studio"]);
const LIST = new Set([
  "genre", "tag", "format", "yearBefore", "popularityUnder", "studioNamed",
  "titleLength", "sameDayFinish", "onlyLastEpisode", "planningUnaired", "repeatSame", "listSize",
]);
/** Les compteurs `count` qui se ramènent à des anime de la liste. Les épisodes,
 *  les minutes ou la série de jours n'en sont pas : pas de liste à montrer. */
const COUNT_OF = new Set(["completed", "rated", "rewatched"]);

/**
 * La forme du détail d'un badge, SANS le calculer — de quoi décider d'afficher
 * le bouton (et son icône) sur chaque ligne. `null` : pas de détail, ou pas
 * encore les données (le vocabulaire des genres et des tags est récupéré à
 * part, cf. metaBackfill.ts).
 */
export function detailKind(def: BadgeDef, d: Derived): "grid" | "list" | null {
  const k = def.metric.k;
  if ((k === "allGenres" || k === "allTags") && !d.vocab) return null;
  if (k === "count") return COUNT_OF.has(String(def.metric.of)) ? "list" : null;
  return GRID.has(k) ? "grid" : LIST.has(k) ? "list" : null;
}

const byTitle = (a: LocalEntry, b: LocalEntry) => titleOf(a).localeCompare(titleOf(b));

/** Une case par clé, remplie par les anime que `match` y range. */
function cellsOf(
  keys: string[],
  completed: LocalEntry[],
  match: (e: LocalEntry, key: string) => boolean,
  label: (key: string) => string = (k) => k,
): DetailCell[] {
  return keys.map((key) => {
    const items = completed.filter((e) => match(e, key)).sort(byTitle);
    return { key, label: label(key), items, done: items.length > 0 };
  });
}

export function detailOf(def: BadgeDef, d: Derived): Detail | null {
  const m = def.metric;
  const done = d.completed;

  switch (m.k) {
    /* ── Ensembles à couvrir ──────────────────────────────────────────────── */
    case "years": {
      // Mêmes bornes que `measure` : de `from` à l'année EN COURS incluse.
      const from = Number(m.from);
      const to = new Date(d.now).getFullYear();
      const years: string[] = [];
      for (let y = from; y <= to; y++) years.push(String(y));
      return {
        kind: "grid",
        browsable: true,
        cells: cellsOf(years, done, (e, y) => e.year === Number(y)),
      };
    }
    case "alphabet": {
      const letters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
      return {
        kind: "grid",
        browsable: true,
        // L'initiale est lue comme le compte la lit (`titleOf`, première lettre).
        cells: cellsOf(letters, done, (e, l) => titleOf(e).trim().charAt(0).toUpperCase() === l),
      };
    }
    case "allGenres":
      if (!d.vocab) return null;
      return {
        kind: "grid",
        browsable: true,
        labels: "genre",
        cells: cellsOf(d.vocab.genres, done, (e, g) => !!e.genres?.includes(g)),
      };
    case "allTags":
      if (!d.vocab) return null;
      return {
        kind: "grid",
        browsable: true,
        cells: cellsOf(d.vocab.tags, done, (e, g) => !!e.tags?.includes(g)),
      };
    case "hosts": {
      const used = new Set(d.facts.hosts);
      return {
        kind: "grid",
        browsable: false,
        cells: d.displayedHosts.map((h) => ({ key: h, label: h, items: [], done: used.has(h) })),
      };
    }
    /* Le classement des studios : le premier est celui que le badge mesure. */
    case "studio": {
      const names = [...new Set(done.map((e) => e.studio).filter((s): s is string => !!s))];
      const cells = cellsOf(names, done, (e, s) => e.studio === s);
      cells.sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
      return { kind: "grid", browsable: true, cells };
    }

    /* ── Les anime qui comptent pour un seuil ─────────────────────────────── */
    case "genre":
      return { kind: "list", items: done.filter((e) => e.genres?.includes(String(m.name))).sort(byTitle) };
    case "tag":
      return { kind: "list", items: done.filter((e) => e.tags?.includes(String(m.name))).sort(byTitle) };
    case "format":
      return { kind: "list", items: done.filter((e) => e.format === String(m.name)).sort(byTitle) };
    case "yearBefore":
      return {
        kind: "list",
        items: done.filter((e) => (e.year ?? Infinity) < Number(m.year)).sort(byTitle),
      };
    case "popularityUnder":
      return {
        kind: "list",
        items: done.filter((e) => (e.popularity ?? Infinity) < Number(m.max)).sort(byTitle),
      };
    case "studioNamed":
      return { kind: "list", items: done.filter((e) => e.studio === String(m.name)).sort(byTitle) };

    /* ── Les faits tirés de la liste : l'anime qui a fait tomber le badge ──── */
    case "titleLength":
      return {
        kind: "list",
        items: done.filter((e) => titleOf(e).length > Number(m.min)).sort(byTitle),
      };
    case "sameDayFinish":
      return {
        kind: "list",
        items: done
          .filter((e) => {
            const a = fuzzyDay(e.startedAt);
            return !!a && a === fuzzyDay(e.completedAt) && (e.total ?? 0) > 1;
          })
          .sort(byTitle),
      };
    case "onlyLastEpisode":
      return {
        kind: "list",
        items: d.entries
          .filter((e) => {
            const eps = d.perAnime.get(e.mediaId);
            return !!eps && eps.size === 1 && !!e.total && e.total >= 2 && eps.has(String(e.total));
          })
          .sort(byTitle),
      };
    case "planningUnaired":
      return {
        kind: "list",
        items: d.entries.filter((e) => e.mediaStatus === "NOT_YET_RELEASED").sort(byTitle),
      };
    /* Les plus revus d'abord : c'est le premier qui porte « trois fois ». */
    case "repeatSame":
      return {
        kind: "list",
        items: d.entries
          .filter((e) => (e.repeat ?? 0) >= 1)
          .sort((a, b) => (b.repeat ?? 0) - (a.repeat ?? 0) || byTitle(a, b)),
      };
    case "listSize":
      return { kind: "list", items: [...d.entries].sort(byTitle) };
    case "count":
      switch (String(m.of)) {
        case "completed": return { kind: "list", items: [...done].sort(byTitle) };
        case "rated":
          return { kind: "list", items: d.entries.filter((e) => (e.score ?? 0) > 0).sort(byTitle) };
        case "rewatched":
          return { kind: "list", items: d.entries.filter((e) => (e.repeat ?? 0) >= 1).sort(byTitle) };
        default: return null;
      }
    default:
      return null;
  }
}
