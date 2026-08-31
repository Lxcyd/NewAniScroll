/**
 * L'activité de lecture d'un profil, reconstruite CÔTÉ SERVEUR.
 *
 * Les blocs « Regarde en ce moment » et « Vu récemment » lisaient le
 * localStorage du navigateur qui affiche la page. Sur le profil d'un autre, ils
 * montraient donc la lecture du VISITEUR sous le nom du propriétaire — c'est
 * pourquoi `visibleTo` les masquait, et c'est ce que ce fichier répare.
 *
 * Rien n'est collecté ici : les deux stores dont ils dépendent sont déjà
 * sauvegardés sur le compte par lib/list/cloudSync.ts —
 * `artplayer_settings` sous la catégorie `recent`, `aniscroll:progress` sous la
 * catégorie `progress`. Il n'y a qu'à les déballer.
 *
 * La forme d'un payload est celle que `readKind` écrit : les chaînes brutes du
 * localStorage, indexées par leur clé de stockage. D'où deux étages à défaire,
 * exactement comme `localListFromCloudPayload` le fait pour la liste (voir
 * lib/profile/sources.ts) : la clé, puis le JSON qu'elle porte.
 */

import { rowsFromRaw, type HistoryRow } from "./history";
import { isCompleted, type ProgressEntry } from "../watch/progress";

/** Une ligne d'historique, augmentée de son avancement. */
export type ActivityRow = HistoryRow & {
  /** Avancement dans l'épisode, 0 quand la durée est inconnue. */
  pct: number;
  /** Minutes restantes, `null` quand la durée est inconnue. */
  minutesLeft: number | null;
  done: boolean;
};

export type ProgressMap = Record<string, ProgressEntry>;

/** Le JSON porté par une clé de stockage, dans le payload d'une catégorie. */
function unwrap(payload: unknown, key: string): unknown {
  const raw = (payload as any)?.[key];
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** L'historique du profil, du plus récent au plus ancien. */
export function historyFromCloud(payload: unknown, limit = 12): HistoryRow[] {
  return rowsFromRaw(unwrap(payload, "artplayer_settings"), limit);
}

/**
 * La table de progression du profil, indexée `aniId:episode`.
 *
 * Un objet vide est une valeur normale et non une absence : `clearAllProgress`
 * écrit `"{}"` plutôt que de supprimer la clé, précisément parce que `readKind`
 * saute une clé absente et n'aurait donc jamais poussé l'effacement.
 */
export function progressFromCloud(payload: unknown): ProgressMap {
  const parsed = unwrap(payload, "aniscroll:progress");
  return parsed && typeof parsed === "object" ? (parsed as ProgressMap) : {};
}

/**
 * Le jumeau serveur du `decorate()` qui vivait dans DeviceBlocks.
 *
 * Il prend la table en paramètre au lieu d'appeler `getProgress`, qui lit le
 * localStorage et renvoie donc toujours `null` hors navigateur — l'avancement
 * de tout le monde serait resté à zéro sans que rien n'échoue.
 */
export function decorateRows(rows: HistoryRow[], map: ProgressMap): ActivityRow[] {
  return rows.map((row) => {
    const p = map[`${row.aniId}:${row.episode}`] ?? null;
    const pct =
      p && p.duration > 0 ? Math.min(100, Math.round((p.time / p.duration) * 100)) : 0;
    const minutesLeft =
      p && p.duration > 0 ? Math.max(0, Math.round((p.duration - p.time) / 60)) : null;
    return { ...row, pct, minutesLeft, done: isCompleted(p) };
  });
}

/** Les deux catégories dont dépend l'activité. */
export function activityFromCloud(
  payloads: { recent?: unknown; progress?: unknown },
  limit = 12,
): ActivityRow[] {
  return decorateRows(
    historyFromCloud(payloads.recent, limit),
    progressFromCloud(payloads.progress),
  );
}
