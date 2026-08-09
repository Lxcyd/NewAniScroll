/**
 * The app's single volume setting, shared by every surface that makes sound.
 *
 * The watch player already persisted `aniscroll:volume` (0…1) and
 * `aniscroll:muted` across episodes, animes and sessions — see the "Persistent
 * volume" block in components/watch/primary/UniversalPlayer.tsx. The hover
 * preview's trailer reads and writes the SAME keys rather than keeping a private
 * one, so setting the volume in one place sets it everywhere.
 *
 * Note for whoever wires up the next audible surface: this module deliberately
 * has no React state. The player owns its volume imperatively (Vidstack fights
 * controlled props), and the preview owns its own via the YouTube postMessage
 * API — there is nothing meaningful to share but the number.
 */

export const VOLUME_KEY = "aniscroll:volume";
export const MUTED_KEY = "aniscroll:muted";

/**
 * Used only when the visitor has never touched a volume control anywhere. The
 * player's own default is 1, but 1 is the wrong opening bid for audio that
 * starts because a pointer paused over a poster, so the preview starts lower and
 * — importantly — does NOT write this back. The first deliberate adjustment,
 * here or in the player, is what makes the value shared.
 */
export const PREVIEW_DEFAULT_VOLUME = 0.4;

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** Stored volume as 0…1, or null when nothing has ever been saved. */
export function readVolume(): number | null {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    const v = raw == null ? NaN : parseFloat(raw);
    return Number.isFinite(v) ? clamp(v) : null;
  } catch {
    return null;
  }
}

export function writeVolume(v: number): void {
  try {
    localStorage.setItem(VOLUME_KEY, String(clamp(v)));
  } catch {
    /* private mode — the in-memory value still holds for this page */
  }
}

export function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTED_KEY, muted ? "1" : "0");
  } catch {
    /* as above */
  }
}
