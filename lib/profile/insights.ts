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

import { STATUS_TO_LIST } from "@/components/anime/v2/helpers";
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

/**
 * Combien d'entrées dans chaque liste personnalisée, la mieux fournie d'abord.
 *
 * L'ORDRE N'EST PAS CELUI DES STATUTS, et ne peut pas l'être : les six statuts
 * ont un ordre CONNU (on regarde, puis on termine, puis on prévoit), les listes
 * inventées n'en ont aucun. Le classement par taille est le seul qui dise
 * quelque chose ; à égalité, l'alphabet, pour que la liste ne se réordonne pas
 * toute seule d'un rendu à l'autre.
 *
 * La somme de ces nombres DÉPASSE la taille de la liste, et c'est correct : une
 * entrée a un seul statut mais peut appartenir à plusieurs listes. C'est aussi
 * pourquoi les deux répartitions ne se montrent jamais ensemble.
 */
export function customListCounts(entries: ProfileEntry[]): Tally[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    for (const n of e.customLists || []) counts.set(n, (counts.get(n) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ key: name, label: name, count }));
}

/**
 * Les statuts d'un titre QU'ON A FINI DE REGARDER.
 *
 * « Re-visionnage » en fait partie, et ce n'est pas une largesse : on ne
 * re-regarde que ce qu'on a déjà terminé une fois. L'exclure retirerait de la
 * distribution les titres les mieux notés du profil — précisément ceux qu'on
 * aime assez pour les reprendre — c'est-à-dire la moitié du sujet.
 */
const FINISHED = new Set(["COMPLETED", "REPEATING"]);

/**
 * LE PAS DE LA RÉPARTITION : LE DEMI-POINT, PARCE QUE C'EST L'UNITÉ DES NOTES.
 *
 * Les colonnes valaient un point entier, et arrondissaient au supérieur : un 7,5
 * était compté comme un 8. Sur un profil qui note au demi-point — ce que le site
 * comme AniList permettent (POINT_10_DECIMAL, cf. lib/profile/types.ts) — la
 * moitié des notes changeait donc de colonne, et l'histogramme montrait une
 * préférence pour les nombres ronds que le spectateur n'a jamais eue.
 *
 * Vingt colonnes, de 0,5 à 10. Pas de colonne à 0 : la note zéro n'existe pas,
 * elle est ce qu'AniList écrit pour « pas noté » — et ces entrées-là sont
 * écartées, pas comptées à zéro.
 */
export const SCORE_STEP = 0.5;
const SCORE_BINS = Math.round(10 / SCORE_STEP);

/** La note que représente la colonne `i` : 0,5, 1, 1,5… 10. */
export function scoreBinValue(i: number): number {
  return (i + 1) * SCORE_STEP;
}

/**
 * Le demi-point auquel une note appartient — la règle de l'histogramme, sortie
 * de lui.
 *
 * Elle est publique parce qu'un SECOND endroit s'en sert : « Ma liste », où
 * l'on atterrit en cliquant une colonne. Les deux pages doivent ranger un 6,7
 * dans le même palier, sans quoi la colonne annoncerait douze titres et la
 * liste en montrerait onze.
 */
export function scoreBucket(score: number): number {
  const v = Math.round(score / SCORE_STEP) * SCORE_STEP;
  return Math.min(10, Math.max(SCORE_STEP, v));
}

export type ScoreSpread = {
  /** Répartition des notes, une colonne par demi-point (cf. `scoreBinValue`).
   *  Vide si personne n'a noté. */
  bins: number[];
  /** La moyenne EXACTE des notes retenues, /10, arrondie au dixième. */
  mean: number | null;
  /** Combien d'entrées la composent — ce que la moyenne vaut. */
  rated: number;
};

/**
 * La distribution des notes du profil, et sa moyenne.
 *
 * LES DEUX SORTENT DE LA MÊME FONCTION PARCE QU'ELLES DOIVENT SORTIR DU MÊME
 * ENSEMBLE : la moyenne est affichée au-dessus de l'histogramme, et une moyenne
 * calculée sur d'autres titres que ceux dessinés en dessous serait un chiffre
 * qui contredit son propre graphique. Le filtre ne peut donc pas être appliqué
 * deux fois de deux côtés.
 *
 * La moyenne est prise sur les notes BRUTES, pas sur les paliers : elle reste
 * juste même si une note tombe entre deux colonnes.
 *
 * LA COLONNE EST CELLE DU DEMI-POINT LE PLUS PROCHE, et plus celle du point
 * entier au-dessus. L'arrondi au supérieur poussait chaque 7,5 chez les 8 ;
 * l'arrondi au plus proche laisse une note posée sur un palier dans SON palier,
 * et ne déplace que les notes qui n'en sont pas — un 6,7, qu'AniList accepte,
 * rejoint les 6,5.
 */
export function scoreSpread(
  entries: ProfileEntry[],
  /** Ne retenir que les titres terminés (cf. `FINISHED`). */
  completedOnly = false,
): ScoreSpread {
  const bins = new Array(SCORE_BINS).fill(0);
  let sum = 0;
  let rated = 0;
  for (const e of entries) {
    const s = e.score;
    if (!s || s <= 0) continue;
    if (completedOnly && !FINISHED.has((e.status || "").toUpperCase())) continue;
    const bin = Math.round(scoreBucket(s) / SCORE_STEP) - 1;
    bins[bin] += 1;
    sum += s;
    rated += 1;
  }
  return {
    bins: rated ? bins : [],
    mean: rated ? Math.round((sum / rated) * 10) / 10 : null,
    rated,
  };
}

/**
 * Années de sortie, de la plus ancienne à la plus récente, SANS TROU.
 *
 * Les années vides sont rendues à zéro plutôt que sautées, et c'est ce qui fait
 * de la suite une frise : une liste qui ne garderait que les années servies
 * collerait 1998 contre 2011 à un pas de distance, et la courbe montrerait une
 * continuité là où il y a treize ans de silence — exactement le contraire de ce
 * qu'on vient lire.
 *
 * L'axe est borné par les données, pas par le calendrier : rien avant la plus
 * vieille sortie, rien après la plus récente.
 */
/** Une année de la frise, et ce que la bulle de survol vient y lire. */
export type YearStat = Tally & {
  /** Minutes regardées cette année-là, `null` quand aucune durée n'est connue —
   *  une liste locale ne porte pas la durée d'un épisode, et une moyenne
   *  inventée ferait une statistique fabriquée. */
  minutes: number | null;
  /** La note moyenne du lecteur sur les titres notés de cette année, /10. */
  mean: number | null;
};

export function yearStats(
  entries: ProfileEntry[],
  /** Ne retenir que les titres terminés (cf. `FINISHED`). */
  completedOnly = false,
  /** Sauter les années à zéro — l'axe cesse alors d'être régulier, cf. plus
   *  haut : c'est un réglage, pas le défaut. */
  skipEmpty = false,
): YearStat[] {
  /* Un accumulateur par année : le compte, les minutes vues (et si une seule
     durée était connue), la somme des notes et combien il y en avait. */
  type Acc = { count: number; minutes: number; timed: boolean; sum: number; rated: number };
  const acc = new Map<number, Acc>();
  for (const e of entries) {
    if (!e.year || e.year < 1900) continue;
    if (completedOnly && !FINISHED.has((e.status || "").toUpperCase())) continue;
    const a = acc.get(e.year) || { count: 0, minutes: 0, timed: false, sum: 0, rated: 0 };
    a.count += 1;
    /* Les épisodes VUS, pas la longueur de la série : le bloc dit le temps
       passé, et un titre abandonné au troisième épisode n'en a coûté que
       trois. Un re-visionnage n'est pas recompté — `statsFromEntries` non plus,
       et deux chiffres du même profil qui compteraient différemment seraient
       pires qu'un chiffre prudent. */
    if (e.duration && e.progress) {
      a.minutes += e.duration * e.progress;
      a.timed = true;
    }
    if (e.score && e.score > 0) {
      a.sum += e.score;
      a.rated += 1;
    }
    acc.set(e.year, a);
  }
  if (!acc.size) return [];
  const stat = (y: number): YearStat => {
    const a = acc.get(y);
    return {
      key: String(y),
      label: String(y),
      count: a?.count || 0,
      minutes: a?.timed ? Math.round(a.minutes) : null,
      mean: a?.rated ? Math.round((a.sum / a.rated) * 10) / 10 : null,
    };
  };
  const ys = [...acc.keys()].sort((a, b) => a - b);
  if (skipEmpty) return ys.map(stat);
  const out: YearStat[] = [];
  for (let y = ys[0]; y <= ys[ys.length - 1]; y++) out.push(stat(y));
  return out;
}

/**
 * Les genres les plus présents. `max` bornes le radar : au-delà de huit
 * branches la figure devient illisible et ne dit plus rien de plus.
 */
export function genreCounts(
  entries: ProfileEntry[],
  max = 8,
  /** Ne retenir que les titres terminés (cf. `FINISHED`). */
  completedOnly = false,
): Tally[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (completedOnly && !FINISHED.has((e.status || "").toUpperCase())) continue;
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
 * `minTitles` existe parce qu'une moyenne sur deux titres n'est pas une
 * moyenne : sans ce seuil, le studio d'un unique 10/10 coiffe celui de quinze
 * titres à 8,5 — un classement qui ne dit rien de ce que le spectateur aime.
 * MESURÉ le 31/08/2026 sur une liste de 824 titres : à 2, les six premières
 * places étaient six studios à 10,0 sur 2 à 4 titres (TNK, OB Planning, Bandai
 * Visual…), c'est-à-dire le classement des coups de cœur isolés et pas celui
 * des studios. Le seuil monte donc à 4, et à note égale c'est le NOMBRE de
 * titres qui départage — un 10 sur quinze titres vaut mieux qu'un 10 sur
 * quatre.
 */
export function studioRanks(entries: ProfileEntry[], minTitles = 4): StudioRank[] {
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

/**
 * La vitrine des favoris : les favoris déclarés, classés par note.
 *
 * LE REPLI NE COMPLÈTE PLUS UNE LISTE INCOMPLÈTE, IL REMPLACE UNE LISTE VIDE.
 * Il comblait la vitrine avec les mieux notés dès qu'il y avait MOINS de
 * `max` favoris — c'est-à-dire presque toujours, `max` valant plusieurs
 * dizaines. Résultat : un profil avec douze favoris en voyait quarante-huit
 * autres passer pour tels, sous un titre qui dit « favoris ». Le repli garde
 * son seul cas honnête, celui pour lequel il a été écrit : AUCUN favori
 * déclaré, où montrer les mieux notés est le même propos plutôt qu'un ajout.
 */
export function favoriteShowcase(entries: ProfileEntry[], max = 8): ProfileEntry[] {
  const rated = (e: ProfileEntry) => e.score || 0;
  const fav = entries.filter((e) => e.favourite).sort((a, b) => rated(b) - rated(a));
  if (fav.length) return fav.slice(0, max);
  return entries
    .filter((e) => rated(e) > 0)
    .sort((a, b) => rated(b) - rated(a))
    .slice(0, max);
}

/**
 * La vitrine, pour la liste que le propriétaire a choisie dans les réglages du
 * bloc (`source`, cf. FAVORITE_SOURCES dans lib/profile/blocks.ts).
 *
 * « favourites » garde `favoriteShowcase` à l'identique. Toute autre valeur est
 * un nom de liste au sens de STATUS_TO_LIST : on prend ses entrées et on les
 * classe par note, ce qui est la même promesse — « les mieux notés » — appliquée
 * à un sous-ensemble. Le repli par les mieux notés du reste du profil n'a
 * volontairement PAS lieu ici : sur une liste nommée, compléter avec des titres
 * qui n'en font pas partie ferait mentir le titre du widget.
 */
export function showcaseFor(
  entries: ProfileEntry[],
  source: string,
  max = 10,
  /**
   * La plage de notes affichée, et si les titres SANS note en font partie.
   *
   * Le filtre s'applique avant tout le reste, y compris aux favoris déclarés :
   * « entre 8 et 10 » veut dire ce qu'il dit, et un favori noté 4 n'a pas à
   * échapper à la règle parce qu'il porte un cœur.
   */
  scores: [number, number] = [0, 10],
  unrated = true,
): ProfileEntry[] {
  const [lo, hi] = scores;
  const full = lo <= 0 && hi >= 10 && unrated;
  if (!full) {
    entries = entries.filter((e) =>
      e.score == null || e.score === 0 ? unrated : e.score >= lo && e.score <= hi,
    );
  }
  if (!source || source === "favourites") return favoriteShowcase(entries, max);
  /* Une liste personnalisée est préfixée pour ne pas se confondre avec une liste
     de statut : rien n'empêche quelqu'un d'appeler la sienne « Completed ». */
  const custom = source.startsWith(CUSTOM_PREFIX)
    ? source.slice(CUSTOM_PREFIX.length)
    : null;
  return entries
    .filter((e) =>
      custom
        ? e.customLists?.includes(custom)
        : STATUS_TO_LIST[(e.status || "").toUpperCase()] === source,
    )
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, max);
}

/** Le préfixe qui distingue « la liste personnalisée X » d'une liste de statut. */
export const CUSTOM_PREFIX = "custom:";

/** Les listes personnalisées présentes dans une liste, dans l'ordre alphabétique. */
export function customListNames(entries: ProfileEntry[]): string[] {
  const names = new Set<string>();
  for (const e of entries) for (const n of e.customLists || []) names.add(n);
  return [...names].sort((a, b) => a.localeCompare(b));
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
