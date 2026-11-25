/**
 * LA FUSION DU FIL D'ACTIVITÉ ANILIST, en fonction pure (25/11/2026).
 *
 * Sortie de la route POST /api/v2/account/anilist-feed pour être partagée avec
 * tools/anilist-feed/backfill.mjs, qui importe le fil des comptes qui ne se
 * reconnectent pas (Kuraryn : lié à AniList, aucune date, heatmap vide). Les
 * deux écrivent ainsi exactement le même fil. Aucun import hors de ce dossier :
 * le script la charge en transpilant ce fichier.
 */
import { mergeCompletions, type Completions, type FeedEvent } from "./feedFins";

export type Feed = {
  last: number;
  e: FeedEvent[];
  oldest?: number;
  done?: boolean;
  c?: Completions;
  cOldest?: number;
  cDone?: boolean;
};

export type FeedPatch = {
  last: number;
  e: FeedEvent[];
  oldest?: unknown;
  done?: unknown;
  c?: unknown;
  cOldest?: unknown;
  cDone?: unknown;
};

/** Une ligne lisible : [secondes, id AniList, épisode]. */
export function validEvent(x: unknown, nowMs: number): x is FeedEvent {
  if (!Array.isArray(x) || x.length !== 3) return false;
  const [t, m, ep] = x;
  return (
    Number.isInteger(t) &&
    t > 1_000_000_000 &&
    t < nowMs / 1000 + 86_400 &&
    Number.isInteger(m) &&
    m > 0 &&
    Number.isInteger(ep) &&
    ep > 0 &&
    ep < 10_000
  );
}

const minOf = (a: unknown, b: unknown) =>
  [a, b]
    .map(Number)
    .filter((x) => Number.isInteger(x) && x > 0)
    .reduce((p, q) => Math.min(p, q), Infinity);

/**
 * Ajoute `patch` au fil rangé : lignes dédoublonnées, de la plus récente à la
 * plus ancienne, plafonnées ; la lecture du passé reprend sous la date la plus
 * ancienne connue ; une lecture finie le reste.
 */
export function mergeFeed(old: Feed | null, patch: FeedPatch, nowMs: number, maxEvents: number): Feed {
  const seen = new Set<string>();
  const all: FeedEvent[] = [];
  for (const ev of [...patch.e, ...(old?.e ?? [])]) {
    const k = ev.join(":");
    if (seen.has(k)) continue;
    seen.add(k);
    all.push(ev);
  }
  all.sort((a, b) => b[0] - a[0]);
  const oldest = minOf(old?.oldest, patch.oldest);
  const c = mergeCompletions(old?.c, patch.c, nowMs);
  const cOldest = minOf(old?.cOldest, patch.cOldest);
  return {
    last: Math.max(patch.last, old?.last ?? 0),
    e: all.slice(0, maxEvents),
    ...(Number.isFinite(oldest) ? { oldest } : {}),
    ...(patch.done === true || old?.done ? { done: true } : {}),
    ...(Object.keys(c).length ? { c } : {}),
    ...(Number.isFinite(cOldest) ? { cOldest } : {}),
    ...(patch.cDone === true || old?.cDone ? { cDone: true } : {}),
  };
}
