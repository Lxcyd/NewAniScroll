/**
 * Ce que l'utilisateur a débloqué — la seule donnée durable du système.
 *
 * Une clé localStorage, `aniscroll:badges`, sur le patron des autres stores du
 * site (lib/stats/streak.ts, lib/prefs/*) : une lecture/écriture pour tout,
 * un CustomEvent pour prévenir l'onglet courant (l'événement `storage` natif ne
 * se déclenche pas dans l'onglet qui écrit), un hook pour les composants.
 *
 * Tout le reste — la progression, les barres, les paliers — est RECALCULÉ à la
 * demande à partir des stores existants (cf. evaluate.ts). On ne persiste donc
 * qu'un fait par badge : la date à laquelle il a été obtenu.
 *
 * ── LES DEUX INVARIANTS ──────────────────────────────────────────────────────
 *
 * 1. UN BADGE OBTENU NE SE REPERD JAMAIS. Ce module n'expose aucun retrait.
 *    La raison n'est pas la gentillesse : les compteurs peuvent DESCENDRE.
 *    « Effacer l'historique de visionnage » remet `aniscroll:progress` à zéro
 *    (lib/watch/progress.ts), retirer un titre de sa liste baisse le nombre
 *    d'anime terminés, et une synchro AniList qui rapporte moins que le local
 *    en fait autant. Un système qui reprendrait ses badges punirait le ménage.
 *    La récompense porte sur ce qui a été FAIT, pas sur ce qui est encore en
 *    mémoire.
 *
 * 2. LA DATE LA PLUS ANCIENNE GAGNE. À la fusion — deux appareils, une reprise
 *    de compte — on garde `min(a, b)` par id. C'est ce qui rend la fusion
 *    COMMUTATIVE et IDEMPOTENTE : l'ordre dans lequel les appareils se
 *    synchronisent n'a aucune influence sur le résultat, et refusionner ne
 *    change rien. Sans cela, le dernier appareil à se connecter réécrirait la
 *    date d'obtention de toute la collection à aujourd'hui.
 */

import { useEffect, useState } from "react";

const KEY = "aniscroll:badges";
export const BADGES_EVENT = "aniscroll:badges:change";

export type BadgeState = {
  v: 1;
  /** id du badge → date d'obtention (epoch ms). */
  got: Record<string, number>;
  /**
   * Posé à la fin du premier passage de l'évaluateur.
   *
   * Tant qu'il est absent, l'évaluation est un RATTRAPAGE : elle accorde en
   * silence tout ce qui est déjà mérité (une collection accumulée sur deux ans
   * ne doit pas surgir en soixante notifications) et date chaque badge sur la
   * meilleure preuve disponible plutôt que sur l'heure du rattrapage.
   */
  backfilled?: true;
  /**
   * Les dates inventées par les anciens rattrapages ont été retirées (24/11/2026).
   * Une copie sans ce drapeau ne peut plus les réimposer à la fusion.
   */
  redated?: true;
};

const EMPTY: BadgeState = { v: 1, got: {} };

/**
 * « Obtenu, mais on ne sait pas quand » (import d'une liste sans dates). Une
 * valeur et non un champ à part : `got` est lu partout comme « id → nombre »,
 * et l'ancien format de sauvegarde l'accepte tel quel. Ne s'affiche jamais.
 */
export const NO_DATE = 1;

/** La plus ancienne des deux, une vraie date l'emportant toujours sur NO_DATE. */
const earliest = (a: number, b: number) =>
  a === NO_DATE ? b : b === NO_DATE ? a : Math.min(a, b);

function parse(raw: string | null): BadgeState {
  if (!raw) return EMPTY;
  try {
    const p = JSON.parse(raw);
    const got: Record<string, number> = {};
    for (const [id, at] of Object.entries(p?.got ?? {})) {
      const n = Number(at);
      if (Number.isFinite(n) && n > 0) got[id] = n;
    }
    return {
      v: 1,
      got,
      ...(p?.backfilled ? { backfilled: true as const } : {}),
      ...(p?.redated ? { redated: true as const } : {}),
    };
  } catch {
    return EMPTY;
  }
}

export function getBadgeState(): BadgeState {
  if (typeof window === "undefined") return EMPTY;
  try {
    return parse(window.localStorage.getItem(KEY));
  } catch {
    return EMPTY;
  }
}

function write(next: BadgeState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* quota / navigation privée — best-effort, comme les autres stores */
  }
  window.dispatchEvent(new CustomEvent(BADGES_EVENT));
}

/**
 * Accorde des badges. Rend ceux qui sont RÉELLEMENT nouveaux, dans l'ordre reçu
 * — c'est cette liste que l'appelant fait défiler en notifications, et elle est
 * vide quand rien n'a changé (le cas de loin le plus fréquent : l'évaluateur
 * tourne à chaque fin d'épisode).
 *
 * N'écrit rien si rien n'est nouveau : pas d'événement, donc pas de poussée
 * cloud, donc pas de requête pour un non-changement.
 */
export function grant(
  entries: { id: string; at: number }[],
  opts?: { backfilled?: boolean },
): string[] {
  const state = getBadgeState();
  const got = { ...state.got };
  const fresh: string[] = [];
  for (const { id, at } of entries) {
    const when = Number.isFinite(at) && at > 0 ? at : Date.now();
    if (got[id] == null) {
      got[id] = when;
      fresh.push(id);
    } else {
      /* Une preuve plus ancienne que ce qu'on avait : on corrige la date sans
         re-notifier. Arrive quand le rattrapage de métadonnées permet enfin de
         dater un badge accordé sans date. */
      got[id] = earliest(got[id], when);
    }
  }
  const markBackfilled = opts?.backfilled || state.backfilled;
  const changed =
    fresh.length > 0 ||
    !!markBackfilled !== !!state.backfilled ||
    JSON.stringify(got) !== JSON.stringify(state.got);
  if (changed) {
    write({
      v: 1,
      got,
      ...(markBackfilled ? { backfilled: true as const } : {}),
      ...(state.redated ? { redated: true as const } : {}),
    });
  }
  return fresh;
}

/** Remplace les dates une fois pour toutes (cf. `redated`). Aucun badge ne se perd. */
export function applyRedate(dates: Record<string, number>): void {
  const state = getBadgeState();
  write({ ...state, got: { ...state.got, ...dates }, redated: true });
}

/**
 * La fusion de deux copies — celle de cet appareil et celle du compte.
 *
 * Union des ids, date la plus ancienne (invariant 2). `backfilled` est un OU :
 * si l'un des deux côtés a déjà fait son rattrapage, il ne doit pas
 * recommencer et re-notifier une collection entière.
 *
 * Utilisée par lib/list/cloudSync.ts : c'est la seule catégorie sauvegardée qui
 * ne peut pas se contenter du dernier-écrivain-gagne. Deux appareils qui
 * débloquent chacun un badge différent le même jour en perdraient un.
 */
export function mergeBadgeState(a: BadgeState, b: BadgeState): BadgeState {
  const got: Record<string, number> = { ...a.got };
  for (const [id, at] of Object.entries(b.got)) {
    if (got[id] == null) got[id] = at;
    else if (a.redated && !b.redated) continue;
    else if (b.redated && !a.redated) got[id] = at;
    else got[id] = earliest(got[id], at);
  }
  const backfilled = a.backfilled || b.backfilled;
  /* ET, pas OU : si une copie ancienne vient d'apporter des badges, leurs dates
     n'ont pas été corrigées. L'évaluateur repasse sur l'ensemble. */
  const redated = a.redated && b.redated;
  return {
    v: 1,
    got,
    ...(backfilled ? { backfilled: true as const } : {}),
    ...(redated ? { redated: true as const } : {}),
  };
}

/** Fusionne une charge venue du compte dans l'état local. Rend `true` si ça a bougé. */
export function mergeIntoLocal(raw: string | null): boolean {
  const incoming = parse(raw);
  if (!Object.keys(incoming.got).length && !incoming.backfilled) return false;
  const current = getBadgeState();
  const merged = mergeBadgeState(current, incoming);
  if (JSON.stringify(merged) === JSON.stringify(current)) return false;
  write(merged);
  return true;
}

/** La collection telle qu'elle est en base, sans passer par le navigateur. */
export function parseBadgeState(raw: string | null): BadgeState {
  return parse(raw);
}

export function useBadgeState(): BadgeState {
  const [state, setState] = useState<BadgeState>(EMPTY);
  useEffect(() => {
    const read = () => setState(getBadgeState());
    read();
    window.addEventListener(BADGES_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(BADGES_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return state;
}
