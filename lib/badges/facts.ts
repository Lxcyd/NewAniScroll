/**
 * Les faits qu'aucun store existant ne porte.
 *
 * L'immense majorité des badges se lit dans ce que le site enregistre déjà :
 * `aniscroll:progress`, `aniscroll:localList`, `artplayer_settings`. Restent les
 * GESTES, qui ne laissent aucune trace ailleurs — ouvrir la console, saisir la
 * séquence de touches, terminer un épisode sans mettre pause, tomber trois fois
 * sur la page introuvable.
 *
 * ── DES COMPTEURS, JAMAIS UN JOURNAL ─────────────────────────────────────────
 * La tentation serait d'écrire un événement par geste et de compter ensuite. Ce
 * fichier ne le fait pas, et c'est délibéré : un journal grandit sans borne,
 * part dans la sauvegarde du compte à chaque poussée, et finit par se faire
 * refuser par le plafond de `MAX_PAYLOAD_BYTES` (1 Mo, lib/auth/userData.ts) —
 * emportant avec lui la collection de badges.
 *
 * Donc : des compteurs, des drapeaux, et des ensembles BORNÉS. La taille de ce
 * store est plafonnée par construction, quel que soit l'usage.
 *
 * L'horodatage n'est gardé que là où un badge en a besoin. Un drapeau porte la
 * date à laquelle il a été levé, parce que c'est elle qui datera le badge.
 */

import { sane } from "./localtime";

const KEY = "aniscroll:badgeFacts";
export const FACTS_EVENT = "aniscroll:badgeFacts:change";

/**
 * Combien d'épisodes on retient dans les ensembles par épisode.
 *
 * « Sans une pause » et « Jamais l'opening » se jugent sur des épisodes précis.
 * Garder les 400 derniers suffit largement — aucun de ces badges ne demande
 * plus d'une série — et borne le store à quelques kilo-octets sur un compte qui
 * regarde depuis des années.
 */
const EPISODE_SET_CAP = 400;

export type Facts = {
  v: 1;
  /** Drapeau → date à laquelle il a été levé. Un geste, une fois. */
  flags: Record<string, number>;
  /** Compteur → { n, at } : le total, et quand le dernier est tombé. */
  counters: Record<string, { n: number; at: number }>;
  /** Lecteurs sur lesquels un épisode a été terminé (« Tous les lecteurs »). */
  hosts: string[];
  /** `aniId:ep` terminés sans une seule pause. */
  noPause: string[];
  /** `aniId:ep` dont l'opening a été sauté (« Jamais l'opening », en négatif). */
  opSkipped: string[];
  /** `aniId` dont un épisode a été vu en VO ET en VF. */
  bothLangs: number[];
};

const EMPTY: Facts = {
  v: 1, flags: {}, counters: {}, hosts: [], noPause: [], opSkipped: [], bothLangs: [],
};

const strArray = (v: unknown, cap: number): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(-cap) : [];

function parse(raw: string | null): Facts {
  if (!raw) return EMPTY;
  try {
    const p = JSON.parse(raw) ?? {};
    const flags: Record<string, number> = {};
    for (const [k, at] of Object.entries(p.flags ?? {})) {
      const n = Number(at);
      if (Number.isFinite(n) && n > 0) flags[k] = n;
    }
    const counters: Record<string, { n: number; at: number }> = {};
    for (const [k, v] of Object.entries<any>(p.counters ?? {})) {
      const n = Number(v?.n);
      if (Number.isFinite(n) && n > 0) counters[k] = { n, at: Number(v?.at) || 0 };
    }
    return {
      v: 1,
      flags,
      counters,
      hosts: strArray(p.hosts, 64),
      noPause: strArray(p.noPause, EPISODE_SET_CAP),
      opSkipped: strArray(p.opSkipped, EPISODE_SET_CAP),
      bothLangs: Array.isArray(p.bothLangs)
        ? p.bothLangs.map(Number).filter(Number.isFinite).slice(-EPISODE_SET_CAP)
        : [],
    };
  } catch {
    return EMPTY;
  }
}

export function getFacts(): Facts {
  if (typeof window === "undefined") return EMPTY;
  try {
    return parse(window.localStorage.getItem(KEY));
  } catch {
    return EMPTY;
  }
}

export function parseFacts(raw: string | null): Facts {
  return parse(raw);
}

function write(next: Facts): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* best-effort */
  }
  window.dispatchEvent(new CustomEvent(FACTS_EVENT));
}

/**
 * Applique une modification, et n'écrit QUE si elle change quelque chose.
 *
 * C'est le garde-fou de coût de ce fichier. `recordFlag("settings")` est appelé
 * à chaque ouverture des réglages, `bumpCounter("animeOpened")` à chaque fiche
 * ouverte : sans cette comparaison, chacun de ces appels écrirait le
 * localStorage, émettrait son événement, réveillerait l'évaluateur et
 * marquerait la catégorie sale pour la synchro cloud. Un geste déjà enregistré
 * ne doit rien coûter du tout.
 */
function update(fn: (f: Facts) => Facts): boolean {
  const before = getFacts();
  const after = fn(before);
  if (JSON.stringify(after) === JSON.stringify(before)) return false;
  write(after);
  return true;
}

/** Lève un drapeau, une fois pour toutes. Sans effet s'il l'est déjà. */
export function recordFlag(name: string, at = Date.now()): boolean {
  return update((f) =>
    f.flags[name] != null ? f : { ...f, flags: { ...f.flags, [name]: sane(at) ?? Date.now() } },
  );
}

/**
 * Incrémente un compteur.
 *
 * `once` sert aux compteurs qui doivent compter des CHOSES DISTINCTES et pas des
 * gestes : « ouvrir la fiche de dix anime DIFFÉRENTS » ne se gagne pas en
 * rechargeant dix fois la même page. La clé de distinction est passée par
 * l'appelant et gardée dans un drapeau dédié, ce qui borne aussi les rappels.
 */
export function bumpCounter(name: string, at = Date.now()): boolean {
  return update((f) => {
    const cur = f.counters[name] ?? { n: 0, at: 0 };
    return { ...f, counters: { ...f.counters, [name]: { n: cur.n + 1, at: sane(at) ?? Date.now() } } };
  });
}

/** Ajoute une valeur à un ensemble borné, sans doublon. */
function addTo(key: "hosts" | "noPause" | "opSkipped", value: string, cap: number): boolean {
  return update((f) =>
    f[key].includes(value) ? f : { ...f, [key]: [...f[key], value].slice(-cap) },
  );
}

/** Un épisode a été terminé sur ce lecteur. */
export function recordHost(host: string): boolean {
  if (!host) return false;
  return addTo("hosts", host, 64);
}

/** Un épisode terminé sans une seule pause. */
export function recordNoPause(aniId: number | string, episode: number | string): boolean {
  return addTo("noPause", `${aniId}:${episode}`, EPISODE_SET_CAP);
}

/**
 * L'opening de cet épisode a été sauté.
 *
 * C'est un fait NÉGATIF : il n'ouvre aucun badge, il en ferme un. « Jamais
 * l'opening » se juge en cherchant un anime terminé dont aucun épisode n'est
 * là-dedans. Un ensemble d'exceptions est beaucoup plus petit qu'un ensemble
 * d'openings regardés — on ne stocke donc que ce qui est rare.
 */
export function recordOpSkipped(aniId: number | string, episode: number | string): boolean {
  return addTo("opSkipped", `${aniId}:${episode}`, EPISODE_SET_CAP);
}

/** Un anime dont un épisode a été vu dans les deux langues. */
export function recordBothLangs(aniId: number): boolean {
  if (!Number.isFinite(aniId)) return false;
  return update((f) =>
    f.bothLangs.includes(aniId)
      ? f
      : { ...f, bothLangs: [...f.bothLangs, aniId].slice(-EPISODE_SET_CAP) },
  );
}

/**
 * La trace de langue par épisode, pour repérer le VO puis VF.
 *
 * Volontairement dans `sessionStorage` et PAS dans les faits : c'est une donnée
 * de travail, elle n'a pas à être sauvegardée sur le compte ni à survivre à la
 * session. Seule sa conclusion — l'anime concerné — rejoint les faits.
 */
export function noteLang(aniId: number, episode: number | string, dub: boolean): void {
  if (typeof window === "undefined" || !Number.isFinite(aniId)) return;
  const key = `aniscroll:lang:${aniId}:${episode}`;
  try {
    const seen = window.sessionStorage.getItem(key);
    const mark = dub ? "d" : "s";
    if (!seen) {
      window.sessionStorage.setItem(key, mark);
    } else if (!seen.includes(mark)) {
      window.sessionStorage.setItem(key, seen + mark);
      recordBothLangs(aniId);
    }
  } catch {
    /* sessionStorage indisponible : le badge reste simplement hors de portée */
  }
}
