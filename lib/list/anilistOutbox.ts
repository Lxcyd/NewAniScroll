/**
 * LA FILE D'ENVOI VERS ANILIST (23/10/2026).
 *
 * Avant elle, une modification faite pendant une panne d'AniList (épisode fini,
 * statut changé dans l'éditeur, mise en pause automatique, favori) partait,
 * échouait, et n'était JAMAIS renvoyée. Pire : au retour d'AniList, le miroir
 * AniList → local réécrivait l'ancienne valeur par-dessus (seule l'avance
 * d'épisodes était défendue).
 *
 * Chaque écriture qui échoue pour une raison PASSAGÈRE (réseau, 5xx, 403 de
 * panne, 429, jeton à relier) est rangée ici, sur l'appareil, une ligne par
 * anime : les champs voulus et l'heure du geste. `flushOutbox` (syncEngine) la
 * rejoue dès qu'AniList répond, AVANT le miroir, avec les priorités de la
 * synchro :
 *   - l'avancée d'épisodes faite sur le site monte toujours si AniList est
 *     derrière ;
 *   - le reste (statut, note, dates, notes…) ne monte que si AniList n'a pas
 *     été modifié APRÈS le geste — sinon c'est AniList qui a le dernier mot ;
 *   - ce qu'AniList a gagné entre-temps (un anime ajouté en « À voir ») redescend
 *     par le miroir habituel.
 * Une erreur DÉFINITIVE (requête refusée par AniList pour son contenu) n'est pas
 * rangée : la rejouer échouerait pour toujours.
 */

import type { FuzzyDate, Status } from "./types";

export type OutboxFields = {
  status?: Status | null;
  score?: number | null;
  progress?: number | null;
  repeat?: number | null;
  notes?: string | null;
  startedAt?: FuzzyDate | null;
  completedAt?: FuzzyDate | null;
  private?: boolean;
  hiddenFromStatusLists?: boolean;
  customLists?: string[];
};

export type OutboxOp =
  | { mediaId: number; at: number; kind: "save"; fields: OutboxFields }
  | { mediaId: number; at: number; kind: "delete" };

type Store = {
  ops: Record<string, OutboxOp>;
  /** Favori voulu par anime : un ÉTAT, jamais une bascule (rejouer une bascule
   *  deux fois l'annulerait). */
  fav: Record<string, { want: boolean; at: number }>;
};

const KEY = "aniscroll:anilistOutbox";
export const OUTBOX_EVENT = "aniscroll:anilistOutbox:change";
/** Au-delà, un geste n'a plus de sens à rejouer (et ne doit pas gonfler la file). */
const MAX_AGE_MS = 30 * 86_400_000;

function read(): Store {
  if (typeof window === "undefined") return { ops: {}, fav: {} };
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    const now = Date.now();
    const ops: Store["ops"] = {};
    const fav: Store["fav"] = {};
    for (const [k, v] of Object.entries((s?.ops ?? {}) as Store["ops"]))
      if (v && now - v.at < MAX_AGE_MS) ops[k] = v;
    for (const [k, v] of Object.entries((s?.fav ?? {}) as Store["fav"]))
      if (v && now - v.at < MAX_AGE_MS) fav[k] = v;
    return { ops, fav };
  } catch {
    return { ops: {}, fav: {} };
  }
}

function write(s: Store): void {
  try {
    if (!Object.keys(s.ops).length && !Object.keys(s.fav).length) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* quota : la file vit le temps de la page */
  }
  window.dispatchEvent(new CustomEvent(OUTBOX_EVENT));
}

/** Une modification à envoyer : fusionnée avec ce qui attend déjà pour cet anime. */
export function queueSave(mediaId: number, fields: OutboxFields): void {
  if (typeof window === "undefined" || !Number.isFinite(mediaId)) return;
  const s = read();
  const prev = s.ops[mediaId];
  const base = prev?.kind === "save" ? prev.fields : {};
  const clean: OutboxFields = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) (clean as any)[k] = v;
  s.ops[mediaId] = { mediaId, at: Date.now(), kind: "save", fields: { ...base, ...clean } };
  write(s);
}

export function queueDelete(mediaId: number): void {
  if (typeof window === "undefined" || !Number.isFinite(mediaId)) return;
  const s = read();
  s.ops[mediaId] = { mediaId, at: Date.now(), kind: "delete" };
  write(s);
}

export function queueFavourite(mediaId: number, want: boolean): void {
  if (typeof window === "undefined" || !Number.isFinite(mediaId)) return;
  const s = read();
  s.fav[mediaId] = { want, at: Date.now() };
  write(s);
}

/**
 * Un envoi DIRECT vient de réussir pour cet anime : les champs qu'il portait ne
 * sont plus en attente. Ce qu'il ne portait pas (une note changée hors ligne,
 * quand l'envoi n'était qu'une avancée d'épisode) reste dans la file.
 */
export function clearSent(mediaId: number, sent: string[] | "all"): void {
  if (typeof window === "undefined") return;
  const s = read();
  const op = s.ops[mediaId];
  if (!op) return;
  if (sent === "all" || op.kind === "delete") delete s.ops[mediaId];
  else {
    const rest = { ...op.fields };
    for (const f of sent) delete (rest as any)[f];
    /* L'heure est remise à maintenant : NOTRE envoi vient de dater l'entrée
       côté AniList, et le rejeu prendrait sinon ce qui reste pour plus ancien
       qu'AniList — et le jetterait. */
    if (Object.keys(rest).length) s.ops[mediaId] = { ...op, at: Date.now(), fields: rest };
    else delete s.ops[mediaId];
  }
  write(s);
}

export function clearFavourite(mediaId: number): void {
  if (typeof window === "undefined") return;
  const s = read();
  if (!s.fav[mediaId]) return;
  delete s.fav[mediaId];
  write(s);
}

export function pendingOps(): OutboxOp[] {
  return Object.values(read().ops).sort((a, b) => a.at - b.at);
}

export function pendingFavourites(): { mediaId: number; want: boolean; at: number }[] {
  return Object.entries(read().fav).map(([k, v]) => ({ mediaId: Number(k), ...v }));
}

export function pendingFor(mediaId: number): OutboxOp | undefined {
  return read().ops[mediaId];
}

export function hasPending(): boolean {
  const s = read();
  return Object.keys(s.ops).length > 0 || Object.keys(s.fav).length > 0;
}

/**
 * L'échec vaut-il d'être rejoué ? Oui pour tout ce qui dit « AniList ne peut pas
 * maintenant » : réseau coupé (pas de statut), 5xx, 429, le 403 de panne (le
 * 02/09/2026 AniList répondait 403 à tout), le jeton à relier (401 / « Invalid
 * token » : rejoué une fois le compte relié). Non pour un 400 sur le contenu de
 * la requête : il échouerait pour toujours.
 */
export function isRetryable(httpStatus: number | null, json?: any): boolean {
  if (httpStatus == null) return true;
  if (httpStatus >= 500 || httpStatus === 429 || httpStatus === 403 || httpStatus === 401) return true;
  const why = String(json?.errors?.[0]?.message || "");
  if (/invalid token|unauthor|temporarily|disabled|stability/i.test(why)) return true;
  return false;
}
