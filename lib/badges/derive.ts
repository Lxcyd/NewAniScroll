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
  bestWindow, clusters, currentRun, dayKey, longestRun, hourOf,
  inHourWindow, isMidnightSharp, isWeekend, monthDay, sane,
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
  /** Horodatages des épisodes terminés, sains et triés. */
  stamps: number[];
  /** Jours locaux où au moins un épisode a été terminé. */
  days: Set<string>;
  /** La série de jours qui court en ce moment. */
  streak: number;
  /** La plus longue série jamais tenue. */
  bestStreak: number;
  /** Épisodes terminés par anime. */
  perAnime: Map<number, Set<string>>;
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
  /** Anime terminés (COMPLETED ou REPEATING). */
  completed: LocalEntry[];
  /** Les mêmes, indexés : les 60 badges par titre posent 74 questions
   *  « celui-ci est-il terminé ? » à chaque fin d'épisode. */
  completedIds: Set<number>;
  completedCount: number;
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

  /* ── Métadonnées (null = la liste ne les porte pas encore) ──────────────── */
  /** Anime terminés portant ce genre. `null` si aucun n'a de genres. */
  genre: (name: string) => number | null;
  tag: (name: string) => number | null;
  format: (name: string) => number | null;
  /** Anime terminés sortis avant cette année. */
  before: (year: number) => number | null;
  /** Décennies distinctes couvertes depuis `from`. */
  decades: (from: number) => number | null;
  /** Le studio le mieux représenté, en nombre d'anime terminés. */
  topStudio: number | null;
  /** Anime terminés de ce studio précis. */
  studioNamed: (name: string) => number | null;
  /** Anime terminés vus par moins de `max` personnes. */
  underPopularity: (max: number) => number | null;
  /** Lettres initiales distinctes (A-Z) des anime terminés. */
  initials: number;
  /** Le titre terminé le plus long, en caractères. */
  longestTitle: number;
  /** Genres du catalogue couverts par au moins un anime terminé. */
  genresCovered: number | null;
  tagsCovered: number | null;
  /** Taille du vocabulaire du catalogue — la CIBLE de « tous les genres ». */
  vocabGenres: number | null;
  vocabTags: number | null;
  /** Franchises entièrement terminées, par nombre de saisons. */
  franchiseOf: (minSeasons: number) => number | null;

  /* ── Faits ──────────────────────────────────────────────────────────────── */
  facts: Facts;
  /** Lecteurs distincts utilisés, sur ceux que le site propose. */
  hostsUsed: number;
  hostsTotal: number;
  /** Un anime terminé dont aucun épisode n'a vu son opening sauté. */
  neverSkippedOp: boolean;
  accountAgeDays: number | null;

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

/** Une date floue AniList réduite à son jour, ou `null` si elle est incomplète. */
function fuzzyDay(d: { year: number | null; month: number | null; day: number | null } | null): string | null {
  if (!d?.year || !d?.month || !d?.day) return null;
  return `${d.year}-${d.month}-${d.day}`;
}

/** Le titre d'une entrée, dans l'ordre de préférence habituel. */
function titleOf(e: LocalEntry): string {
  const t = e.title;
  return t?.english || t?.romaji || t?.userPreferred || t?.native || "";
}

export function derive(s: Snapshot): Derived {
  const now = s.now;

  /* ── Un seul balayage de la table de progression ───────────────────────── */
  const watched: Watched[] = [];
  const perAnime = new Map<number, Set<string>>();
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
  }

  const stamps = watched.map((w) => w.at).filter((t) => t > 0).sort((a, b) => a - b);
  const days = new Set(stamps.map((t) => dayKey(t)));

  /* Les séances : une grappe d'activité, pas une date (une soirée qui passe
     minuit reste une soirée — cf. lib/badges/localtime.ts). */
  const runs = clusters(stamps);
  let biggestNight = 0;
  let longestSession = 0;
  let longestWeekendSession = 0;
  for (const run of runs) {
    if (run.length > biggestNight) biggestNight = run.length;
    /* La durée d'une séance est mesurée du premier au dernier épisode, plus la
       durée du dernier : sans ce dernier terme, six épisodes de 24 min lancés
       toutes les 24 min compteraient 2 h 00 au lieu de 2 h 24. */
    const span = (run[run.length - 1] - run[0]) / 3_600_000;
    const tailMinutes = watched.find((w) => w.at === run[run.length - 1])?.minutes ?? 0;
    const hours = span + tailMinutes / 60;
    if (hours > longestSession) longestSession = hours;
    /* Un « marathon de week-end » doit se tenir sur le week-end : on exige que
       les deux bouts de la séance y soient, sinon une séance du vendredi soir
       qui déborde sur samedi 1 h compterait comme un week-end entier. */
    if (isWeekend(run[0]) && isWeekend(run[run.length - 1]) && hours > longestWeekendSession) {
      longestWeekendSession = hours;
    }
  }

  const hours = new Set(stamps.map((t) => hourOf(t)));

  /* ── La liste ───────────────────────────────────────────────────────────── */
  const entries = Object.values(s.list);
  const completed = entries.filter((e) => FINISHED.has(String(e.status ?? "").toUpperCase()));
  const rated = entries.filter((e) => (e.score ?? 0) > 0).length;
  const rewatched = entries.filter((e) => (e.repeat ?? 0) >= 1).length;

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

  const countGenre = (name: string) =>
    !hasGenres ? null : completed.filter((e) => e.genres?.includes(name)).length;
  const countTag = (name: string) =>
    !hasTags ? null : completed.filter((e) => e.tags?.includes(name)).length;

  const studioCounts = new Map<string, number>();
  for (const e of completed) {
    if (e.studio) studioCounts.set(e.studio, (studioCounts.get(e.studio) ?? 0) + 1);
  }

  const initials = new Set(
    completed
      .map((e) => titleOf(e).trim().charAt(0).toUpperCase())
      .filter((c) => c >= "A" && c <= "Z"),
  );
  const longestTitle = completed.reduce((m, e) => Math.max(m, titleOf(e).length), 0);

  /* ── Les franchises, reconstruites depuis les relations déjà en cache ──────
     Pas d'appel à notre propre base : `relIds` est posé sur l'entrée par la
     même requête AniList qui apporte les genres. On regroupe les entrées par
     composante connexe — une franchise est un ensemble de titres reliés — puis
     on demande si TOUS ses membres présents dans la liste sont terminés. */
  const franchiseSizes = hasRelations(entries) ? completedFranchises(entries, FINISHED) : null;

  /* ── Les faits ──────────────────────────────────────────────────────────── */
  const hostSet = new Set(s.facts.hosts.filter((h) => s.displayedHosts.includes(h)));
  const opSkipped = new Set(s.facts.opSkipped);
  /* « Jamais l'opening » : un anime terminé dont AUCUN épisode connu n'a vu son
     opening sauté. On exige au moins un épisode enregistré, sans quoi un anime
     importé — dont on n'a regardé aucun épisode ici — donnerait le badge. */
  const neverSkippedOp = completed.some((e) => {
    const eps = perAnime.get(e.mediaId);
    if (!eps || !eps.size) return false;
    for (const ep of eps) if (opSkipped.has(`${e.mediaId}:${ep}`)) return false;
    return true;
  });

  return {
    now,
    episodes: episodeCount,
    minutes: localMinutes + importedMinutes,
    stamps,
    days,
    streak: currentRun(days, dayKey(now)),
    bestStreak: longestRun(days),
    perAnime,
    best24h: bestWindow(stamps, 86_400_000),
    best7d: bestWindow(stamps, 7 * 86_400_000),
    biggestNight,
    longestSession,
    longestWeekendSession,
    inHours: (from, to) =>
      from <= to
        ? [...hours].some((h) => h >= from && h < to)
        : stamps.some((t) => inHourWindow(t, from, to)),
    midnight: stamps.some((t) => isMidnightSharp(t)),
    animeOnDate: (month, day) => {
      const ids = new Set<number>();
      for (const w of watched) {
        if (!w.at) continue;
        const md = monthDay(w.at);
        if (md.month === month && md.day === day) ids.add(w.aniId);
      }
      return [...ids];
    },

    completed,
    completedIds: new Set(completed.map((e) => e.mediaId)),
    completedCount: completed.length,
    listSize: entries.length,

    /* « Par la fin » : le dernier épisode d'un anime, et aucun autre. On lit la
       table de progression, pas la liste — c'est le seul endroit qui sache
       QUELS épisodes ont été vus, là où la liste ne connaît qu'un compteur.
       Il faut connaître le total, sans quoi « le dernier » n'a pas de sens. */
    onlyLastEpisode: entries.some((e) => {
      const eps = perAnime.get(e.mediaId);
      if (!eps || eps.size !== 1 || !e.total || e.total < 2) return false;
      return eps.has(String(e.total));
    }),

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
    sameDayFinish: completed.some((e) => {
      const a = fuzzyDay(e.startedAt);
      const b = fuzzyDay(e.completedAt);
      return !!a && a === b && (e.total ?? 0) > 1;
    }),
    rated,
    rewatched,
    mostRepeats,
    favourites: s.favourites ? s.favourites.length : null,

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
    topStudio: !hasStudio ? null : Math.max(0, ...studioCounts.values()),
    studioNamed: (name) => (!hasStudio ? null : studioCounts.get(name) ?? 0),
    underPopularity: (max) =>
      !hasPop ? null : completed.filter((e) => (e.popularity ?? Infinity) < max).length,
    initials: initials.size,
    longestTitle,
    genresCovered: !s.vocab || !hasGenres
      ? null
      : s.vocab.genres.filter((g) => completed.some((e) => e.genres?.includes(g))).length,
    tagsCovered: !s.vocab || !hasTags
      ? null
      : s.vocab.tags.filter((g) => completed.some((e) => e.tags?.includes(g))).length,
    vocabGenres: s.vocab ? s.vocab.genres.length : null,
    vocabTags: s.vocab ? s.vocab.tags.length : null,
    franchiseOf: (minSeasons) =>
      franchiseSizes == null ? null : franchiseSizes.filter((n) => n >= minSeasons).length,

    facts: s.facts,
    hostsUsed: hostSet.size,
    hostsTotal: s.displayedHosts.length,
    neverSkippedOp,
    accountAgeDays:
      s.accountCreatedAt == null
        ? null
        : Math.floor((now - s.accountCreatedAt) / 86_400_000),

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

function completedFranchises(entries: LocalEntry[], finished: Set<string>): number[] {
  const present = new Set(entries.map((e) => e.mediaId));
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
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

  const out: number[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const allDone = members.every((e) => finished.has(String(e.status ?? "").toUpperCase()));
    if (allDone) out.push(members.length);
  }
  return out;
}
