/**
 * Quand un anime a été FINI, d'après le fil d'activité AniList.
 *
 * Deux preuves, de la meilleure à la moins bonne :
 *   - la ligne « completed » du fil, posée même quand l'anime a été passé en
 *     Terminé d'un coup, sans cocher un seul épisode ;
 *   - à défaut, la première fois que son épisode le plus avancé a été vu.
 *
 * Fonctions pures : la route les appelle, tools/ peut les vérifier sans base.
 */

export type FeedEvent = [number, number, number];
/** id AniList → secondes de la PREMIÈRE ligne « completed ». */
export type Completions = Record<number, number>;

/** Ajoute des lignes valides à celles déjà rangées ; la plus ancienne gagne. */
export function mergeCompletions(old: Completions | undefined, incoming: unknown, nowMs: number): Completions {
  const out: Completions = { ...(old ?? {}) };
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return out;
  for (const [k, v] of Object.entries(incoming)) {
    const id = Number(k);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (!Number.isInteger(v) || (v as number) <= 1_000_000_000 || (v as number) >= nowMs / 1000 + 86_400) continue;
    const t = v as number;
    if (out[id] == null || t < out[id]) out[id] = t;
  }
  return out;
}

/** Pour chaque anime, la date de fin la mieux prouvée (en secondes). */
export function finsOf(events: FeedEvent[], completions?: Completions): Record<number, number> {
  const best = new Map<number, [number, number]>();
  for (const [t, media, ep] of events) {
    const cur = best.get(media);
    if (!cur || ep > cur[0] || (ep === cur[0] && t < cur[1])) best.set(media, [ep, t]);
  }
  return { ...Object.fromEntries([...best].map(([media, [, t]]) => [media, t])), ...(completions ?? {}) };
}
