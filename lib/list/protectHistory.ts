/**
 * UNE ÉCRITURE AUTOMATIQUE NE RÉÉCRIT JAMAIS L'HISTOIRE (24/11/2026).
 *
 * L'audit du compte de Luc a trouvé, écrits par le site : des dates de début
 * remplacées par le jour d'un revisionnage ou d'un test (Promised Neverland :
 * 20/10/2026 au lieu du 29/04/2025, Frieren, Attack on Titan, Black Torch), des
 * dates de fin posées sur des anime en pause ou planifiés (Bleach, Akane-banashi),
 * et des dates de fin d'anime en cours. Les trois chemins automatiques (fin
 * d'épisode, synchro complète, rejeu de la file) passent tous par `sendSave`
 * (anilistPush.ts), qui applique cette règle :
 *   - une date déjà présente sur AniList n'est jamais remplacée ;
 *   - une date de fin n'est envoyée que si l'entrée finit « Terminé » ;
 *   - une date de début postérieure à la date de fin n'est pas envoyée ;
 *   - un « Terminé » / « En revisionnage » n'est jamais rétrogradé.
 * Seul l'éditeur de liste (`manual`) peut faire tout ça.
 *
 * Fichier sans dépendance : scripts/check-anilist-history.mjs le teste seul.
 */

import type { FuzzyDate, Status } from "./types";

/** Ce qu'AniList a pour cet anime ; `null` = pas d'entrée. */
export type RemoteState = {
  status: Status | null;
  startedAt: FuzzyDate | null;
  completedAt: FuzzyDate | null;
} | null;

type Dated = {
  status?: Status | null;
  startedAt?: FuzzyDate | null;
  completedAt?: FuzzyDate | null;
};

const hasDate = (f: FuzzyDate | null | undefined) => !!f?.year;
const dayOf = (f: FuzzyDate) => (f.year ?? 0) * 10_000 + (f.month ?? 0) * 100 + (f.day ?? 0);
const DONE = new Set(["COMPLETED", "REPEATING"]);

/** `remote` : `undefined` quand AniList n'a pas pu être lu. */
export function protectHistory<P extends Dated>(payload: P, remote: RemoteState | undefined): P {
  const p = { ...payload };
  if (remote === undefined) {
    // AniList illisible : on ne sait pas ce qu'on écraserait.
    delete p.startedAt;
    delete p.completedAt;
    return p;
  }
  if (!remote) return p;
  if (p.status && DONE.has(remote.status ?? "") && !DONE.has(p.status)) delete p.status;
  const finalStatus = p.status ?? remote.status;
  if (p.startedAt !== undefined && hasDate(remote.startedAt)) delete p.startedAt;
  if (p.completedAt !== undefined && (hasDate(remote.completedAt) || finalStatus !== "COMPLETED")) {
    delete p.completedAt;
  }
  const end = p.completedAt ?? remote.completedAt;
  if (p.startedAt && hasDate(p.startedAt) && end && hasDate(end) && dayOf(p.startedAt) > dayOf(end)) {
    delete p.startedAt;
  }
  return p;
}
