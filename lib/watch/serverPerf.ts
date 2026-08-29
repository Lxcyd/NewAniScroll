/**
 * Score de performance MESURE par lecteur (local, par appareil).
 *
 * `lib/servers.js` porte un rang `speed: 1..5` ecrit a la main, deduit de
 * l'architecture de livraison et non de la mesure. Il est faux au moins une
 * fois : uqload y est dernier (speed 5) alors qu'il seek plus vite que la
 * plupart. Ce module apprend, a travers les sessions, quel hote sert le mieux
 * CET appareil, et rend un rang utilisable partout ou `speed` l'etait.
 *
 * Quatre criteres, tous mesurables sur TOUS les hotes via le <video> qu'on
 * possede (toutes les entrees de lib/servers.js sont `type:"api"`) :
 *
 *   t  demarrage — ms entre le commit du src et le premier `canPlay`
 *   s  stabilite — secondes stallees par 60 s de lecture
 *   k  seek      — ms d'un seek RESEAU (cible hors de video.buffered)
 *   q  qualite   — hauteur video max reellement servie, en px
 *
 * On stocke les valeurs BRUTES, jamais normalisees : re-regler les seuils plus
 * tard ne bumpe alors aucun schema et ne detruit aucun historique.
 *
 * Deux regles portent tout l'edifice :
 *
 *  1. On n'IMPUTE jamais. Un critere sans echantillon ne contribue ni valeur ni
 *     penalite. Un hote qui ne peut pas produire un signal ne doit pas etre
 *     classe dernier pour son silence.
 *  2. On RENORMALISE sur les criteres presents, ponderes par leur confiance.
 *     Un hote qui ne fournit que t+s+q est note sur 0,80 de la masse de poids,
 *     ramenee a 100 : il reste sur le meme axe que les autres, il converge
 *     seulement plus lentement — moins de preuves, plus de poids sur le prior.
 *
 * Le rang statique reste le prior et garde toujours au moins 25 % du mot
 * (CONF_CAP) : deux echantillons chanceux ne couronnent pas un hote fragile.
 *
 * Store vide => C = 0 => `final` vaut exactement `staticScore`, transformee
 * strictement monotone de `speed`. Le tri etant stable (ES2019), l'ordre rendu
 * est alors la MEME permutation qu'aujourd'hui, ex aequo compris. C'est la
 * garantie « pas de mesure enregistree = comportement historique inchange ».
 *
 * Rien ici ne touche au reseau : aucune requete ajoutee, aucune commande Redis.
 */

import { useEffect, useState } from "react";
import SERVERS from "@/lib/servers";

const KEY = "aniscroll:serverPerf";
const ENABLED_KEY = "aniscroll:serverPerf:enabled";
export const SERVER_PERF_EVENT = "aniscroll:serverPerf:change";

/**
 * Ne bump CETTE version que si la DEFINITION d'une unite change (ex: `s` qui
 * passerait de s/min a un ratio). Re-regler une ancre ou un poids ne la touche
 * pas — c'est tout l'interet de stocker du brut. Une version differente est
 * traitee comme un store vide, sans migration (meme posture que le garde de
 * version scelle de lib/db/playerMap.ts).
 */
const SCHEMA_VERSION = 1;

export type Crit = "t" | "s" | "k" | "q";
export type Tier = "fast" | "medium" | "slow";

/** [ewma, n, lastDay] — lastDay en jours depuis epoch, pour garder le JSON court. */
type Entry = [number, number, number];
type ServerEntry = Partial<Record<Crit, Entry>>;
type Store = { v: number; s: Record<string, ServerEntry> };

const CRITS: Crit[] = ["t", "s", "k", "q"];

/**
 * Poids relatifs. Le stall pese le plus : c'est la seule degradation que
 * l'utilisateur ne peut pas contourner. Le demarrage suit — c'est la premiere
 * impression, et c'est precisement ce que le choix du lecteur par defaut
 * controle. La qualite pese le moins : quasi constante par hote, elle ne fait
 * que departager.
 */
const W: Record<Crit, number> = { t: 0.3, s: 0.35, k: 0.2, q: 0.15 };
const TOTAL_W = CRITS.reduce((sum, c) => sum + W[c], 0);

/**
 * Nombre d'observations au-dela duquel un critere compte a plein. Le seek est
 * le signal le plus bruite (il depend de OU l'utilisateur a saute), la qualite
 * le plus stable — une seule lecture la renseigne deja.
 */
const MIN_N: Record<Crit, number> = { t: 3, s: 2, k: 5, q: 1 };

/** Bornes anti-aberration, appliquees a la SAISIE. */
const CLAMP: Record<Crit, [number, number]> = {
  t: [1, 15000],
  s: [0, 60],
  k: [1, 10000],
  q: [0, 4320],
};

/** Le recent domine, mais un mauvais episode ne renverse pas un verdict. */
const ALPHA = 0.3;
/** Demi-vie appliquee a `n` A LA LECTURE : un verdict vieux s'efface tout seul. */
const HALF_LIFE_DAYS = 14;
/** Au-dela, l'entree est purgee a la relecture. */
const MAX_AGE_DAYS = 90;
/** Part minimale que le prior statique conserve, toujours. */
const CONF_CAP = 0.75;
/** En dessous, on n'ose pas afficher un poincon « mesure ». */
const TIER_MIN_CONF = 0.5;
/** localStorage.setItem est synchrone : jamais dans une boucle de lecture. */
const FLUSH_MS = 30_000;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const today = () => Math.floor(Date.now() / 86_400_000);

/* ── Normalisation : 0..100, ancres ABSOLUES ────────────────────────────────
 *
 * Absolues et non relatives aux autres hotes : une echelle relative se casse
 * des qu'un hote ne fournit qu'un sous-ensemble des criteres, puisqu'on
 * classerait alors dans une population differente selon le critere.
 *
 * Log pour les latences — 800→1600 ms se ressent comme 1600→3200. Lineaire
 * pour le stall, dont le cout est vecu proportionnellement au temps perdu.
 */
const LOG_T = Math.log(6000 / 800);
const LOG_K = Math.log(4000 / 400);

function goodness(c: Crit, v: number): number {
  switch (c) {
    case "t": // 100 a <=800 ms, 0 a >=6 s
      return 100 * clamp01(Math.log(6000 / Math.max(1, v)) / LOG_T);
    case "s": // 100 a 0, 0 a >=6 s/min (soit 10 % de rebuffer)
      return 100 * clamp01(1 - v / 6);
    case "k": // 100 a <=400 ms, 0 a >=4 s
      return 100 * clamp01(Math.log(4000 / Math.max(1, v)) / LOG_K);
    case "q": // 360p → 0, 720p → 50, 1080p et plus → 100
      return 100 * clamp01((v - 360) / (1080 - 360));
  }
}

/* ── Stockage ──────────────────────────────────────────────────────────────
 *
 * Borne structurelle : ~11 hotes x 4 criteres x 3 nombres, soit ~1,2 Ko au
 * pire. Pas de LRU — la machinerie MAX=200 de lib/prefs/animeServerPref.ts
 * n'a rien a faire ici.
 */

const isKnownServer = (id: string) =>
  (SERVERS as { id: string }[]).some((s) => s.id === id);

const EMPTY: Store = { v: SCHEMA_VERSION, s: {} };

function isEntry(e: unknown): e is Entry {
  return (
    Array.isArray(e) &&
    e.length === 3 &&
    e.every((n) => typeof n === "number" && isFinite(n))
  );
}

/**
 * Relit et ASSAINIT : version etrangere, ids retires (ceux de lib/servers.js
 * bougent souvent, cf. le long commentaire de lib/prefs/serverPref.ts) et
 * entrees perimees disparaissent. Ne reecrit rien — le prochain flush s'en
 * charge.
 */
function read(): Store {
  if (typeof window === "undefined") return { v: SCHEMA_VERSION, s: {} };
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return { v: SCHEMA_VERSION, s: {} };
    if (parsed.v !== SCHEMA_VERSION) return { v: SCHEMA_VERSION, s: {} };
    const src = parsed.s && typeof parsed.s === "object" ? parsed.s : {};
    const day = today();
    const out: Store["s"] = {};
    for (const id of Object.keys(src)) {
      if (!isKnownServer(id)) continue;
      const kept: ServerEntry = {};
      for (const c of CRITS) {
        const e = src[id]?.[c];
        if (!isEntry(e)) continue;
        if (day - e[2] > MAX_AGE_DAYS) continue;
        kept[c] = e;
      }
      if (Object.keys(kept).length) out[id] = kept;
    }
    return { v: SCHEMA_VERSION, s: out };
  } catch {
    return { v: SCHEMA_VERSION, s: {} };
  }
}

/**
 * Miroir en memoire. Charge paresseusement, puis mute et flush par lots.
 *
 * Consequence assumee : deux onglets qui lisent EN MEME TEMPS, le dernier a
 * flusher gagne. Fusionner couterait un re-read a chaque flush pour un cas
 * marginal, et le prix d'une perte est quelques echantillons — pas un reglage
 * utilisateur.
 */
let mirror: Store | null = null;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function store(): Store {
  if (!mirror) mirror = read();
  return mirror;
}

function flush(): void {
  if (!dirty || !mirror || typeof window === "undefined") return;
  dirty = false;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    window.localStorage.setItem(KEY, JSON.stringify(mirror));
  } catch {
    /* best-effort (quota, navigation privee) */
  }
}

function scheduleFlush(): void {
  dirty = true;
  if (flushTimer || typeof window === "undefined") return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_MS);
}

/* ── Session ───────────────────────────────────────────────────────────────
 *
 * Une session = (serverId, aniId, episode). Un critere n'y depose QU'UN
 * echantillon : sans cette regle, un episode de 24 min empilerait une dizaine
 * de lectures du meme stall et `n` cesserait de signifier « observations
 * independantes ». Les valeurs brutes sont donc mises en attente pendant la
 * session, puis reduites a leur MEDIANE au moment du commit.
 */

const PENDING_MAX = 5;

let sessionKey = "";
let sessionServer = "";
let pending: Partial<Record<Crit, number[]>> = {};
let listenersBound = false;

function bindLifecycle(): void {
  if (listenersBound || typeof window === "undefined") return;
  listenersBound = true;
  // Un onglet mis en arriere-plan peut ne jamais recevoir `unload` : `pagehide`
  // et `visibilitychange` sont les deux seuls signaux fiables pour poser ce
  // qu'on a mesure avant que la page ne parte.
  const settle = () => {
    commitSession();
    flush();
  };
  window.addEventListener("pagehide", settle);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") settle();
  });
}

function median(values: number[]): number {
  const v = values.slice().sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Appele juste avant que la session ne se referme, quelle qu'en soit la cause
 * (changement d'episode, de lecteur, onglet cache, page quittee).
 *
 * Certaines mesures ne sont pas des evenements mais des ACCUMULATEURS — le
 * stall se compte sur toute la duree de lecture, la qualite est un maximum
 * observe. Elles n'ont de valeur qu'a la fin, et sans ce point d'ancrage il
 * faudrait que le producteur devine par lui-meme tous les chemins de sortie,
 * en s'ordonnant correctement avec ceux d'ici.
 */
let finalizer: (() => void) | null = null;

export function onSessionEnd(fn: () => void): void {
  finalizer = fn;
}

/**
 * Retrait IDENTITAIRE : rien ne garantit qu'un composant soit demonte avant que
 * son remplacant ne soit monte. Un retrait aveugle effacerait alors le
 * finaliseur du nouveau, et ses accumulateurs ne seraient jamais poses.
 */
export function offSessionEnd(fn: () => void): void {
  if (finalizer === fn) finalizer = null;
}

/** Replie les echantillons en attente dans le store, un par critere. */
export function commitSession(): void {
  try {
    // Depose ses derniers echantillons dans `pending` — donc AVANT sa lecture.
    finalizer?.();
  } catch {
    /* une mesure ne doit jamais casser une lecture */
  }
  const id = sessionServer;
  const p = pending;
  pending = {};
  if (!id || !isKnownServer(id)) return;
  const day = today();
  const bucket = (store().s[id] ||= {});
  let wrote = false;
  for (const c of CRITS) {
    const vals = p[c];
    if (!vals || !vals.length) continue;
    const v = median(vals);
    const prev = bucket[c];
    bucket[c] = prev
      ? [prev[0] + ALPHA * (v - prev[0]), prev[1] + 1, day]
      : [v, 1, day];
    wrote = true;
  }
  if (!wrote) return;
  scheduleFlush();
  // Reveille les affichages (chiffre du chip, tableau des Reglages). Sans ca le
  // score reste fige sur ce qu'il valait a l'ouverture de la page, et regarder
  // un episode ne changerait visiblement rien.
  try {
    window.dispatchEvent(new CustomEvent(SERVER_PERF_EVENT));
  } catch {
    /* best-effort */
  }
}

/**
 * Ouvre une session de mesure. Appelee au (re)demarrage d'une lecture ; commit
 * la precedente au passage. Une cle identique est un no-op, pour pouvoir
 * l'appeler depuis un effet sans se soucier des re-rendus.
 */
export function beginSession(
  serverId: string,
  aniId: string | number | null | undefined,
  episode: string | number | null | undefined,
): void {
  if (typeof window === "undefined") return;
  const key = `${serverId}|${aniId ?? ""}|${episode ?? ""}`;
  if (key === sessionKey) return;
  commitSession();
  sessionKey = key;
  sessionServer = serverId || "";
  pending = {};
  bindLifecycle();
}

/**
 * Depose une mesure brute pour la session courante. Appelable a chaud : c'est
 * un push dans un tableau borne, aucun acces localStorage.
 */
export function recordSample(c: Crit, value: number): void {
  if (!sessionServer || typeof value !== "number" || !isFinite(value)) return;
  if (!isServerPerfEnabled()) return;
  // Un onglet en arriere-plan throttle ses timers : la mesure y serait un
  // artefact du navigateur, pas une propriete de l'hote.
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    return;
  }
  const [lo, hi] = CLAMP[c];
  const v = value < lo ? lo : value > hi ? hi : value;
  const arr = (pending[c] ||= []);
  if (arr.length >= PENDING_MAX) return;
  arr.push(v);
}

/* ── Lecture : score, rang, poincon ────────────────────────────────────────
 *
 * Tout est SYNCHRONE et au niveau module, sans React : `pickServerForLangs`
 * est aussi appele depuis pages/en/anime/[...id].tsx, hors du watch provider.
 */

export type ServerScore = {
  /** Score fusionne 0..100 (plus haut = meilleur). */
  final: number;
  /** Score purement mesure, ou null si aucun critere n'a d'echantillon. */
  measured: number | null;
  /** Confiance globale 0..1 : masse de poids effectivement couverte. */
  C: number;
};

/** speed 1 → 100 … speed 5 → 20. Espacement de 20 points entre deux rangs. */
function staticScore(speed: number | undefined): number {
  // `?? 99` et non `?? 5` : c'est la convention de lib/prefs/langPref.ts, et la
  // conserver garantit qu'un serveur sans `speed` reste classe dernier, comme
  // aujourd'hui.
  return 100 - ((speed ?? 99) - 1) * 20;
}

export function getServerScore(
  serverId: string,
  speed?: number,
): ServerScore {
  const sp = speed ?? (SERVERS as { id: string; speed?: number }[]).find(
    (s) => s.id === serverId,
  )?.speed;
  const base = staticScore(sp);
  if (typeof window === "undefined" || !isServerPerfEnabled()) {
    return { final: base, measured: null, C: 0 };
  }
  const entry = store().s[serverId];
  if (!entry) return { final: base, measured: null, C: 0 };

  const day = today();
  let num = 0;
  let den = 0;
  for (const c of CRITS) {
    const e = entry[c];
    if (!e) continue; // absent = non mesure : ni valeur, ni penalite
    // Deux facteurs SEPARES : combien de preuve, et a quel point elle est
    // fraiche. Les replier en un seul (decroitre `n` puis diviser par MIN_N)
    // laissait un critere a faible MIN_N — la qualite, MIN_N = 1 — rester a
    // confiance PLEINE pendant des mois : il aurait fallu que `n` decroisse
    // sous 1 pour que la demi-vie morde, soit 4 demi-vies depuis n = 20. Un
    // seul critere suffisait alors a maintenir en vie un verdict perime.
    const evidence = Math.min(1, e[1] / MIN_N[c]);
    const freshness = Math.pow(0.5, Math.max(0, day - e[2]) / HALF_LIFE_DAYS);
    const conf = evidence * freshness;
    if (conf <= 0) continue;
    const w = W[c] * conf;
    num += w * goodness(c, e[0]);
    den += w;
  }
  if (den <= 0) return { final: base, measured: null, C: 0 };

  const measured = num / den; // renormalise sur les seuls criteres presents
  const C = den / TOTAL_W;
  const cEff = Math.min(C, CONF_CAP);
  return { final: cEff * measured + (1 - cEff) * base, measured, C };
}

/**
 * Rang au sens de `pickServerForLangs` / `getServersByLang` : PLUS BAS =
 * MEILLEUR, comme le `speed` qu'il remplace. Store vide => (speed - 1) * 20,
 * strictement monotone en `speed` : meme ordre qu'aujourd'hui.
 */
export function serverPerfRank(server: { id: string; speed?: number }): number {
  return 100 - getServerScore(server.id, server.speed).final;
}

/* ── Le rang FIGE ──────────────────────────────────────────────────────────
 *
 * Le classement doit etre arrete AU LANCEMENT DE LA PAGE, puis ne plus bouger.
 *
 * Il bougeait : `commitSession()` emet `SERVER_PERF_EVENT` a chaque fin de
 * session de mesure, tous les abonnes se re-rendaient, et `serverPerfRank`
 * relisant localStorage a chaque appel, la rangee de chips se RETRIAIT sous les
 * yeux — parfois en cours de lecture. Signale le 30/08/2026 : « un lecteur
 * change de positionnement s'il est plus rapide ».
 *
 * Une barre de choix se lit autant a la position qu'au nom : on y revient par
 * reflexe, sans relire. Un ordre qui bouge tout seul detruit ce reflexe, et
 * apprendre en direct ne vaut pas ce prix — les mesures de cette page servent a
 * la SUIVANTE, ce qui suffit amplement.
 *
 * L'instantane est pris a la premiere demande et garde jusqu'au rechargement.
 * Il couvre toute la navigation interne, ce qui est encore plus stable : passer
 * a l'episode suivant ne redistribue pas les chips.
 */
let rangGele: Record<string, number> | null = null;

/** A appeler quand les mesures sont remises a zero ou l'option basculee : ce
 *  sont les deux seuls cas ou l'utilisateur ATTEND que l'ordre change. */
export function degelerRang(): void {
  rangGele = null;
}

export function serverPerfRankFrozen(server: {
  id: string;
  speed?: number;
}): number {
  const statique = (server.speed ?? 99) * 20;
  if (typeof window === "undefined") return statique;
  if (!rangGele) {
    const snap: Record<string, number> = {};
    for (const s of SERVERS as { id: string; speed?: number }[]) {
      snap[s.id] = serverPerfRank(s);
    }
    rangGele = snap;
  }
  return rangGele[server.id] ?? statique;
}

/**
 * Poincon d'un score deja calcule, ou null tant qu'on n'a pas de quoi
 * l'affirmer. Les seuils collent a `staticTier` de serverSelector.js par
 * construction : speed <= 2 vaut un score >= 80, speed <= 4 un score >= 40.
 */
export function tierOf({ C, final }: ServerScore): Tier | null {
  if (C < TIER_MIN_CONF) return null;
  return final >= 80 ? "fast" : final >= 40 ? "medium" : "slow";
}

export function serverPerfTier(serverId: string): Tier | null {
  return tierOf(getServerScore(serverId));
}

/**
 * Les scores de TOUS les lecteurs, lus APRES le montage.
 *
 * `getServerScore` touche localStorage : appele pendant le rendu, il rendrait
 * le score statique au SSR et le score appris au client, donc une erreur
 * d'hydratation. Meme parade que les autres prefs du projet (cf.
 * `useServerPref`) — le premier rendu client est identique au serveur, l'effet
 * reveille ensuite.
 *
 * Un seul balayage sert a la fois le chiffre affiche et le palier du poincon :
 * les deux doivent de toute facon parler du meme score.
 */
export function useServerPerfScores(): Record<string, ServerScore> {
  const [scores, setScores] = useState<Record<string, ServerScore>>({});
  useEffect(() => {
    const sync = () => {
      const next: Record<string, ServerScore> = {};
      for (const s of SERVERS as { id: string; speed?: number }[]) {
        next[s.id] = getServerScore(s.id, s.speed);
      }
      setScores(next);
    };
    sync();
    window.addEventListener(SERVER_PERF_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(SERVER_PERF_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return scores;
}

/**
 * Le rang mesure, mais seulement APRES le montage.
 *
 * Reordonner une liste pendant le rendu change l'ORDRE DU DOM entre le serveur
 * et le client : c'est une erreur d'hydratation, pas un simple ecart d'attribut.
 * Avant le montage on rend donc le rang statique — exactement ce que le serveur
 * a rendu — et l'effet bascule ensuite sur les mesures.
 *
 * En pratique la bascule ne se voit pas : un chip n'apparait qu'une fois son
 * lecteur confirme, ce qui se decide cote client apres sondage, donc l'ordre
 * definitif est en place bien avant qu'il y ait plusieurs chips a ordonner.
 *
 * UNE SEULE bascule, et plus jamais ensuite : le hook ne s'abonne plus a
 * `SERVER_PERF_EVENT`. C'etait cet abonnement qui retriait la rangee a chaque
 * fin de session de mesure. Voir `serverPerfRankFrozen`.
 */
export function useServerPerfRank(): (s: { id: string; speed?: number }) => number {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return ready ? serverPerfRankFrozen : (s) => s.speed ?? 99;
}

/* ── Interrupteur et remise a zero (Reglages) ──────────────────────────────
 * Meme forme evenement/hook que les autres prefs pour que l'UI reste vivante.
 */

/**
 * Memoise : `serverPerfRank` est appele une fois par serveur a chaque tri, et
 * localStorage.getItem est un acces synchrone au thread principal. Invalide par
 * l'evenement local et par `storage` (autre onglet) — voir plus bas.
 */
let enabledCache: boolean | null = null;

export function isServerPerfEnabled(): boolean {
  if (typeof window === "undefined") return true;
  if (enabledCache !== null) return enabledCache;
  try {
    // Absent = allume, sinon la fonctionnalite naitrait desactivee.
    enabledCache = window.localStorage.getItem(ENABLED_KEY) !== "0";
  } catch {
    enabledCache = true;
  }
  return enabledCache;
}

export function setServerPerfEnabled(on: boolean): void {
  if (typeof window === "undefined") return;
  enabledCache = on;
  degelerRang();
  try {
    if (on) window.localStorage.removeItem(ENABLED_KEY);
    else window.localStorage.setItem(ENABLED_KEY, "0");
  } catch {
    /* best-effort */
  }
  window.dispatchEvent(new CustomEvent(SERVER_PERF_EVENT));
}

export function useServerPerfEnabled(): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const sync = () => setOn(isServerPerfEnabled());
    sync();
    window.addEventListener(SERVER_PERF_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(SERVER_PERF_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return on;
}

/** Oublie toutes les mesures. Le rang retombe sur `speed`. */
export function clearServerPerf(): void {
  if (typeof window === "undefined") return;
  degelerRang();
  mirror = { v: SCHEMA_VERSION, s: {} };
  pending = {};
  dirty = false;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* best-effort */
  }
  window.dispatchEvent(new CustomEvent(SERVER_PERF_EVENT));
}

/** Tous les scores courants, pour la page Reglages et le debug. */
export function dumpServerPerf(): Array<
  { id: string; speed?: number } & ServerScore & { raw: ServerEntry | null }
> {
  return (SERVERS as { id: string; speed?: number }[]).map((s) => ({
    id: s.id,
    speed: s.speed,
    ...getServerScore(s.id, s.speed),
    raw: (typeof window !== "undefined" && store().s[s.id]) || null,
  }));
}

/* ── Poignee de debug ──────────────────────────────────────────────────────
 * Hors du domaine de prod uniquement : la preview (dev.aniscroll.com) est un
 * build de production, donc NODE_ENV ne suffit pas a la distinguer — et c'est
 * precisement la que se font les tests navigateur de ce projet.
 */
if (typeof window !== "undefined") {
  const invalidate = () => {
    enabledCache = null;
  };
  window.addEventListener(SERVER_PERF_EVENT, invalidate);
  window.addEventListener("storage", invalidate);

  const host = window.location.hostname;
  if (host !== "aniscroll.com" && host !== "www.aniscroll.com") {
    (window as any).__serverPerf = {
      dump: dumpServerPerf,
      clear: clearServerPerf,
      commit: commitSession,
      flush,
      /** Injecte des mesures brutes pour eprouver le modele sans regarder 12 episodes. */
      seed(serverId: string, crits: Partial<Record<Crit, [number, number, number?]>>) {
        const day = today();
        const bucket = (store().s[serverId] ||= {});
        for (const c of CRITS) {
          const v = crits[c];
          if (v) bucket[c] = [v[0], v[1], v[2] ?? day];
        }
        dirty = true;
        flush();
      },
    };
  }
}
