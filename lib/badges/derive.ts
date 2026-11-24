/**
 * Ce que les stores de l'appareil savent dire, mesuré UNE FOIS.
 *
 * Séparé de `measure.ts` pour une raison de coût : les 176 badges posent des
 * questions qui se recoupent (« combien d'épisodes terminés » sert à six
 * paliers, la liste des jours à six autres). Les mesurer badge par badge
 * relirait le localStorage 176 fois. Ici, un seul balayage de chaque store, et
 * les prédicats lisent ensuite un objet en mémoire.
 *
 * Fonctions PURES : `derive()` prend un instantané et rend des chiffres. Rien
 * n'est lu du navigateur dans ce fichier, ce qui permet de le faire tourner sur
 * des instantanés fabriqués — c'est ainsi que les cas d'heure locale sont
 * vérifiés (tools/badges/check-catalog.mjs).
 */

import { BY_ID, MAIN, type BadgeDef } from "./catalog";
import { isCompleted, type ProgressEntry } from "../watch/progress";
import type { LocalEntry, LocalListMap } from "../list/localList";
import {
  bestWindow, clusters, currentRun, dayKey, longestRun, isWeekend, monthDay,
  sane,
} from "./localtime";
import type { Facts } from "./facts";

export type ProgressMap = Record<string, ProgressEntry>;

export type Snapshot = {
  progress: ProgressMap;
  list: LocalListMap;
  facts: Facts;
  /** Ids AniList des favoris, `null` quand la source est absente (pas de compte
   *  AniList : les favoris vivent là-bas, cf. lib/anilist/favouritesCache.ts). */
  favourites: number[] | null;
  /** Le vocabulaire du catalogue, `null` tant qu'il n'a pas été récupéré. */
  vocab: { genres: string[]; tags: string[] } | null;
  /** Création du compte, pour « Un an ici ». */
  accountCreatedAt: number | null;
  /** Lecteurs proposés par le site — la cible de « Tous les lecteurs ». */
  displayedHosts: string[];
  /** Les heures (depuis 1970) du fil d'activité AniList, pour les jours de série. */
  feedHours?: number[];
  /** Le fil AniList lui-même : [secondes, id AniList, épisode]. */
  feedEvents?: [number, number, number][];
  /** Les lignes « completed » du fil : id AniList → secondes. */
  feedCompletions?: Record<number, number>;
  /** Les dates de diffusion (lib/badges/airingBackfill.ts). */
  airing?: Record<number, { t: number | null; a: [number, number][] }>;
  /** Toutes les dates ont été lues : une absence y prouve quelque chose. */
  airingComplete?: boolean;
  /** Maintenant, injectable pour que les tests ne dépendent pas de l'horloge. */
  now: number;
};

/** Un épisode terminé, réduit à ce dont les badges ont besoin. */
type Watched = { aniId: number; episode: string; at: number; minutes: number };

export type Derived = {
  now: number;

  /* ── Visionnage ─────────────────────────────────────────────────────────── */
  /** Épisodes DISTINCTS terminés. */
  episodes: number;
  /** Minutes cumulées, mesurées sur la durée réelle des fichiers. */
  minutes: number;
  /** Horodatages des épisodes terminés, ici et dans le fil AniList, triés. */
  stamps: number[];
  /** Les mêmes, avec leur anime. */
  timeline: { aniId: number; at: number }[];
  /** Quand une séance a atteint `hours` pour la première fois. */
  sessionReachedAt: (hours: number, weekend: boolean) => number | null;
  /** Anime commencés et finis le même jour → ce jour-là (ms). */
  sameDayAt: Map<number, number>;
  /** Anime dont seul le dernier épisode a été vu. */
  onlyLastIds: Set<number>;
  /** Anime lus ici en entier sans jamais passer l'opening. */
  neverSkippedIds: Set<number>;
  /** Le compte a un fil AniList chargé. */
  hasFeed: boolean;
  /** Épisodes vus dans les 24 h suivant leur diffusion, par anime. */
  onAirByAnime: Map<number, number>;
  /** Le moment de chacun de ces visionnages, triés. */
  onAirStamps: number[];
  /** Anime dont le DERNIER épisode a été vu le jour de sa diffusion → quand. */
  finalOnAir: Map<number, number>;
  finalOnAirAt: number | null;
  hasAiring: boolean;
  /** La première reprise d'un anime après plus de 30 jours, d'après le fil. */
  comebackAt: number | null;
  /** Jours locaux où au moins un épisode a été terminé. */
  days: Set<string>;
  /** La série de jours qui court en ce moment. */
  streak: number;
  /** La plus longue série jamais tenue. */
  bestStreak: number;
  /** Épisodes terminés par anime. */
  perAnime: Map<number, Set<string>>;
  /** Épisodes vus par anime, ici OU dans la liste (le plus grand des deux). */
  episodesByAnime: Map<number, number>;
  /** Le dernier épisode terminé sur le site, par anime (ms). */
  lastSeenAt: Map<number, number>;
  /** Le plus gros total sur 24 h, puis sur 7 jours (fenêtres glissantes). */
  best24h: number;
  best7d: number;
  /** La plus grosse séance d'un seul tenant, en épisodes. */
  biggestNight: number;
  /** La plus longue séance, en heures. */
  longestSession: number;
  /** La plus longue séance d'un week-end, en heures. */
  longestWeekendSession: number;
  /** Un épisode a-t-il été lancé dans cette plage d'heures locales ? */
  inHours: (from: number, to: number) => boolean;
  /** Un épisode lancé pendant la minute de minuit. */
  midnight: boolean;
  /** Les anime terminés à cette date du calendrier (tous millésimes confondus). */
  animeOnDate: (month: number, day: number) => number[];

  /* ── Liste ──────────────────────────────────────────────────────────────── */
  /** Toute la liste, tous statuts confondus (le détail en tire ses anime). */
  entries: LocalEntry[];
  /** Anime terminés (COMPLETED ou REPEATING). */
  completed: LocalEntry[];
  /** Les mêmes, indexés : les 60 badges par titre posent 74 questions
   *  « celui-ci est-il terminé ? » à chaque fin d'épisode. */
  completedIds: Set<number>;
  completedCount: number;
  /** Anime regardés, finis ou non : terminés, ou au moins un épisode vu. */
  seen: LocalEntry[];
  /** Combien d'entrées dans la liste, tous statuts confondus. */
  listSize: number;
  /** Un anime dont on n'a regardé QUE le dernier épisode. */
  onlyLastEpisode: boolean;
  /** Un anime commencé et terminé le même jour du calendrier. */
  sameDayFinish: boolean;
  /** Un titre en projet dont la diffusion n'a pas commencé. `null` tant que la
   *  liste ne porte pas le statut de diffusion des œuvres. */
  planningUnaired: boolean | null;
  /** Titres portant une note. */
  rated: number;
  /** Séries revues au moins une fois. */
  rewatched: number;
  /** Le plus grand nombre de visionnages d'une même série. */
  mostRepeats: number;
  favourites: number | null;
  /** Les ids des favoris, pour le détail des badges « coup de cœur ». */
  favouriteIds: number[] | null;

  /* ── Métadonnées (null = la liste ne les porte pas encore) ──────────────── */
  /** Anime terminés portant ce genre. `null` si aucun n'a de genres. */
  genre: (name: string) => number | null;
  tag: (name: string) => number | null;
  format: (name: string) => number | null;
  /** Anime terminés sortis avant cette année. */
  before: (year: number) => number | null;
  /** Décennies distinctes couvertes depuis `from`. */
  decades: (from: number) => number | null;
  /** Années distinctes couvertes de `from` à `to` inclus, par des anime regardés. */
  years: (from: number, to: number) => number | null;
  /** Le studio le mieux représenté, en nombre d'anime terminés. */
  topStudio: number | null;
  /** Anime terminés de ce studio précis. */
  studioNamed: (name: string) => number | null;
  /** Anime terminés vus par moins de `max` personnes. */
  underPopularity: (max: number) => number | null;
  /** Lettres initiales distinctes (A-Z) des anime terminés (cf. initialsOf). */
  initials: number;
  /** Points cumulés des bingos officiels, meilleur score de chaque saison. */
  bingoPoints: number;
  /** Le titre terminé le plus long, en caractères. */
  longestTitle: number;
  /** Genres du catalogue couverts par au moins un anime terminé. */
  genresCovered: number | null;
  tagsCovered: number | null;
  /** Taille du vocabulaire du catalogue — la CIBLE de « tous les genres ». */
  vocabGenres: number | null;
  vocabTags: number | null;
  /** Le nombre de saisons de la plus longue franchise entièrement terminée. */
  longestFranchise: number | null;
  /** Ces franchises elles-mêmes (leurs titres), pour le détail. `null` sans relations. */
  franchises: LocalEntry[][] | null;

  /** Le vocabulaire lui-même, et les lecteurs proposés : le DÉTAIL d'un badge
   *  (lib/badges/detail.ts) montre chaque case, pas seulement leur nombre. */
  vocab: { genres: string[]; tags: string[] } | null;
  displayedHosts: string[];

  /* ── Faits ──────────────────────────────────────────────────────────────── */
  facts: Facts;
  /** Lecteurs distincts utilisés, sur ceux que le site propose. */
  hostsUsed: number;
  hostsTotal: number;
  /** Un anime terminé dont aucun épisode n'a vu son opening sauté. */
  neverSkippedOp: boolean;
  accountAgeDays: number | null;
  /** Création du compte AniScroll (epoch ms), null hors connexion. */
  accountCreatedAt: number | null;

  /* ── Le catalogue lui-même ──────────────────────────────────────────────────
     Porté ici pour que `measure` reste une fonction de (badge, mesures) : les
     badges qui comptent d'autres badges ont besoin de savoir lesquels sont
     secrets et de quelle rareté, et aller le rechercher dans le catalogue
     depuis le prédicat en ferait un module à deux sources. */
  defs: Record<string, BadgeDef>;
  /** Combien de badges NON SECRETS existent — la cible de la collection. */
  mainCount: number;
};

/** Les statuts qui veulent dire « je l'ai fini ». Même ensemble que
 *  lib/profile/insights.ts : on ne re-regarde que ce qu'on a terminé une fois. */
const FINISHED = new Set(["COMPLETED", "REPEATING"]);

/** Dans la liste « Terminé » en ce moment : ce que comptent les badges « Termine N anime ». */
export const isCompletedNow = (e: { status?: string | null }) =>
  String(e.status ?? "").toUpperCase() === "COMPLETED";

/** Une date floue AniList réduite à son jour, ou `null` si elle est incomplète.
 *  Exportée pour le détail de « D'un coup ». */
export function fuzzyDay(d: { year: number | null; month: number | null; day: number | null } | null): string | null {
  if (!d?.year || !d?.month || !d?.day) return null;
  return `${d.year}-${d.month}-${d.day}`;
}

/** Le titre d'une entrée, dans l'ordre de préférence habituel. Exporté : le
 *  détail de « A à Z » doit classer par la MÊME initiale que le compte. */
export function titleOf(e: LocalEntry): string {
  const t = e.title;
  return t?.english || t?.romaji || t?.userPreferred || t?.native || "";
}

/** La longueur du plus long titre, anglais ou romaji, pour « Titre à
 *  rallonge » : le romaji compte aussi (24/11/2026, Luc). */
export function longTitleLength(e: LocalEntry): number {
  const t = e.title;
  return Math.max(titleOf(e).length, t?.english?.length ?? 0, t?.romaji?.length ?? 0);
}

/**
 * LES INITIALES D'UNE ENTRÉE, pour « De A à Z » (09/11/2026, Luc : « il ne
 * marche pas »).
 *
 * L'ancienne règle ne lisait QUE le titre anglais (`titleOf`), et prenait son
 * premier caractère tel quel. Trois façons de rater une lettre qu'on voit
 * pourtant sur sa liste : le titre affiché est le romaji (« Shingeki no
 * Kyojin » ne donnait pas S, seulement A pour « Attack on Titan ») ; le titre
 * commence par un signe (« [Oshi no Ko] », « "Oshi no Ko" ») ; ou par une
 * lettre accentuée (« Éden »). Une entrée donne désormais l'initiale de
 * CHACUN de ses titres latins, débarrassée de ce qui précède la première
 * lettre et de ses accents. Le natif n'en donne pas : il n'a pas de A-Z.
 */
export function initialsOf(e: LocalEntry): string[] {
  const t = e.title;
  const out = new Set<string>();
  for (const s of [t?.english, t?.romaji, t?.userPreferred]) {
    const c = (s ?? "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .match(/[A-Za-z]/)?.[0];
    /* La première LETTRE, mais seulement si rien d'autre qu'un signe la
       précède : « 86 Eighty-Six » ne donne pas E, il commence par un chiffre. */
    if (!c) continue;
    const head = (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (/[0-9\p{L}]/u.test(head.slice(0, head.indexOf(c)))) continue;
    out.add(c.toUpperCase());
  }
  return [...out];
}

/** Le fil vient du stockage du navigateur : une ligne illisible est ignorée. */
const validFeedRow = (r: unknown): r is [number, number, number] =>
  Array.isArray(r) &&
  r.length >= 3 &&
  Number.isFinite(r[0]) &&
  r[0] > 0 &&
  Number.isInteger(r[1]) &&
  r[1] > 0 &&
  Number.isInteger(r[2]) &&
  r[2] > 0;

/** Moins de 5 min par épisode : cochés d'un coup, pas regardés. */
const tooFast = (first: number, last: number, total: number) =>
  last - first < (total - 1) * 5 * 60_000;

/** Le jour où le fil montre TOUS les épisodes de 1 à `total`, à un rythme possible. */
function feedSameDay(rows: { at: number; ep: number }[], total: number): number | null {
  const byDay = new Map<string, { at: number; ep: number }[]>();
  for (const r of rows) {
    const k = dayKey(r.at);
    const day = byDay.get(k);
    if (day) day.push(r);
    else byDay.set(k, [r]);
  }
  for (const day of byDay.values()) {
    const eps = new Set(day.map((r) => r.ep));
    let all = true;
    for (let i = 1; i <= total && all; i++) all = eps.has(i);
    if (all && !tooFast(day[0].at, day[day.length - 1].at, total)) return day[day.length - 1].at;
  }
  return null;
}

export function derive(s: Snapshot): Derived {
  const now = s.now;

  /* ── Un seul balayage de la table de progression ───────────────────────── */
  const watched: Watched[] = [];
  const perAnime = new Map<number, Set<string>>();
  const lastSeenAt = new Map<number, number>();
  for (const [key, entry] of Object.entries(s.progress)) {
    if (!isCompleted(entry)) continue;
    const sep = key.lastIndexOf(":");
    if (sep < 0) continue;
    const aniId = Number(key.slice(0, sep));
    const episode = key.slice(sep + 1);
    if (!Number.isFinite(aniId)) continue;
    /* L'horloge fausse est écartée ici, une fois : un `updatedAt` dans le futur
       ne compte pas comme visionnage daté. L'épisode, lui, reste compté — il a
       bien été regardé, c'est sa DATE qui est douteuse. */
    const at = sane(entry.updatedAt, now);
    const minutes = entry.duration > 0 ? entry.duration / 60 : 0;
    watched.push({ aniId, episode, at: at ?? 0, minutes });
    let set = perAnime.get(aniId);
    if (!set) perAnime.set(aniId, (set = new Set()));
    set.add(episode);
    if (at && at > (lastSeenAt.get(aniId) ?? 0)) lastSeenAt.set(aniId, at);
  }

  /* LE FIL ANILIST EST L'HISTORIQUE DATÉ (24/11/2026, Luc : « 4 / 20 » sur un
     compte qui a vu 34 épisodes en 24 h). Il compte pour tout ce qui parle de
     QUAND on a regardé. Deux exclusions :
       - une ligne à moins d'une minute de la précédente : des épisodes cochés à
         la chaîne pour rattraper sa liste, pas regardés à ce moment-là ;
       - un épisode déjà lu ici dans les 12 h : AniList en a reçu une copie. */
  const here = new Map<string, number>();
  for (const w of watched) if (w.at) here.set(`${w.aniId}:${w.episode}`, w.at);
  /* LE DERNIER ÉPISODE EST SOUVENT UNE LIGNE « COMPLETED », SANS NUMÉRO : sans elle,
     les finals vus le jour même disparaissaient (Solo Leveling S2, 2 h après sa
     diffusion). Elle vaut pour le dernier épisode quand il n'a pas sa propre ligne. */
  const feedValid = (s.feedEvents ?? []).filter(validFeedRow);
  const feedKnown = new Set(feedValid.map((r) => `${r[1]}:${r[2]}`));
  const feedFinals: [number, number, number][] = [];
  for (const [k, sec] of Object.entries(s.feedCompletions ?? {})) {
    const id = Number(k);
    const total = s.list[id]?.total ?? s.airing?.[id]?.t ?? 0;
    const row: [number, number, number] = [Number(sec), id, total];
    if (total > 0 && validFeedRow(row) && !feedKnown.has(`${id}:${total}`)) feedFinals.push(row);
  }
  const feedSorted = [...feedValid, ...feedFinals].sort((a, b) => a[0] - b[0]);
  const lastSameEpisode = new Map<string, number>();
  const feedRows: { aniId: number; at: number; minutes: number }[] = [];
  let previous = -Infinity;
  for (const [sec, aniId, ep] of feedSorted) {
    const at = sane(sec * 1000, now);
    if (!at) continue;
    const chained = at - previous < 60_000;
    previous = at;
    if (chained) continue;
    /* Le même épisode remarqué dans la journée ne compte qu'une fois. */
    const before = lastSameEpisode.get(`${aniId}:${ep}`);
    lastSameEpisode.set(`${aniId}:${ep}`, at);
    if (before != null && at - before < 86_400_000) continue;
    const mine = here.get(`${aniId}:${ep}`);
    if (mine != null && Math.abs(mine - at) < 12 * 3_600_000) continue;
    feedRows.push({ aniId, at, minutes: s.list[aniId]?.duration || 24 });
  }
  const timeline = [...watched, ...feedRows]
    .filter((w) => w.at > 0)
    .map((w) => ({ aniId: w.aniId, at: w.at }))
    .sort((a, b) => a.at - b.at);
  const stamps = timeline.map((w) => w.at);

  /* UN SEUL `new Date` PAR HORODATAGE. Le jour, l'heure et « minuit pile » en
     creaient chacun le leur, sur des milliers d'horodatages a chaque passage de
     l'evaluateur (chaque page, chaque episode termine). Memes accesseurs locaux
     que lib/badges/localtime.ts (dayKey, hourOf, isMidnightSharp). */
  const days = new Set<string>();
  const hours = new Set<number>();
  let midnight = false;
  for (const t of stamps) {
    const d = new Date(t);
    days.add(dayKey(d));
    const h = d.getHours();
    hours.add(h);
    if (h === 0 && d.getMinutes() === 0) midnight = true;
  }
  /* LE FIL ANILIST COMPTE POUR LES JOURS (10/11/2026, Luc : « j'ai deja regarde
     plus de 7 jours d'affilee »), comme pour la heatmap. Les jours seulement :
     les heures, les seances et les paliers d'episodes restent ceux de la table. */
  for (const h of s.feedHours ?? []) days.add(dayKey(new Date(h * 3_600_000)));

  /* La duree du premier episode trouve a chaque horodatage — ce que
     `watched.find((w) => w.at === …)` rendait, mais en un seul balayage : le
     `find` reparcourait toute la table pour CHAQUE seance (quadratique). */
  const minutesAt = new Map<number, number>();
  for (const w of [...watched, ...feedRows]) if (!minutesAt.has(w.at)) minutesAt.set(w.at, w.minutes);

  /* Les séances : une grappe d'activité, pas une date (une soirée qui passe
     minuit reste une soirée — cf. lib/badges/localtime.ts). */
  const runs = clusters(stamps);
  let biggestNight = 0;
  let longestSession = 0;
  let longestWeekendSession = 0;
  const sessions: { end: number; hours: number; weekend: boolean }[] = [];
  for (const run of runs) {
    if (run.length > biggestNight) biggestNight = run.length;
    /* La durée d'une séance est mesurée du premier au dernier épisode, plus la
       durée du dernier : sans ce dernier terme, six épisodes de 24 min lancés
       toutes les 24 min compteraient 2 h 00 au lieu de 2 h 24. */
    const span = (run[run.length - 1] - run[0]) / 3_600_000;
    const tailMinutes = minutesAt.get(run[run.length - 1]) ?? 0;
    const hours = span + tailMinutes / 60;
    sessions.push({ end: run[run.length - 1], hours, weekend: isWeekend(run[0]) && isWeekend(run[run.length - 1]) });
    if (hours > longestSession) longestSession = hours;
    /* Un « marathon de week-end » doit se tenir sur le week-end : on exige que
       les deux bouts de la séance y soient, sinon une séance du vendredi soir
       qui déborde sur samedi 1 h compterait comme un week-end entier. */
    if (isWeekend(run[0]) && isWeekend(run[run.length - 1]) && hours > longestWeekendSession) {
      longestWeekendSession = hours;
    }
  }

  /* ── La liste ───────────────────────────────────────────────────────────── */
  const entries = Object.values(s.list);
  const completed = entries.filter((e) => FINISHED.has(String(e.status ?? "").toUpperCase()));

  /* Ce que le fil dit, anime par anime : commencé et fini le même jour, et
     repris après plus de trente jours. */
  const feedByAnime = new Map<number, { at: number; ep: number }[]>();
  for (const [sec, aniId, ep] of feedSorted) {
    const at = sane(sec * 1000, now);
    if (!at) continue;
    let rows = feedByAnime.get(aniId);
    if (!rows) feedByAnime.set(aniId, (rows = []));
    rows.push({ at, ep });
  }

  /* Un épisode daté dans le fil AniList est un épisode VU, même si le titre a
     été remis en « Planifié » depuis (Killing Bites, vu le 31/10/2025, replanifié :
     Halloween restait à 0 sur le compte de Luc). */
  const seen = entries.filter(
    (e) =>
      FINISHED.has(String(e.status ?? "").toUpperCase()) ||
      ((e.progress ?? 0) > 0 && String(e.status ?? "").toUpperCase() !== "PLANNING") ||
      perAnime.has(e.mediaId) ||
      feedByAnime.has(e.mediaId),
  );
  /* Une note sur un titre seulement planifié n'est pas un avis sur ce qu'on a vu. */
  const rated = seen.filter((e) => (e.score ?? 0) > 0).length;
  const rewatched = entries.filter((e) => (e.repeat ?? 0) >= 1).length;
  /* « Repris en main » : un épisode qui CONTINUE après trente jours. Une relecture
     repart en arrière, et un anime déjà au bout n'était pas laissé de côté. */
  let comebackAt: number | null = null;
  for (const [aniId, rows] of feedByAnime) {
    const total = s.list[aniId]?.total ?? Infinity;
    for (let i = 1; i < rows.length; i++) {
      const [a, b] = [rows[i - 1], rows[i]];
      if (b.at - a.at > 30 * 86_400_000 && b.ep > a.ep && a.ep < total && (comebackAt == null || b.at < comebackAt)) {
        comebackAt = b.at;
      }
    }
  }

  /* « Toujours à jour » : vu dans les 24 h qui SUIVENT la diffusion, une fois par
     épisode. « Final le jour même » : le même, sur le dernier épisode connu. */
  const airAt = new Map<string, number>();
  for (const [id, info] of Object.entries(s.airing ?? {})) {
    for (const [ep, at] of info.a ?? []) airAt.set(`${id}:${ep}`, at * 1000);
  }
  const firstOnAir = new Map<string, number>();
  const onAirSee = (id: number, ep: number, at: number) => {
    const k = `${id}:${ep}`;
    const aired = airAt.get(k);
    if (aired == null || at < aired || at - aired >= 86_400_000) return;
    const cur = firstOnAir.get(k);
    if (cur == null || at < cur) firstOnAir.set(k, at);
  };
  for (const [sec, id, ep] of feedSorted) {
    const at = sane(sec * 1000, now);
    if (at) onAirSee(id, ep, at);
  }
  for (const w of watched) if (w.at) onAirSee(w.aniId, Number(w.episode), w.at);
  const onAirByAnime = new Map<number, number>();
  const finalOnAir = new Map<number, number>();
  for (const [k, at] of firstOnAir) {
    const [id, ep] = k.split(":").map(Number);
    onAirByAnime.set(id, (onAirByAnime.get(id) ?? 0) + 1);
    if (s.airing?.[id]?.t === ep) finalOnAir.set(id, at);
  }
  const onAirStamps = [...firstOnAir.values()].sort((a, b) => a - b);

  /* « D'un coup » : la date de la liste, sauf si le fil la contredit (des épisodes
     vus avant, ou tous cochés en quelques secondes), ou le fil seul. */
  const sameDayAt = new Map<number, number>();
  for (const e of completed) {
    const total = e.total ?? 0;
    if (total < 2) continue;
    const rows = feedByAnime.get(e.mediaId) ?? [];
    const fromFeed = feedSameDay(rows, total);
    if (fromFeed != null) {
      sameDayAt.set(e.mediaId, fromFeed);
      continue;
    }
    const a = fuzzyDay(e.startedAt);
    if (!a || a !== fuzzyDay(e.completedAt)) continue;
    const d = e.completedAt!;
    const start = new Date(d.year!, d.month! - 1, d.day!).getTime();
    const thatDay = rows.filter((r) => dayKey(r.at) === dayKey(start));
    const checked = thatDay.length >= total && tooFast(thatDay[0].at, thatDay[thatDay.length - 1].at, total);
    if (!checked && !rows.some((r) => r.at < start)) sameDayAt.set(e.mediaId, start);
  }

  /* ── LE COMPTE D'ÉPISODES, ET POURQUOI IL NE PEUT PAS VENIR DE LA SEULE
     TABLE DE PROGRESSION ────────────────────────────────────────────────────
     Première version : on ne comptait que les épisodes LUS SUR LE SITE. Un
     compte avec cinq mille épisodes sur son profil — tous venus d'une liste
     AniList importée — n'avait donc que le badge du premier épisode, et sa
     barre affichait 1/25. Le profil, lui, somme `progress` sur les entrées de
     liste (lib/profile/sources.ts) : les deux chiffres se contredisaient à
     l'écran, sur la même page.

     La source de vérité est donc la liste, avec la lecture locale par-dessus :
     pour chaque anime on prend le PLUS GRAND des deux. Un `max`, et non une
     somme — les épisodes lus ici sont déjà, en principe, dans `progress`, et
     les additionner compterait deux fois le même épisode. Le max garde aussi
     l'avance locale quand la synchro n'a pas encore eu lieu. */
  const perAnimeCount = new Map<number, number>();
  for (const [aniId, eps] of perAnime) perAnimeCount.set(aniId, eps.size);
  for (const e of entries) {
    const listed = Math.max(0, Math.floor(e.progress || 0));
    if (listed > (perAnimeCount.get(e.mediaId) ?? 0)) perAnimeCount.set(e.mediaId, listed);
  }
  let episodeCount = 0;
  for (const n of perAnimeCount.values()) episodeCount += n;

  /* ── LES REVISIONNAGES COMPTENT, PARCE QUE LE PROFIL LES COMPTE ─────────────
     Il restait un écart, et il se lisait sur la même page : 5261 épisodes en
     tête de profil, « 4917 / 5000 » sur le badge juste dessous. Le compteur du
     haut vient de `statistics.anime.episodesWatched` d'AniList
     (pages/en/profile/[user].tsx), et AniList y ajoute chaque relecture :
     `progress + repeat × épisodes de l'œuvre`. Le nôtre sommait les épisodes
     DISTINCTS, ce qui est un autre chiffre — défendable en soi, mais pas à côté
     de l'autre. Le badge dit « le compteur le plus visible du profil » : c'est
     donc ce compteur-là qu'il doit suivre.

     `total` est le nombre d'épisodes de l'œuvre. Quand il est inconnu (série en
     cours, liste importée sans métadonnées), une relecture vaut ce qui a été vu
     — on ne peut pas inventer mieux, et c'est la même borne qu'AniList prend. */
  for (const e of entries) {
    const times = Math.max(0, Math.floor(e.repeat ?? 0));
    if (!times) continue;
    const per = Math.max(0, Math.floor(e.total ?? e.progress ?? 0));
    episodeCount += times * per;
  }

  /* ET MÊME AINSI, IL RESTAIT UN ÉCART. Le compteur du profil vient d'AniList,
     qui ne le calcule pas comme nous et ne le dérive pas de sa propre liste :
     4904 + 291 de relectures = 5195, pour 5261 affichés. Les soixante-six
     manquants n'existent nulle part dans les entrées. La page recopie donc son
     chiffre dans les faits (`noteListCounter`, lib/badges/facts.ts) et il sert
     de PLANCHER : le calcul local reste dessous et gagne quand il est plus
     haut — un épisode lu ici il y a trois secondes n'est pas encore chez eux. */
  episodeCount = Math.max(episodeCount, s.facts.counters.listEpisodes?.n ?? 0);

  /* Les MINUTES suivent la même logique, sans jamais inventer une durée. Ce qui
     a été lu ici est mesuré (durée réelle du fichier) ; les épisodes vus
     ailleurs comptent la durée d'épisode qu'AniList donne pour l'œuvre, et rien
     du tout quand elle est inconnue. Un badge de temps qui resterait à zéro
     pour cinq mille épisodes serait aussi faux que le compteur d'épisodes. */
  const localMinutes = watched.reduce((m, w) => m + w.minutes, 0);
  let importedMinutes = 0;
  for (const e of entries) {
    const per = e.duration;
    if (!per || per <= 0) continue;
    const extra = Math.max(0, Math.floor(e.progress || 0) - (perAnime.get(e.mediaId)?.size ?? 0));
    /* Les relectures comptent ici aussi : `minutesWatched` d'AniList les compte,
       et laisser les épisodes les inclure sans les minutes remettrait deux
       chiffres en désaccord — celui qu'on vient justement de réconcilier. */
    const again = Math.max(0, Math.floor(e.repeat ?? 0)) * Math.max(0, Math.floor(e.total ?? e.progress ?? 0));
    importedMinutes += (extra + again) * per;
  }
  const mostRepeats = entries.reduce((m, e) => Math.max(m, e.repeat ?? 0), 0);

  /* ── Les métadonnées, et le contrat du `null` ───────────────────────────────
     Une liste locale ne porte ni genre, ni année, ni studio tant que le
     rattrapage (metaBackfill.ts) n'est pas passé. Un compte à zéro serait un
     CHIFFRE FAUX sur un profil — la règle posée en tête de
     lib/profile/insights.ts. On rend donc `null` quand AUCUNE entrée terminée
     ne porte l'information, et l'interface dit « pas encore mesurable ».

     Quand la couverture est PARTIELLE on mesure quand même, et c'est sans
     risque : tous ces badges demandent « au moins N », donc une couverture
     incomplète ne peut que SOUS-estimer. Elle retarde un badge, elle n'en
     accorde jamais un à tort. */
  const has = (fn: (e: LocalEntry) => unknown) => completed.some((e) => fn(e) != null);
  const hasGenres = completed.some((e) => e.genres?.length);
  const hasTags = completed.some((e) => e.tags?.length);
  const hasYear = has((e) => e.year);
  const hasFormat = has((e) => e.format);
  const hasStudio = has((e) => e.studio);
  const hasPop = has((e) => e.popularity);

  /* Combien d'entrees terminees portent chaque genre / tag : UN balayage,
     construit au premier besoin, au lieu d'un `filter` de toute la liste par
     badge interroge. Une entree compte une fois par nom, meme si son tableau
     le repete — exactement ce que comptait `filter(includes)`. Sert aussi a
     `genresCovered` / `tagsCovered`, qui croisaient chaque nom du vocabulaire
     (~400 tags AniList) avec chaque entree et chacun de ses tags. */
  const tally = (pick: (e: LocalEntry) => string[] | undefined | null) => {
    const counts = new Map<string, number>();
    for (const e of completed) {
      const names = pick(e);
      if (!names?.length) continue;
      for (const n of new Set(names)) counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    return counts;
  };
  let genreTally: Map<string, number> | null = null;
  let tagTally: Map<string, number> | null = null;
  const genreCounts = () => (genreTally ??= tally((e) => e.genres));
  const tagCounts = () => (tagTally ??= tally((e) => e.tags));

  const countGenre = (name: string) =>
    !hasGenres ? null : genreCounts().get(name) ?? 0;
  const countTag = (name: string) =>
    !hasTags ? null : tagCounts().get(name) ?? 0;

  const studioCounts = new Map<string, number>();
  for (const e of completed) {
    if (e.studio) studioCounts.set(e.studio, (studioCounts.get(e.studio) ?? 0) + 1);
  }

  const initials = new Set(completed.flatMap(initialsOf));

  /* LES POINTS DE BINGO : le meilleur score de chaque saison officielle, posé
     par le bloc Bingo sous `bingo:<saison>` (noteListCounter garde le max). */
  let bingoPoints = 0;
  for (const [name, c] of Object.entries(s.facts.counters)) {
    if (name.startsWith("bingo:")) bingoPoints += c.n;
  }
  const longestTitle = completed.reduce((m, e) => Math.max(m, longTitleLength(e)), 0);

  /* ── Les franchises, reconstruites depuis les relations déjà en cache ──────
     Pas d'appel à notre propre base : `relIds` est posé sur l'entrée par la
     même requête AniList qui apporte les genres. On regroupe les entrées par
     composante connexe — une franchise est un ensemble de titres reliés — puis
     on demande si TOUS ses membres présents dans la liste sont terminés. */
  const franchises = hasRelations(entries) ? completedFranchises(entries, FINISHED) : null;

  /* ── Les faits ──────────────────────────────────────────────────────────── */
  const hostSet = new Set(s.facts.hosts.filter((h) => s.displayedHosts.includes(h)));
  const opSkipped = new Set(s.facts.opSkipped);
  /* « Jamais l'opening » : un anime terminé dont AUCUN épisode connu n'a vu son
     opening sauté. On exige au moins un épisode enregistré, sans quoi un anime
     importé — dont on n'a regardé aucun épisode ici — donnerait le badge. */
  const neverSkippedIds = new Set<number>();
  for (const e of completed) {
    /* TOUS les épisodes lus ici : avec un seul, « jamais » ne prouve rien. */
    const eps = perAnime.get(e.mediaId);
    const total = e.total ?? 0;
    if (!eps || total < 1) continue;
    let ok = true;
    for (let i = 1; i <= total && ok; i++) {
      ok = eps.has(String(i)) && !opSkipped.has(`${e.mediaId}:${i}`);
    }
    if (ok) neverSkippedIds.add(e.mediaId);
  }

  /* « Spoilé » : le dernier épisode seul. La table ne connaît que ce qui a été lu
     ICI : le fil ne doit montrer aucun autre épisode, et l'anime doit avoir été
     commencé le jour de cette lecture. */
  const onlyLastIds = new Set<number>();
  for (const e of entries) {
    const eps = perAnime.get(e.mediaId);
    const seenAt = lastSeenAt.get(e.mediaId);
    if (!eps || eps.size !== 1 || !seenAt || !e.total || e.total < 2 || !eps.has(String(e.total))) continue;
    if ((feedByAnime.get(e.mediaId) ?? []).some((r) => r.ep !== e.total)) continue;
    const x = new Date(seenAt);
    if (fuzzyDay(e.startedAt) === `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`) onlyLastIds.add(e.mediaId);
  }

  let onDate: Map<string, Set<number>> | null = null;
  return {
    now,
    episodes: episodeCount,
    /* Même plancher que les épisodes, même raison : « Temps » est affiché en
       tête de profil (88,2 j) et vient du `minutesWatched` d'AniList. */
    minutes: Math.max(localMinutes + importedMinutes, s.facts.counters.listMinutes?.n ?? 0),
    stamps,
    timeline,
    sessionReachedAt: (target, weekend) =>
      sessions.find((r) => r.hours >= target && (!weekend || r.weekend))?.end ?? null,
    sameDayAt,
    onlyLastIds,
    neverSkippedIds,
    hasFeed: s.feedEvents !== undefined,
    onAirByAnime,
    onAirStamps,
    finalOnAir,
    finalOnAirAt: finalOnAir.size ? Math.min(...finalOnAir.values()) : null,
    hasAiring: s.airingComplete === true,
    comebackAt,
    days,
    streak: currentRun(days, dayKey(now)),
    bestStreak: longestRun(days),
    perAnime,
    episodesByAnime: perAnimeCount,
    lastSeenAt,
    best24h: bestWindow(stamps, 86_400_000),
    best7d: bestWindow(stamps, 7 * 86_400_000),
    biggestNight,
    longestSession,
    longestWeekendSession,
    /* Les deux formes ne dependent que de l'HEURE locale (cf. inHourWindow) :
       l'ensemble des heures deja calcule suffit, y compris pour une fenetre
       qui traverse minuit. */
    inHours: (from, to) =>
      from <= to
        ? [...hours].some((h) => h >= from && h < to)
        : [...hours].some((h) => h >= from || h < to),
    midnight,
    /* Index « mois-jour -> animes » construit au premier appel, puis relu :
       chaque badge de date reconvertissait toutes les dates. L'ordre des ids
       est celui de la premiere rencontre, comme avant. */
    animeOnDate: (month, day) => {
      if (!onDate) {
        const index = (onDate = new Map<string, Set<number>>());
        const put = (m: number, j: number, id: number) => {
          const k = `${m}-${j}`;
          let set = index.get(k);
          if (!set) index.set(k, (set = new Set()));
          set.add(id);
        };
        for (const w of timeline) {
          const md = monthDay(w.at);
          put(md.month, md.day, w.aniId);
        }
        /* Les dates de la liste comptent aussi : un anime commencé ou fini le
           31 octobre sur AniList ou MAL n'a aucune trace de lecture ici. */
        for (const e of entries) {
          for (const f of [e.startedAt, e.completedAt]) {
            if (f?.month && f?.day) put(f.month, f.day, e.mediaId);
          }
        }
      }
      return [...(onDate.get(`${month}-${day}`) ?? [])];
    },

    entries,
    completed,
    completedIds: new Set(completed.map((e) => e.mediaId)),
    /* Le chiffre de la liste « Terminé » d'AniList et de Ma liste (185), sans les
       titres en revisionnage que `completed` garde pour les genres, etc. (189). */
    completedCount: completed.filter(isCompletedNow).length,
    seen,
    listSize: entries.length,

    onlyLastEpisode: onlyLastIds.size > 0,

    /* « Liste d'attente » : un titre AJOUTÉ alors qu'il n'est pas encore sorti.
       Les deux statuts se ressemblent et ne parlent pas de la même chose :
       `status` est celui du SPECTATEUR (il prévoit de le voir), `mediaStatus`
       celui de l'ŒUVRE (elle n'est pas diffusée). Le badge demande les deux à
       la fois. */
    planningUnaired: !entries.some((e) => e.mediaStatus)
      ? null
      : entries.some((e) => e.mediaStatus === "NOT_YET_RELEASED"),

    /* « D'une traite » : commencé et terminé le même jour du calendrier LOCAL.
       Les deux dates sont sur l'entrée de liste, posées par le moteur de
       synchro ; une série d'un seul épisode ne compte pas — ce serait un film,
       et le badge parle de dévorer une série. */
    sameDayFinish: sameDayAt.size > 0,
    rated,
    rewatched,
    mostRepeats,
    favourites: s.favourites ? s.favourites.length : null,
    favouriteIds: s.favourites,

    genre: countGenre,
    tag: countTag,
    format: (name) =>
      !hasFormat ? null : completed.filter((e) => e.format === name).length,
    before: (year) =>
      !hasYear ? null : completed.filter((e) => (e.year ?? Infinity) < year).length,
    decades: (from) =>
      !hasYear
        ? null
        : new Set(
            completed
              .map((e) => e.year)
              .filter((y): y is number => !!y && y >= from)
              .map((y) => Math.floor(y / 10)),
          ).size,
    years: (from, to) =>
      !seen.some((e) => e.year != null)
        ? null
        : new Set(
            seen
              .map((e) => e.year)
              .filter((y): y is number => !!y && y >= from && y <= to),
          ).size,
    topStudio: !hasStudio ? null : Math.max(0, ...studioCounts.values()),
    studioNamed: (name) => (!hasStudio ? null : studioCounts.get(name) ?? 0),
    underPopularity: (max) =>
      !hasPop ? null : completed.filter((e) => (e.popularity ?? Infinity) < max).length,
    initials: initials.size,
    bingoPoints,
    longestTitle,
    genresCovered: !s.vocab || !hasGenres
      ? null
      : s.vocab.genres.filter((g) => genreCounts().has(g)).length,
    tagsCovered: !s.vocab || !hasTags
      ? null
      : s.vocab.tags.filter((g) => tagCounts().has(g)).length,
    vocabGenres: s.vocab ? s.vocab.genres.length : null,
    vocabTags: s.vocab ? s.vocab.tags.length : null,
    longestFranchise: franchises ? Math.max(0, ...franchises.map((g) => g.length)) : null,
    franchises,
    vocab: s.vocab,
    displayedHosts: s.displayedHosts,

    facts: s.facts,
    hostsUsed: hostSet.size,
    hostsTotal: s.displayedHosts.length,
    neverSkippedOp: neverSkippedIds.size > 0,
    accountAgeDays:
      s.accountCreatedAt == null
        ? null
        : Math.floor((now - s.accountCreatedAt) / 86_400_000),
    accountCreatedAt: s.accountCreatedAt,

    defs: BY_ID,
    mainCount: MAIN.length,
  };
}

/* ── Franchises ─────────────────────────────────────────────────────────────
   Une franchise est une composante connexe du graphe des relations AniList,
   restreinte aux titres présents dans la liste. Le badge se donne quand TOUS
   les membres présents sont terminés et qu'ils sont assez nombreux.

   « Tous les membres PRÉSENTS », et non « toutes les saisons existantes » :
   nous n'avons pas le catalogue complet d'une franchise sous la main, et
   l'inventer coûterait une requête par franchise. La lecture retenue est donc
   « j'ai terminé tout ce que j'ai de cette saga », ce que le libellé recouvre. */

function hasRelations(entries: LocalEntry[]): boolean {
  return entries.some((e) => e.relIds?.length);
}

function completedFranchises(entries: LocalEntry[], finished: Set<string>): LocalEntry[][] {
  const present = new Set(entries.map((e) => e.mediaId));
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    /* Compression : sans elle, une longue chaîne de suites devient quadratique. */
    let c = x;
    while (c !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const e of entries) parent.set(e.mediaId, e.mediaId);
  for (const e of entries) {
    for (const rel of e.relIds ?? []) if (present.has(rel)) union(e.mediaId, rel);
  }

  const groups = new Map<number, LocalEntry[]>();
  for (const e of entries) {
    const root = find(e.mediaId);
    const g = groups.get(root);
    if (g) g.push(e);
    else groups.set(root, [e]);
  }

  const out: LocalEntry[][] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const allDone = members.every((e) => finished.has(String(e.status ?? "").toUpperCase()));
    if (allDone) out.push(members);
  }
  return out;
}
