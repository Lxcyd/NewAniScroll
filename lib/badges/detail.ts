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
import { fuzzyDay, initialsOf, titleOf, type Derived } from "./derive";
import { WORKS } from "./works";
import type { LocalEntry } from "../list/localList";

export type DetailCell = {
  key: string;
  label: string;
  /** Les anime terminés qui remplissent la case. Vide pour les lecteurs. */
  items: LocalEntry[];
  done: boolean;
  /** Un chiffre à côté du libellé, quand la case en porte un qui n'est pas un
   *  nombre d'anime (les points d'une saison de bingo). */
  value?: number;
};

export type Detail =
  | {
      kind: "grid";
      cells: DetailCell[];
      /** Les libellés sont à traduire à l'affichage : des genres AniList, ou
       *  des saisons de bingo (« 2026-FALL »). */
      labels?: "genre" | "season";
      /** Les cases portent des anime qu'on peut ouvrir (pas les lecteurs). */
      browsable: boolean;
    }
  | { kind: "list"; items: LocalEntry[] };

const GRID = new Set(["years", "alphabet", "allGenres", "allTags", "hosts", "studio", "works"]);
const LIST = new Set([
  "genre", "tag", "format", "yearBefore", "popularityUnder", "studioNamed",
  "titleLength", "sameDayFinish", "onlyLastEpisode", "planningUnaired", "repeatSame", "listSize",
  "worksEpisodes", "onDate", "neverSkipOp",
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
  if (k === "count") {
    if (def.metric.of === "bingoPoints") return "grid";
    return COUNT_OF.has(String(def.metric.of)) ? "list" : null;
  }
  /* Une œuvre en un seul morceau (« Termine Death Note ») n'a rien à
     détailler : la case unique redirait la condition. */
  if (k === "works") return (WORKS[String(def.metric.key)]?.ids.length ?? 0) > 1 ? "grid" : null;
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
        // L'initiale est lue comme le compte la lit (`initialsOf`).
        cells: cellsOf(letters, done, (e, l) => initialsOf(e).includes(l)),
      };
    }
    /* Les morceaux d'une œuvre (« Naruto ET Shippuden ») : lequel manque.
       Le titre vient du catalogue, l'entrée de la liste quand elle y est. */
    case "works": {
      const w = WORKS[String(m.key)];
      if (!w) return null;
      return {
        kind: "grid",
        browsable: true,
        cells: w.ids.map((id, i) => {
          const e = d.entries.find((x) => x.mediaId === id);
          const ok = d.completedIds.has(id);
          return {
            key: String(id),
            label: w.titles[i] ?? (e ? titleOf(e) : `#${id}`),
            items: ok && e ? [e] : [],
            done: ok,
          };
        }),
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
    /* Les épisodes d'une œuvre-fleuve (Conan, Pokémon) : ses entrées de liste. */
    case "worksEpisodes": {
      const ids = new Set(WORKS[String(m.key)]?.ids ?? []);
      return { kind: "list", items: d.entries.filter((e) => ids.has(e.mediaId)).sort(byTitle) };
    }
    /* Halloween, Saint-Valentin, 1er avril : ce qui a été vu ce jour-là, et
       qui porte le bon genre. */
    case "onDate": {
      const ids = new Set(d.animeOnDate(Number(m.month), Number(m.day)));
      const genre = m.genre ? String(m.genre) : null;
      return {
        kind: "list",
        items: d.entries
          .filter((e) => ids.has(e.mediaId) && (!genre || !!e.genres?.includes(genre)))
          .sort(byTitle),
      };
    }
    /* « Jamais sans l'opening » : les anime terminés dont tout ce qu'on a lu
       ici a gardé son opening — la même règle que derive.ts. */
    case "neverSkipOp": {
      const skipped = new Set(d.facts.opSkipped);
      return {
        kind: "list",
        items: done
          .filter((e) => {
            const eps = d.perAnime.get(e.mediaId);
            if (!eps?.size) return false;
            for (const ep of eps) if (skipped.has(`${e.mediaId}:${ep}`)) return false;
            return true;
          })
          .sort(byTitle),
      };
    }
    case "count":
      switch (String(m.of)) {
        /* Les saisons de bingo jouées, chacune avec son meilleur score. */
        case "bingoPoints": {
          const cells = Object.entries(d.facts.counters)
            .filter(([name]) => name.startsWith("bingo:"))
            .map(([name, c]) => ({
              key: name.slice(6),
              label: name.slice(6),
              items: [],
              done: true,
              value: c.n,
            }))
            .sort((a, b) => b.key.localeCompare(a.key));
          return { kind: "grid", browsable: false, labels: "season", cells };
        }
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
