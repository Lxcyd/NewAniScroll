/**
 * The hover preview's own volume and mute, kept apart from the watch player's.
 *
 * This module used to be `playerVolume.ts` and deliberately shared the player's
 * keys (`aniscroll:volume`, `aniscroll:muted`), on the reasoning that "loud" is
 * a property of the visitor rather than of a surface. In use that reasoning does
 * not hold: the two surfaces are asked for opposite things. An episode is
 * something you chose to watch, so it plays at whatever level you settled on; a
 * trailer starts because a pointer came to rest over a poster, so it is
 * background noise you did not ask for. Muting the browsing noise silenced the
 * next episode too, and turning the episode up made every subsequent poster
 * shout. They are one number no longer.
 *
 * The player keeps reading and writing its own keys directly (see the
 * "Persistent volume" block in components/watch/primary/UniversalPlayer.tsx) and
 * is untouched by anything here. Both key families start with `aniscroll:`, so
 * "restore default settings" still clears them together.
 */

export const PREVIEW_VOLUME_KEY = "aniscroll:preview:volume";
export const PREVIEW_MUTED_KEY = "aniscroll:preview:muted";

/**
 * Used until the visitor touches the preview's own volume control. Lower than
 * the player's default of 1, because this is audio nobody pressed play on.
 */
export const PREVIEW_DEFAULT_VOLUME = 0.4;

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** Stored volume as 0…1, or null when nothing has ever been saved. */
export function readVolume(): number | null {
  try {
    const raw = localStorage.getItem(PREVIEW_VOLUME_KEY);
    const v = raw == null ? NaN : parseFloat(raw);
    return Number.isFinite(v) ? clamp(v) : null;
  } catch {
    return null;
  }
}

export function writeVolume(v: number): void {
  try {
    localStorage.setItem(PREVIEW_VOLUME_KEY, String(clamp(v)));
  } catch {
    /* private mode — the in-memory value still holds for this page */
  }
}

/** Sound on by default: unset reads as unmuted, as the preview always has. */
export function readMuted(): boolean {
  try {
    return localStorage.getItem(PREVIEW_MUTED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeMuted(muted: boolean): void {
  try {
    localStorage.setItem(PREVIEW_MUTED_KEY, muted ? "1" : "0");
  } catch {
    /* as above */
  }
}
