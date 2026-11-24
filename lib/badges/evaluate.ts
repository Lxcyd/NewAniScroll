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
import { getLocalList, LOCAL_LIST_BULK_EVENT } from "../list/localList";
import { readProgressMap } from "../watch/progress";
import { BADGES, BY_ID, type BadgeDef } from "./catalog";
import { derive, isCompletedNow, type Derived, type Snapshot } from "./derive";
import { clusters, inHourWindow, monthDay } from "./localtime";
import { getFacts } from "./facts";
import { dayKey, sane } from "./localtime";
import { isBonusFormat, measure } from "./measure";
import { applyCorrection, CORRECTION_VERSION, getBadgeState, grant, NO_DATE, REVISED_RULES, type BadgeState } from "./store";
import { readAiring } from "./airingBackfill";
import { readVocab } from "./metaBackfill";
import { announce } from "./achievementStore";

/** Le compte, quand il y en a un. Posé par le bootstrap, lu à chaque passage. */
let accountCreatedAt: number | null = null;
let signedIn = false;
export function setSignedIn(v: boolean): void {
  signedIn = v;
}

export function setAccountCreatedAt(at: number | null): void {
  accountCreatedAt = sane(at ?? 0) ?? null;
}

/** Les favoris AniList, quand le site en a mis en cache. La copie vit dans
 *  `localStorage` depuis le 23/10/2026 (lib/anilist/favouritesCache.ts) : lue
 *  seulement en `sessionStorage`, elle restait introuvable, et le détail des
 *  badges « coup de cœur » ne s'affichait jamais (24/11/2026). */
function readFavourites(): number[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw =
      window.localStorage.getItem("aniscroll.favourites") ?? window.sessionStorage.getItem("aniscroll.favourites");
    if (!raw) return null;
    const ids = JSON.parse(raw)?.ids;
    return Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : null;
  } catch {
    return null;
  }
}

function readFeedHours(): number[] | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const h = JSON.parse(window.localStorage.getItem("aniscroll:anilistFeedHours") || "null");
    return Array.isArray(h) ? h.map(Number).filter(Number.isFinite) : undefined;
  } catch {
    return undefined;
  }
}

/* Relu à chaque passage, reparsé seulement s'il a changé : il peut peser 100 Ko. */
let feedRaw: string | null = null;
let feedParsed: [number, number, number][] | undefined;
function readFeedEvents(): [number, number, number][] | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem("aniscroll:anilistFeedEvents");
    if (raw !== feedRaw) {
      feedRaw = raw;
      const parsed = raw ? JSON.parse(raw) : null;
      feedParsed = Array.isArray(parsed) ? parsed : undefined;
    }
    return feedParsed;
  } catch {
    return undefined;
  }
}

let finsRaw: string | null = null;
let finsParsed: Record<number, number> | undefined;
function readFeedCompletions(): Record<number, number> | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem("aniscroll:anilistFeedCompletions");
    if (raw !== finsRaw) {
      finsRaw = raw;
      const parsed = raw ? JSON.parse(raw) : null;
      finsParsed = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
    }
    return finsParsed;
  } catch {
    return undefined;
  }
}

export function snapshot(now = Date.now()): Snapshot {
  const airing = readAiring();
  return {
    feedHours: readFeedHours(),
    feedEvents: readFeedEvents(),
    feedCompletions: readFeedCompletions(),
    airing: airing?.m,
    airingComplete: airing?.complete,
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
 * Quand aucune preuve ne porte de date — une liste importée sans horodatage —
 * on rend `null` : pas de date affichée plutôt qu'une date inventée (Luc,
 * 24/11/2026). `updatedAt` n'en est pas une, un import le réécrit à « maintenant ».
 */
function dateFor(def: BadgeDef, d: Derived): number | null {
  const m = def.metric;

  /* « Un an déjà » : le jour anniversaire du compte. */
  if (m.k === "accountAge") {
    return accountCreatedAt == null ? null : accountCreatedAt + Number(m.days) * 86_400_000;
  }

  if (m.k === "flag") {
    if (m.name === "comeback" && d.comebackAt != null) return d.comebackAt;
    if (m.name === "dayOne" && d.finalOnAirAt != null) return d.finalOnAirAt;
    const at = d.facts.flags[String(m.name)];
    if (at != null) return at;
    if (m.name !== "oav") return null;
    /* Accorde depuis la liste : la plus ancienne date connue d'un OAV vu. */
    const dates = d.seen
      .filter(isBonusFormat)
      .map((e) => fuzzyToMs(e.completedAt))
      .filter((t): t is number => !!t);
    return dates.length ? Math.min(...dates) : null;
  }
  if (m.k === "counter" && m.name === "onAirDay" && d.onAirStamps[m.n - 1]) return d.onAirStamps[m.n - 1];
  if (m.k === "counter") return d.facts.counters[String(m.name)]?.at ?? null;

  /* Les paliers d'épisodes : l'horodatage du n-ième épisode terminé. Les
     horodatages sont triés, donc `stamps[n - 1]` EST le moment du
     franchissement. */
  if (m.k === "count" && m.of === "episodes") {
    return nthProven(d.stamps, m.n, Math.max(0, d.episodes - d.stamps.length));
  }
  /* Les anime terminés : la date de complétion du n-ième, dans l'ordre. */
  if (m.k === "count" && m.of === "completed") {
    const dates = d.completed
      .filter(isCompletedNow)
      .map((e) => fuzzyToMs(e.completedAt))
      .filter((t): t is number => !!t)
      .sort((a, b) => a - b);
    return nthProven(dates, m.n, Math.max(0, d.completedCount - dates.length));
  }
  /* Les badges de rythme : le moment où le fil ou le site les a franchis. */
  if (m.k === "window") {
    let lo = 0;
    for (let hi = 0; hi < d.stamps.length; hi++) {
      while (d.stamps[hi] - d.stamps[lo] > Number(m.ms)) lo++;
      if (hi - lo + 1 >= m.n) return d.stamps[hi];
    }
    return null;
  }
  if (m.k === "night") return clusters(d.stamps).find((r) => r.length >= m.n)?.[m.n - 1] ?? null;
  if (m.k === "session") return d.sessionReachedAt(m.n, !!m.weekend);
  if (m.k === "hourWindow") {
    return d.stamps.find((t) => inHourWindow(t, Number(m.from), Number(m.to))) ?? null;
  }
  if (m.k === "midnight") {
    return d.stamps.find((t) => {
      const x = new Date(t);
      return x.getHours() === 0 && x.getMinutes() === 0;
    }) ?? null;
  }
  /* Deux badges tiennent à une date écrite dans la liste ou le fil. */
  if (m.k === "sameDayFinish") {
    return d.sameDayAt.size ? Math.min(...d.sameDayAt.values()) : null;
  }
  if (m.k === "onDate") {
    const ok = new Set(
      d.seen.filter((e) => !m.genre || !!e.genres?.includes(String(m.genre))).map((e) => e.mediaId),
    );
    const fromFeed = d.timeline
      .filter((w) => {
        const md = monthDay(w.at);
        return ok.has(w.aniId) && md.month === m.month && md.day === m.day;
      })
      .map((w) => w.at);
    const fromList = d.seen
      .filter((e) => ok.has(e.mediaId))
      .flatMap((e) => [e.startedAt, e.completedAt])
      .filter((f) => f?.month === m.month && f?.day === m.day)
      .map((f) => fuzzyToMs(f))
      .filter((t): t is number => !!t);
    const dates = [...fromFeed, ...fromList];
    return dates.length ? Math.min(...dates) : null;
  }
  /* Tout le reste : aucune preuve. La dernière activité connue parlerait d'autre
     chose que de ce badge. */
  return null;
}

/**
 * La date du n-ième, seulement si elle est CERTAINE. Avec des éléments sans date,
 * le n-ième réel se trouve entre deux rangs : « 1 000 épisodes » n'a de date que
 * si ces deux rangs tombent le même jour.
 */
function nthProven(sorted: number[], n: number, undated: number): number | null {
  const hi = sorted[n - 1];
  if (hi == null) return null;
  if (!undated) return hi;
  const lo = sorted[n - 1 - undated];
  return lo != null && dayKey(lo) === dayKey(hi) ? hi : null;
}

/** Quand le cumul de minutes a franchi `target`, `null` s'il n'est pas daté. */
function minutesCrossing(s: Snapshot, target: number, d: Derived): number | null {
  const rows: { at: number; minutes: number }[] = [];
  for (const [, entry] of Object.entries(s.progress)) {
    if (!entry || entry.duration <= 0) continue;
    if (entry.time < entry.duration - 30) continue;
    const at = sane(entry.updatedAt, s.now);
    if (at) rows.push({ at, minutes: entry.duration / 60 });
  }
  /* Des minutes venues de la liste n'ont pas de date : le cumul daté ment. */
  if (d.minutes > rows.reduce((m, r) => m + r.minutes, 0) + 1) return null;
  rows.sort((a, b) => a.at - b.at);
  let sum = 0;
  for (const r of rows) {
    sum += r.minutes;
    if (sum >= target) return r.at;
  }
  return null;
}

/** `{ year, month, day }` → epoch ms local, `null` si la date est incomplète. */
function fuzzyToMs(d: { year: number | null; month: number | null; day: number | null } | null): number | null {
  if (!d?.year || !d?.month || !d?.day) return null;
  return new Date(d.year, d.month - 1, d.day).getTime();
}

/** Ces badges ont une date vraie par nature : le geste, ou le don. */
const KEEPS_ITS_DATE = new Set(["flag", "counter", "granted", "accountAge"]);
/** Après ce jour, une date vient de la règle actuelle : rien à corriger. */
const REDATE_CUTOFF = Date.UTC(2026, 10, 25);
let lastDataKey = "";

/** Le compte, la liste et le fil sont là — sans compter les dates de diffusion. */
function accountBaseReady(s: Snapshot, d: Derived): boolean {
  if (!d.entries.length) return false;
  /* Connecté : attendre que la copie du compte soit arrivée sur cet appareil. */
  const w = window as Window & { __aniscrollCloudPulled?: boolean };
  if (signedIn && !w.__aniscrollCloudPulled) return false;
  /* Compte AniList lié : attendre son fil, qui seul prouve certaines règles. */
  if (s.facts.flags.anilistLinked != null && s.feedEvents === undefined) return false;
  return !s.feedEvents?.length || s.feedCompletions !== undefined;
}

function accountDataReady(s: Snapshot, d: Derived): boolean {
  /* Un fil sans les dates de diffusion ne peut rien prouver sur « le jour même ». */
  return accountBaseReady(s, d) && (!s.feedEvents?.length || s.airingComplete === true);
}

/** Les règles corrigées qui lisent les dates de diffusion : elles seules les attendent. */
const NEEDS_AIRING = new Set(["day-one"]);

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

  let state = getBadgeState();
  const backfill = opts?.silent || !state.backfilled;
  const snap = snapshot(opts?.now ?? Date.now());
  const d = derive(snap);

  const proofOf = (def: BadgeDef) =>
    def.metric.k === "count" && def.metric.of === "minutes"
      ? minutesCrossing(snap, def.metric.n, d)
      : dateFor(def, d);

  /* UNE FOIS, et seulement quand toutes les données du compte sont là : sur un
     appareil pas encore synchronisé, une liste partielle ferait retirer un badge
     valide ou poserait une date fausse. Les gestes gardent leur date ; tout le
     reste repart de sa preuve. Une mesure indisponible ne retire jamais rien. */
  if ((state.regraded ?? 0) < CORRECTION_VERSION && accountDataReady(snap, d)) {
    const dates: Record<string, number> = {};
    for (const [id, was] of Object.entries(state.got)) {
      const def = BY_ID[id];
      if (!def || KEEPS_ITS_DATE.has(def.metric.k) || was >= REDATE_CUTOFF) continue;
      dates[id] = proofOf(def) ?? NO_DATE;
    }
    const wrong = REVISED_RULES.filter((id) => {
      if (state.got[id] == null) return false;
      const p = measure(BY_ID[id], d, state);
      return !!p && p[0] < p[1];
    });
    applyCorrection(dates, wrong);
    state = getBadgeState();
  } else if ((state.regraded ?? 0) < CORRECTION_VERSION && d.entries.length > 0 && Object.keys(snap.progress).length > 0) {
    /* PLUS D'ATTENTE DU COMPTE NI DU FIL ICI (24/11/2026, 2e passe : rien
       n'avait bougé sur le téléphone de Luc, aucune trace de retrait dans sa
       copie). `accountBaseReady` exige par exemple qu'AUCUNE catégorie de la
       synchro ne soit en conflit — un seul conflit jamais tranché bloquait la
       correction pour toujours. Le retrait est réversible depuis
       `revoked` : si une donnée arrivée plus tard prouve le badge, la boucle
       ci-dessous le rend et efface la marque. Sans le fil, « Spoilé » ne peut
       que PASSER (le fil sert à l'exclure) : il n'est donc jamais retiré à tort
       faute de fil. */
    /* LES DATES DE DIFFUSION PEUVENT NE JAMAIS FINIR (24/11/2026, Luc : « Spoilé »
       et « Jamais sans l'opening » obtenus sur 0 anime). Leur chargement ne
       s'enregistre qu'à la fin, minutes de 429 AniList comprises : sur un
       téléphone qu'on quitte avant, la correction attendait pour toujours. Les
       règles qui ne les lisent pas sont corrigées sans elles ; la correction
       complète (dates et « Jour J ») passera quand elles seront là. */
    const wrong = REVISED_RULES.filter((id) => {
      if (NEEDS_AIRING.has(id) || state.got[id] == null) return false;
      const p = measure(BY_ID[id], d, state);
      return !!p && p[0] < p[1];
    });
    if (wrong.length) {
      applyCorrection({}, wrong, false);
      state = getBadgeState();
    }
  }

  /* Le fil peut arriver après coup : un badge sans date reçoit alors la sienne. */
  const dataKey = `${d.stamps.length}:${d.listSize}`;
  const earned: { id: string; at: number }[] = [];
  for (const def of BADGES) {
    if (state.got[def.id] === NO_DATE && dataKey !== lastDataKey) {
      const at = proofOf(def);
      if (at != null) earned.push({ id: def.id, at: Math.min(at, d.now) });
      continue;
    }
    if (state.got[def.id] != null) continue;
    const p = measure(def, d, state);
    if (!p) continue;
    const [cur, target] = p;
    if (target <= 0 || cur < target) continue;
    const at = proofOf(def);
    /* Sans preuve : gagné à l'instant s'il est annoncé, sinon on ne sait pas. */
    earned.push({ id: def.id, at: Math.min(at ?? (backfill ? NO_DATE : d.now), d.now) });
  }

  lastDataKey = dataKey;
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
      if (p && p[1] > 0 && p[0] >= p[1]) second.push({ id: def.id, at: backfill ? NO_DATE : d2.now });
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

/**
 * LA PROCHAINE ÉVALUATION NE NOTIFIE PAS.
 *
 * Une récompense s'annonce pour un geste qu'on VIENT de faire. Or les données
 * peuvent aussi changer sans que personne n'ait rien fait : `cloudSync.pullAll()`
 * dépose, quelques centaines de millisecondes après l'ouverture, la liste et la
 * progression d'un autre appareil. Sans ce drapeau, arriver sur le site depuis
 * son téléphone annoncerait en rafale tout ce qui a été mérité la semaine
 * précédente devant l'ordinateur.
 *
 * Le critère n'est donc PAS un délai après le chargement — quelqu'un qui reprend
 * un épisode huit secondes après être arrivé mérite sa notification — mais la
 * CAUSE du changement. La synchro lève le drapeau, l'utilisateur non.
 *
 * Ce qu'on découvre en arrivant, on le trouve dans l'onglet ; ce qu'on gagne en
 * regardant, on le voit surgir.
 */
let silenceNext = false;

export function silenceNextEvaluation(): void {
  silenceNext = true;
}

/**
 * UNE PORTÉE silencieuse, et pas seulement « la prochaine ».
 *
 * `silenceNextEvaluation()` ne couvre qu'un passage, ce qui suffit pour une
 * synchro : elle dépose tout d'un coup. Le rattrapage de métadonnées, lui, dure
 * — vingt requêtes espacées pour une liste de mille titres — et chaque lot
 * écrit dans la liste, donc chaque lot réveille l'évaluateur. Un drapeau à
 * usage unique serait consommé par le premier et laisserait les dix-neuf autres
 * annoncer.
 *
 * Et ils ont beaucoup à annoncer : le rattrapage rend d'un seul coup mesurables
 * toutes les familles Genres et Découverte. C'est exactement la rafale qu'on a
 * vue à la première ouverture de l'onglet.
 *
 * Un COMPTEUR et non un booléen, pour que deux portées imbriquées ne se
 * décomptent pas l'une l'autre.
 */
let quiet = 0;

export function beginQuiet(): void {
  quiet += 1;
}
export function endQuiet(): void {
  quiet = Math.max(0, quiet - 1);
}

export function flush(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const silent = silenceNext || quiet > 0;
  silenceNext = false;
  try {
    evaluate(silent ? { silent: true } : undefined);
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

  /* La synchro vient de déposer les données d'un autre appareil : on réévalue
     — ces données peuvent mériter des badges — mais EN SILENCE. */
  const onPull = () => {
    silenceNextEvaluation();
    scheduleEvaluate();
  };
  window.addEventListener("aniscroll:cloudPull", onPull);
  /* Un import : les badges sont accordés, on les trouve dans l'onglet. */
  window.addEventListener(LOCAL_LIST_BULK_EVENT, onPull);
  window.addEventListener("aniscroll:cloudPullDone", onPull);
  /* Le dernier changement d'une session doit survivre : le débounce mourrait
     avec la page. Même garde que cloudSync. */
  const onLeave = () => flush();
  window.addEventListener("pagehide", onLeave);

  /* Le premier passage est le rattrapage, et il est silencieux pour la même
     raison que ceux de la synchro : rien de ce qu'on trouve en arrivant n'a été
     fait à l'instant. Différé d'un tour de boucle pour ne pas peser sur le
     rendu initial — personne n'attend ses badges à la milliseconde, la page si. */
  silenceNextEvaluation();
  setTimeout(() => flush(), 0);

  return () => {
    for (const e of events) window.removeEventListener(e, on);
    window.removeEventListener("aniscroll:cloudPull", onPull);
    window.removeEventListener(LOCAL_LIST_BULK_EVENT, onPull);
    window.removeEventListener("aniscroll:cloudPullDone", onPull);
    window.removeEventListener("pagehide", onLeave);
    started = false;
  };
}

/** La progression de chaque badge, pour l'onglet. */
export function progressAll(now = Date.now(), state: BadgeState = getBadgeState()): {
  d: Derived;
  progress: Map<string, [number, number] | null>;
} {
  const d = derive(snapshot(now));
  const progress = new Map<string, [number, number] | null>();
  for (const def of BADGES) progress.set(def.id, measure(def, d, state));
  return { d, progress };
}

/** Le jour local d'aujourd'hui — réexporté pour les vues qui datent un badge. */
export { dayKey };
export { BY_ID };
