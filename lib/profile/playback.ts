/**
 * CE QUE LE VISITEUR A RÉGLÉ À L'ÉCOUTE DU PROFIL, partagé avec le studio
 * (21/10/2026, Luc) : un fond vidéo mis en pause ou coupé sur le profil le
 * reste dans le menu d'édition, et l'inverse — un seul état, gardé dans ce
 * navigateur, que le profil (ProfileHero) et le studio (BannerStudio) lisent
 * et écrivent tous les deux.
 *
 * Changer de fond ou de musique puis enregistrer relance la lecture : le
 * studio remet ces réglages à zéro (`resumeVideo`, `rememberAutoplay(true)`).
 */
import { useEffect, useState } from "react";

const BG_PAUSED_KEY = "aniscroll:profile:bg-paused";
const BG_MUTED_KEY = "aniscroll:profile:bg-muted";
const PROFILE_VOLUME_KEY = "aniscroll:profile:volume";
const PROFILE_AUTOPLAY_KEY = "aniscroll:profile:autoplay";
/* Le même choix, en cookie : le serveur doit le connaître pour rendre le
   lecteur avec ou sans `autoplay` (voir YouTubeMusic, `autoStart`). */
export const PROFILE_AUTOPLAY_COOKIE = "as_profile_autoplay";

export const rememberAutoplay = (on: boolean) => {
  try {
    localStorage.setItem(PROFILE_AUTOPLAY_KEY, on ? "1" : "0");
  } catch {}
  try {
    document.cookie = `${PROFILE_AUTOPLAY_COOKIE}=${on ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
  } catch {}
};

export function readAutoplay(): boolean {
  try {
    return localStorage.getItem(PROFILE_AUTOPLAY_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Le niveau du son du profil (musique), 0-1, ou `null` s'il n'a jamais été réglé. */
export function readProfileVolume(): number | null {
  try {
    const v = parseFloat(localStorage.getItem(PROFILE_VOLUME_KEY) ?? "");
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
  } catch {
    return null;
  }
}

export function writeProfileVolume(v: number): void {
  try {
    localStorage.setItem(PROFILE_VOLUME_KEY, String(v));
  } catch {}
}

/* ── Pause et muet du fond vidéo : un petit magasin à abonnés ─────────── */
type Flag = { key: string; value: boolean | null; subs: Set<(v: boolean) => void> };
const paused: Flag = { key: BG_PAUSED_KEY, value: null, subs: new Set() };
const muted: Flag = { key: BG_MUTED_KEY, value: null, subs: new Set() };

function read(f: Flag): boolean {
  if (f.value == null) {
    try {
      f.value = localStorage.getItem(f.key) === "1";
    } catch {
      f.value = false;
    }
  }
  return f.value;
}

function write(f: Flag, v: boolean): void {
  f.value = v;
  try {
    localStorage.setItem(f.key, v ? "1" : "0");
  } catch {}
  f.subs.forEach((s) => s(v));
}

function useFlag(f: Flag): [boolean, (v: boolean | ((p: boolean) => boolean)) => void] {
  /* Faux au rendu serveur, relu au montage : le stockage n'existe qu'ici. */
  const [v, setV] = useState(false);
  useEffect(() => {
    setV(read(f));
    f.subs.add(setV);
    return () => {
      f.subs.delete(setV);
    };
  }, [f]);
  const set = (next: boolean | ((p: boolean) => boolean)) =>
    write(f, typeof next === "function" ? next(read(f)) : next);
  return [v, set];
}

/** Le fond vidéo en pause, sur le profil comme dans le studio. */
export const useBgPaused = () => useFlag(paused);
/** Le son du fond vidéo coupé par le visiteur, sur le profil comme dans le studio. */
export const useBgMuted = () => useFlag(muted);

/** Un nouveau fond vient d'être enregistré : il repart, avec son son. */
export function resumeVideo(): void {
  write(paused, false);
  write(muted, false);
}
