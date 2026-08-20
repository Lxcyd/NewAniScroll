/**
 * Per-episode playback progress — "continue where you left off".
 *
 * Progress is keyed on `${aniId}:${episode}` ONLY (never the server), so the
 * resume point is shared across every player/server: stop at 10 min on one
 * server, switch servers, and you're still at 10 min.
 *
 * Stored as a single localStorage map so a whole anime's progress is one
 * read/write. Each entry records the last position, the episode duration, and
 * when it was touched (for pruning / "recently watched" ordering).
 *
 * "Completed" is represented implicitly: when the saved position is within
 * END_THRESHOLD of the duration we treat the episode as finished, so a rewatch
 * starts from 0 instead of resuming at 99%. Advancing to the next episode marks
 * the previous one complete via `markComplete`, satisfying "moving on = watched
 * to the end" even when the user skips the final seconds.
 */

const KEY = "aniscroll:progress";

/** Don't persist the first few seconds — a fresh resume seek hasn't applied
 *  yet, and saving 0–N here would clobber the very point we want to restore. */
export const MIN_SAVE_SECONDS = 5;

/** Within this many seconds of the end the episode counts as completed; we
 *  stop saving a resume point and a rewatch starts clean from 0. */
export const END_THRESHOLD_SECONDS = 30;

export type ProgressEntry = {
  /** Last playback position, in seconds. */
  time: number;
  /** Episode duration when last saved, in seconds (0 if unknown). */
  duration: number;
  /** Epoch ms of the last write. */
  updatedAt: number;
};

type ProgressMap = Record<string, ProgressEntry>;

/**
 * Emis a CHAQUE remontee de position du lecteur, y compris celles qu'on ne
 * persiste pas (debut d'episode, zone de fin). L'ecriture localStorage est
 * throttlee et muette : un `storage` event ne se declenche pas dans l'onglet
 * qui ecrit, donc sans ce signal la liste d'episodes ne peut pas suivre la
 * lecture en direct — sa barre ne bougeait qu'au rechargement.
 *
 * Volontairement une notification SANS re-render : l'abonne (cf. la barre de
 * la liste d'episodes) ecrit directement dans le DOM. Repasser par un state
 * React ferait re-rendre toute la liste toutes les 3 s, ce qui se voit sur un
 * catalogue de 1000 episodes.
 */
export const PROGRESS_EVENT = "aniscroll:progress-tick";

export type ProgressTick = {
  aniId: number | string;
  episode: number | string;
  time: number;
  duration: number;
};

function emitTick(detail: ProgressTick): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent<ProgressTick>(PROGRESS_EVENT, { detail }));
  } catch {
    /* best-effort */
  }
}

function progressKey(aniId: number | string, episode: number | string): string {
  return `${aniId}:${episode}`;
}

function readMap(): ProgressMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ProgressMap) : {};
  } catch {
    return {};
  }
}

function writeMap(map: ProgressMap): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* quota / private-mode — progress is best-effort, never throw */
  }
}

/** True when `entry` is close enough to the end to be considered finished. */
export function isCompleted(entry: ProgressEntry | null | undefined): boolean {
  if (!entry || !entry.duration) return false;
  return entry.time >= entry.duration - END_THRESHOLD_SECONDS;
}

/** Raw saved entry for an episode (or null). */
export function getProgress(
  aniId: number | string,
  episode: number | string,
): ProgressEntry | null {
  if (aniId == null || episode == null) return null;
  return readMap()[progressKey(aniId, episode)] ?? null;
}

/**
 * The position to resume playback from. Returns 0 when there's nothing useful
 * to resume to — no saved point, the episode was completed, or the saved point
 * is in the ignore window at the very start.
 */
export function getResumeTime(
  aniId: number | string,
  episode: number | string,
): number {
  const entry = getProgress(aniId, episode);
  if (!entry) return 0;
  if (isCompleted(entry)) return 0;
  if (entry.time < MIN_SAVE_SECONDS) return 0;
  return entry.time;
}

/**
 * Persist the current position for an episode. No-ops in the first few seconds
 * and in the trailing END_THRESHOLD window (the latter is handled as "complete"
 * by `markComplete` / natural end instead, so we don't leave a 99% resume).
 */
export function saveProgress(
  aniId: number | string,
  episode: number | string,
  time: number,
  duration: number,
): void {
  if (aniId == null || episode == null) return;
  if (!Number.isFinite(time)) return;
  // Le signal part AVANT les garde-fous d'ecriture : les deux fenetres qu'on
  // ne persiste pas (les premieres secondes, la zone de fin) sont justement
  // celles ou la barre doit continuer d'avancer a l'ecran.
  emitTick({ aniId, episode, time, duration });
  if (time < MIN_SAVE_SECONDS) return;
  if (Number.isFinite(duration) && duration > 0 && time >= duration - END_THRESHOLD_SECONDS) {
    // In the end zone — let the natural-end / next-episode path mark it
    // complete rather than storing a near-the-end resume point.
    return;
  }
  const map = readMap();
  map[progressKey(aniId, episode)] = {
    time,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    updatedAt: Date.now(),
  };
  writeMap(map);
}

/**
 * Mark an episode as fully watched. Used when the user advances to the next
 * episode (the previous one is implicitly finished) and when the video ends.
 * We store `time = duration` so `isCompleted` is true and a rewatch starts at 0.
 */
export function markComplete(
  aniId: number | string,
  episode: number | string,
  duration?: number,
): void {
  if (aniId == null || episode == null) return;
  const map = readMap();
  const key = progressKey(aniId, episode);
  const dur =
    Number.isFinite(duration) && (duration as number) > 0
      ? (duration as number)
      : map[key]?.duration || 1;
  map[key] = { time: dur, duration: dur, updatedAt: Date.now() };
  writeMap(map);
  emitTick({ aniId, episode, time: dur, duration: dur });
}

/**
 * Toutes les positions connues pour un anime, indexees par numero d'episode.
 * Une seule lecture + un seul JSON.parse pour toute la liste, la ou un appel
 * a `getProgress` par ligne en faisait un par episode.
 */
export function getAnimeProgress(
  aniId: number | string,
): Record<string, ProgressEntry> {
  const out: Record<string, ProgressEntry> = {};
  if (aniId == null) return out;
  const prefix = `${aniId}:`;
  for (const [key, entry] of Object.entries(readMap())) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = entry;
  }
  return out;
}

/** Drop the saved point for an episode (e.g. on an explicit "watch from start"). */
export function clearProgress(
  aniId: number | string,
  episode: number | string,
): void {
  if (aniId == null || episode == null) return;
  const map = readMap();
  delete map[progressKey(aniId, episode)];
  writeMap(map);
}

/** Wipe ALL local watch history. Used by the "Clear watch history" settings
 *  action. Clears both the resume-position map (`aniscroll:progress`) AND the
 *  watch-history store the "recently watched" page reads (`artplayer_settings`,
 *  which holds the per-episode rows for anonymous users / the local mirror).
 *  Local only — doesn't touch AniList or the signed-in user's server history. */
export function clearAllProgress(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem("artplayer_settings");
  } catch {
    /* best-effort */
  }
}
