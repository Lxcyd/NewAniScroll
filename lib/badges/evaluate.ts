/**
 * Le passage de l'évaluateur : lire les stores, mesurer, accorder, notifier.
 *
 * ── CE QUE ÇA NE COÛTE PAS ───────────────────────────────────────────────────
 * Rien ne sort du navigateur. Tout le substrat des badges est déjà en
 * localStorage — `aniscroll:progress` porte la durée et l'horodatage de chaque
 * épisode, `aniscroll:localList` le statut et la note de chaque titre — donc un
 * passage complet, c'est un `JSON.parse` et un balayage en mémoire. Zéro requête
 * API, zéro commande Upstash, zéro lecture Turso, zéro invocation de fonction.
 * C'est la décision qui gouverne tout le système, et la raison pour laquelle
 * ajouter un badge ne coûte rien au quota.
 *
 * ── POURQUOI UN RECALCUL COMPLET, ET PAS UN INCRÉMENT ────────────────────────
 * Tenir des compteurs à jour geste par geste serait plus « efficace » et
 * impossible à garder juste : un import de huit cents titres, une synchro
 * AniList, un historique effacé, deux onglets ouverts — chacun est une occasion
 * de désynchroniser le compteur de la réalité, et un compteur faux ne se voit
 * pas. Un balayage de dix mille épisodes prend quelques millisecondes ; on le
 * refait, et il n'y a rien à désynchroniser.
 *
 * C'est aussi ce qui rend l'IMPORT gratuit : `importEntries` n'émet qu'un seul
 * événement pour N titres (lib/list/localList.ts), et comme on recalcule tout,
 * un import de huit cents titres est naturellement une évaluation en lot.
 */

import { DISPLAYED_HOSTS } from "../hostRegistry";
import { getLocalList } from "../list/localList";
import { readProgressMap } from "../watch/progress";
import { BADGES, BY_ID, type BadgeDef } from "./catalog";
import { derive, type Derived, type Snapshot } from "./derive";
import { getFacts } from "./facts";
import { dayKey, sane } from "./localtime";
import { measure } from "./measure";
import { getBadgeState, grant } from "./store";
import { readVocab } from "./metaBackfill";
import { announce } from "./achievementStore";

/** Le compte, quand il y en a un. Posé par le bootstrap, lu à chaque passage. */
let accountCreatedAt: number | null = null;
export function setAccountCreatedAt(at: number | null): void {
  accountCreatedAt = sane(at ?? 0) ?? null;
}

/** Les favoris AniList, quand la session en a mis en cache. */
function readFavourites(): number[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem("aniscroll.favourites");
    if (!raw) return null;
    const ids = JSON.parse(raw)?.ids;
    return Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : null;
  } catch {
    return null;
  }
}

export function snapshot(now = Date.now()): Snapshot {
  return {
    progress: readProgressMap(),
    list: getLocalList(),
    facts: getFacts(),
    favourites: readFavourites(),
    vocab: readVocab(),
    accountCreatedAt,
    displayedHosts: [...DISPLAYED_HOSTS],
    now,
  };
}

/**
 * LA DATE D'OBTENTION, prise sur la meilleure preuve disponible.
 *
 * Au premier passage, une collection accumulée sur deux ans est accordée d'un
 * coup. La dater à l'heure du rattrapage serait un mensonge visible : le profil
 * afficherait « Mille épisodes — aujourd'hui » à côté de mille épisodes vus
 * depuis 2024. On remonte donc à l'horodatage qui a réellement franchi le
 * seuil.
 *
 * Quand aucune preuve ne porte de date — un geste enregistré avant que ce
 * système existe, une liste importée sans horodatage — on rend `now`. C'est le
 * dernier recours, pas le cas normal.
 */
function dateFor(def: BadgeDef, d: Derived): number {
  const m = def.metric;
  const fallback = d.now;

  if (m.k === "flag") return d.facts.flags[String(m.name)] ?? fallback;
  if (m.k === "counter") return d.facts.counters[String(m.name)]?.at ?? fallback;

  /* Les paliers d'épisodes : l'horodatage du n-ième épisode terminé. Les
     horodatages sont triés, donc `stamps[n - 1]` EST le moment du
     franchissement. */
  if (m.k === "count" && m.of === "episodes") {
    return d.stamps[m.n - 1] ?? fallback;
  }
  /* Les paliers de temps : le premier épisode à partir duquel le cumul dépasse
     l'objectif. On refait la somme dans l'ordre chronologique — c'est la seule
     façon de savoir QUAND les dix heures ont été atteintes. */
  if (m.k === "count" && m.of === "minutes") {
    return fallback; // affiné ci-dessous par `minutesCrossing`
  }
  /* Les anime terminés : la date de complétion du n-ième, dans l'ordre. */
  if (m.k === "count" && m.of === "completed") {
    const dates = d.completed
      .map((e) => fuzzyToMs(e.completedAt) ?? e.activityAt ?? e.updatedAt)
      .filter((t): t is number => !!t)
      .sort((a, b) => a - b);
    return dates[m.n - 1] ?? fallback;
  }
  /* Tout le reste : le dernier signe d'activité connu, qui est au pire
     aujourd'hui et au mieux la vraie date. */
  return d.stamps[d.stamps.length - 1] ?? fallback;
}

/** Quand le cumul de minutes a franchi `target`. */
function minutesCrossing(s: Snapshot, target: number, fallback: number): number {
  const rows: { at: number; minutes: number }[] = [];
  for (const [, entry] of Object.entries(s.progress)) {
    if (!entry || entry.duration <= 0) continue;
    if (entry.time < entry.duration - 30) continue;
    const at = sane(entry.updatedAt, s.now);
    if (at) rows.push({ at, minutes: entry.duration / 60 });
  }
  rows.sort((a, b) => a.at - b.at);
  let sum = 0;
  for (const r of rows) {
    sum += r.minutes;
    if (sum >= target) return r.at;
  }
  return fallback;
}

/** `{ year, month, day }` → epoch ms local, `null` si la date est incomplète. */
function fuzzyToMs(d: { year: number | null; month: number | null; day: number | null } | null): number | null {
  if (!d?.year || !d?.month || !d?.day) return null;
  return new Date(d.year, d.month - 1, d.day).getTime();
}

export type EvaluateResult = {
  /** Badges débloqués à ce passage, dans l'ordre du catalogue. */
  unlocked: string[];
  /** Vrai quand ce passage était le rattrapage silencieux. */
  backfill: boolean;
};

/**
 * Un passage complet.
 *
 * `silent` force le mode rattrapage : on accorde sans notifier. C'est le cas du
 * TOUT PREMIER passage — sans lui, quelqu'un qui installe la fonctionnalité
 * avec deux ans d'historique verrait soixante notifications défiler.
 */
export function evaluate(opts?: { silent?: boolean; now?: number }): EvaluateResult {
  if (typeof window === "undefined") return { unlocked: [], backfill: false };

  const state = getBadgeState();
  const backfill = opts?.silent || !state.backfilled;
  const snap = snapshot(opts?.now ?? Date.now());
  const d = derive(snap);

  const earned: { id: string; at: number }[] = [];
  for (const def of BADGES) {
    if (state.got[def.id] != null) continue;
    const p = measure(def, d, state);
    if (!p) continue;
    const [cur, target] = p;
    if (target <= 0 || cur < target) continue;
    const at =
      def.metric.k === "count" && def.metric.of === "minutes"
        ? minutesCrossing(snap, def.metric.n, d.now)
        : dateFor(def, d);
    earned.push({ id: def.id, at: Math.min(at, d.now) });
  }

  const fresh = grant(earned, { backfilled: true });

  /* LA COLLECTION SE REGARDE ELLE-MÊME, donc il faut un second tour.
     « Cinquante badges », « Cinq légendaires » et « Collection complète » se
     mesurent sur l'état des badges : le passage qui débloque le cinquantième ne
     peut pas voir, au moment où il le mesure, que le cinquantième vient de
     tomber. Un seul tour de rattrapage suffit — ces badges-là ne s'alimentent
     que d'eux-mêmes et convergent. */
  if (fresh.length) {
    const after = getBadgeState();
    const d2 = derive(snapshot(snap.now));
    const second: { id: string; at: number }[] = [];
    for (const def of BADGES) {
      if (after.got[def.id] != null) continue;
      if (!SELF_REFERRING.has(def.metric.k)) continue;
      const p = measure(def, d2, after);
      if (p && p[1] > 0 && p[0] >= p[1]) second.push({ id: def.id, at: d2.now });
    }
    if (second.length) fresh.push(...grant(second));
  }

  if (fresh.length && !backfill) {
    /* L'ordre du catalogue plutôt que l'ordre de détection : quand trois badges
       tombent ensemble, ils défilent dans l'ordre où l'onglet les montre. */
    const ordered = BADGES.filter((b) => fresh.includes(b.id)).map((b) => b.id);
    announce(ordered);
  }
  return { unlocked: fresh, backfill };
}

/** Les métriques qui comptent d'autres badges — cf. le second tour ci-dessus. */
const SELF_REFERRING = new Set(["rarityCount", "secretCount", "allBadges"]);

/* ── L'ordonnancement ───────────────────────────────────────────────────────
   Terminer un épisode touche trois stores (progression, liste, historique) et
   émet donc trois événements en rafale. Sans débounce, un seul épisode
   déclencherait trois balayages complets. Deux secondes suffisent à les
   coalescer, et restent sous le débounce de 5 s de la synchro cloud, si bien
   que le badge est écrit AVANT que la catégorie ne parte — et part avec elle,
   dans la même requête. */

const DEBOUNCE_MS = 2000;
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

export function flush(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  try {
    evaluate();
  } catch {
    /* Un badge qui ne se calcule pas ne doit jamais casser la page qui l'a
       déclenché : l'évaluation est un à-côté du visionnage, pas l'inverse. */
  }
}

export function scheduleEvaluate(): void {
  if (typeof window === "undefined") return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, DEBOUNCE_MS);
}

/**
 * Branche l'évaluateur sur ce que le site émet déjà.
 *
 * Aucun store existant n'est modifié : ils annonçaient déjà leurs changements
 * par CustomEvent, exactement comme lib/list/cloudSync.ts s'y abonne. Appelé
 * une fois depuis _app ; un second appel ne fait rien.
 */
export function start(): () => void {
  if (typeof window === "undefined") return () => {};
  if (started) return () => {};
  started = true;

  const on = () => scheduleEvaluate();
  const events = [
    "aniscroll:progress-tick",
    "aniscroll:localList:change",
    "aniscroll:badgeFacts:change",
    "aniscroll:favourites:change",
  ];
  for (const e of events) window.addEventListener(e, on);
  /* Le dernier changement d'une session doit survivre : le débounce mourrait
     avec la page. Même garde que cloudSync. */
  const onLeave = () => flush();
  window.addEventListener("pagehide", onLeave);

  /* Le premier passage est le rattrapage. Il est différé d'un tour de boucle
     pour ne pas peser sur le rendu initial : personne n'attend ses badges à la
     milliseconde, et la page, si. */
  setTimeout(() => flush(), 0);

  started = true;
  return () => {
    for (const e of events) window.removeEventListener(e, on);
    window.removeEventListener("pagehide", onLeave);
    started = false;
  };
}

/** La progression de chaque badge, pour l'onglet. */
export function progressAll(now = Date.now()): {
  d: Derived;
  progress: Map<string, [number, number] | null>;
} {
  const state = getBadgeState();
  const d = derive(snapshot(now));
  const progress = new Map<string, [number, number] | null>();
  for (const def of BADGES) progress.set(def.id, measure(def, d, state));
  return { d, progress };
}

/** Le jour local d'aujourd'hui — réexporté pour les vues qui datent un badge. */
export { dayKey };
export { BY_ID };
