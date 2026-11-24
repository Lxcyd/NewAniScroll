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
import { initialsOf, isCompletedNow, longTitleLength, titleOf, type Derived } from "./derive";
import { isBonusFormat } from "./measure";
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
  | {
      kind: "list";
      items: LocalEntry[];
      /** Un nombre d'épisodes à côté de chaque anime, à la place de l'année. */
      episodes?: Map<number, number>;
    };

const GRID = new Set(["years", "alphabet", "allGenres", "allTags", "hosts", "studio", "works"]);
const LIST = new Set([
  "genre", "tag", "format", "yearBefore", "popularityUnder", "studioNamed",
  "titleLength", "sameDayFinish", "onlyLastEpisode", "repeatSame",
  "worksEpisodes", "onDate", "neverSkipOp",
]);
/** Les compteurs `count` qui se ramènent à des anime de la liste. Les épisodes,
 *  les minutes ou la série de jours n'en sont pas : pas de liste à montrer. */
const COUNT_OF = new Set(["completed", "rated", "rewatched", "favourites"]);

/**
 * La forme du détail d'un badge, SANS le calculer — de quoi décider d'afficher
 * le bouton (et son icône) sur chaque ligne. `null` : pas de détail, ou pas
 * encore les données (le vocabulaire des genres et des tags est récupéré à
 * part, cf. metaBackfill.ts).
 */
export function detailKind(def: BadgeDef, d: Derived): "grid" | "list" | null {
  const k = def.metric.k;
  if (k === "flag") return def.metric.name === "oav" || def.metric.name === "dayOne" ? "list" : null;
  if (k === "counter") return def.metric.name === "onAirDay" ? "list" : null;
  if ((k === "allGenres" || k === "allTags") && !d.vocab) return null;
  if (k === "count") {
    if (def.metric.of === "bingoPoints") return "grid";
    if (def.metric.of === "favourites" && !d.favouriteIds) return null;
    return COUNT_OF.has(String(def.metric.of)) ? "list" : null;
  }
  /* Une œuvre en un seul morceau (« Termine Death Note ») n'a rien à
     détailler : la case unique redirait la condition. */
  if (k === "works") return (WORKS[String(def.metric.key)]?.ids.length ?? 0) > 1 ? "grid" : null;
  return GRID.has(k) ? "grid" : LIST.has(k) ? "list" : null;
}

/** Les badges remplis par des anime TERMINÉS : leur année est celle de la fin. */
const PAR_COMPLETION = new Set([
  "alphabet", "works", "allGenres", "allTags", "studio", "genre", "tag", "format",
  "popularityUnder", "studioNamed", "titleLength", "sameDayFinish", "neverSkipOp",
]);

/**
 * L'année à afficher à côté d'un anime : celle du fait que le badge mesure.
 * Sortie de l'œuvre pour les badges d'époque, fin de visionnage pour ceux qui
 * comptent des anime terminés : la date de fin de la liste, sinon `vuLe` (ms),
 * le dernier épisode daté par le fil AniList ou le site. `null` quand la liste ne garde pas cette date
 * (quand une note a été posée, un titre ajouté, une revoyure faite) : mieux vaut
 * rien qu'une année qui parle d'autre chose.
 */
export function detailYear(def: BadgeDef, e: LocalEntry, vuLe?: number | null): number | null {
  const m = def.metric;
  if (m.k === "years" || m.k === "yearBefore") return e.year ?? null;
  if (PAR_COMPLETION.has(m.k) || (m.k === "count" && m.of === "completed") || m.name === "oav") {
    return e.completedAt?.year ?? (vuLe ? new Date(vuLe).getFullYear() : null);
  }
  return null;
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
        cells: cellsOf(years, d.seen, (e, y) => e.year === Number(y)),
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
    case "flag":
      // Seul « Épisode bonus » a une liste : la même lecture que `flagUp`.
      if (m.name === "dayOne") {
        return { kind: "list", items: d.entries.filter((e) => d.finalOnAir.has(e.mediaId)).sort(byTitle) };
      }
      if (m.name !== "oav") return null;
      return { kind: "list", items: d.seen.filter(isBonusFormat).sort(byTitle) };
    case "counter":
      if (m.name !== "onAirDay") return null;
      return {
        kind: "list",
        episodes: d.onAirByAnime,
        items: d.entries
          .filter((e) => d.onAirByAnime.has(e.mediaId))
          .sort((a, b) => (d.onAirByAnime.get(b.mediaId) ?? 0) - (d.onAirByAnime.get(a.mediaId) ?? 0) || byTitle(a, b)),
      };
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
        items: done.filter((e) => longTitleLength(e) > Number(m.min)).sort(byTitle),
      };
    case "sameDayFinish":
      return {
        kind: "list",
        items: done.filter((e) => d.sameDayAt.has(e.mediaId)).sort(byTitle),
      };
    case "onlyLastEpisode":
      return {
        kind: "list",
        items: d.entries.filter((e) => d.onlyLastIds.has(e.mediaId)).sort(byTitle),
      };
    /* Les plus revus d'abord : c'est le premier qui porte « trois fois ». */
    case "repeatSame":
      return {
        kind: "list",
        /* Vu N fois = N - 1 revisionnages : « trois fois » ne liste pas ceux vus deux fois. */
        items: d.entries
          .filter((e) => (e.repeat ?? 0) + 1 >= Number(m.times))
          .sort((a, b) => (b.repeat ?? 0) - (a.repeat ?? 0) || byTitle(a, b)),
      };
    /* Les épisodes d'une œuvre-fleuve (Conan, Pokémon) : ses entrées de liste. */
    /* Un épisode lu sur le site compte même si l'anime n'est pas dans la liste
       (Naruto, vu ici sans jamais être ajouté) : on le montre avec le titre du
       catalogue, sans affiche. */
    case "worksEpisodes": {
      const w = WORKS[String(m.key)];
      if (!w) return null;
      const items = w.ids.flatMap((id, i): LocalEntry[] => {
        if ((d.episodesByAnime.get(id) ?? 0) <= 0) return [];
        const e = d.entries.find((x) => x.mediaId === id);
        if (e) return [e];
        const t = w.titles[i] ?? `#${id}`;
        return [{ mediaId: id, title: { romaji: t, english: t, userPreferred: t } } as LocalEntry];
      });
      return { kind: "list", items: items.sort(byTitle) };
    }
    /* Halloween, Saint-Valentin, 1er avril : ce qui a été vu ce jour-là, et
       qui porte le bon genre. */
    case "onDate": {
      const ids = new Set(d.animeOnDate(Number(m.month), Number(m.day)));
      const genre = m.genre ? String(m.genre) : null;
      return {
        kind: "list",
        items: d.seen
          .filter((e) => ids.has(e.mediaId) && (!genre || !!e.genres?.includes(genre)))
          .sort(byTitle),
      };
    }
    /* « Jamais sans l'opening » : les anime terminés dont tout ce qu'on a lu
       ici a gardé son opening — la même règle que derive.ts. */
    case "neverSkipOp":
      return { kind: "list", items: done.filter((e) => d.neverSkippedIds.has(e.mediaId)).sort(byTitle) };
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
        case "completed": return { kind: "list", items: done.filter(isCompletedNow).sort(byTitle) };
        case "rated":
          return { kind: "list", items: d.seen.filter((e) => (e.score ?? 0) > 0).sort(byTitle) };
        case "rewatched":
          return { kind: "list", items: d.entries.filter((e) => (e.repeat ?? 0) >= 1).sort(byTitle) };
        /* Un favori absent de la liste n'a pas d'entrée à montrer : il compte,
           mais n'apparaît pas ici. */
        case "favourites": {
          if (!d.favouriteIds) return null;
          const ids = new Set(d.favouriteIds);
          return { kind: "list", items: d.entries.filter((e) => ids.has(e.mediaId)).sort(byTitle) };
        }
        default: return null;
      }
    default:
      return null;
  }
}
