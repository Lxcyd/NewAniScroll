/**
 * Video player preferences (local, per-device).
 *
 * Same pattern as lib/prefs/syncPrefs.ts: a single localStorage key, a
 * CustomEvent for same-tab notification, and a hook returning the live value.
 *
 * These control the *automatic* counterparts of the manual Skip / Next
 * buttons SkipOverlay already shows. They're all off by default so the
 * default experience stays manual (the user clicks to skip / advance).
 */

import { useEffect, useState } from "react";

export type PlayerPrefs = {
  /** Jump past the intro (op) automatically when it starts. */
  autoSkipIntro: boolean;
  /** Jump past the outro (ed) automatically when it starts. */
  autoSkipOutro: boolean;
  /** Navigate to the next episode automatically when the current one ends. */
  autoNextEpisode: boolean;
  /** Show the rate popup when an anime becomes COMPLETED (last episode). */
  rateOnComplete: boolean;
  /** Force the HLS player to the highest level and disable auto-switching. */
  forceMaxQuality: boolean;
  /** Start every video muted (user can unmute from the player controls). */
  defaultMuted: boolean;
  /**
   * Scroll the watch page's episode list so the episode being played sits at
   * the top. On by default — on a long series the current row is otherwise out
   * of view the moment the panel opens. Off leaves the list at episode 1.
   */
  snapToCurrentEpisode: boolean;
  /**
   * Pas des raccourcis « avancer / reculer », en secondes.
   *
   * Il valait 5, ecrit en dur dans les deux `case` du gestionnaire de touches.
   * C'est un reglage tres personnel : 5 s convient pour repasser une replique,
   * 30 s pour sauter un passage — et personne n'a la meme idee du bon pas.
   * Borne a [SEEK_STEP_MIN, SEEK_STEP_MAX] a la LECTURE, parce que la valeur
   * vient de localStorage et qu'un `0` y ferait un raccourci inerte.
   */
  seekStep: number;
};

/** Bornes du pas de deplacement. Un pas sous la seconde ne se distingue pas
 *  d'une pression ratee ; au-dela de 30 s on saute une scene entiere. */
export const SEEK_STEP_MIN = 1;
export const SEEK_STEP_MAX = 30;

export const DEFAULT_PLAYER_PREFS: PlayerPrefs = {
  autoSkipIntro: false,
  autoSkipOutro: false,
  autoNextEpisode: false,
  rateOnComplete: true,
  forceMaxQuality: false,
  defaultMuted: false,
  snapToCurrentEpisode: true,
  seekStep: 5,
};

const KEY = "aniscroll:playerPrefs";
export const PLAYER_PREFS_EVENT = "aniscroll:playerPrefs:change";

/** Ramene un pas de deplacement dans ses bornes ; rend le defaut si la valeur
 *  n'est pas un nombre exploitable. */
export function clampSeekStep(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_PLAYER_PREFS.seekStep;
  return Math.min(SEEK_STEP_MAX, Math.max(SEEK_STEP_MIN, n));
}

export function getPlayerPrefs(): PlayerPrefs {
  if (typeof window === "undefined") return DEFAULT_PLAYER_PREFS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PLAYER_PREFS;
    const parsed = JSON.parse(raw);
    // Merge over defaults so a stored object missing a newer field is safe.
    const merged = { ...DEFAULT_PLAYER_PREFS, ...parsed };
    // `seekStep` est le seul champ NUMERIQUE de cet objet, donc le seul qui
    // puisse arriver hors bornes ou pas fini. On le ramene ici plutot que chez
    // chaque appelant : le gestionnaire de touches doit pouvoir s'en servir
    // sans rien verifier.
    merged.seekStep = clampSeekStep(merged.seekStep);
    return merged;
  } catch {
    return DEFAULT_PLAYER_PREFS;
  }
}

export function setPlayerPrefs(patch: Partial<PlayerPrefs>): PlayerPrefs {
  const next = { ...getPlayerPrefs(), ...patch };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* best-effort */
    }
    window.dispatchEvent(new CustomEvent(PLAYER_PREFS_EVENT));
  }
  return next;
}

export function usePlayerPrefs(): PlayerPrefs {
  const [prefs, setPrefs] = useState<PlayerPrefs>(DEFAULT_PLAYER_PREFS);
  useEffect(() => {
    const read = () => setPrefs(getPlayerPrefs());
    read();
    window.addEventListener(PLAYER_PREFS_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(PLAYER_PREFS_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return prefs;
}
