// Registry of the currently-active "player surface" — i.e. the video player's
// root element when (and only when) it covers the screen (native fullscreen or
// iOS pseudo-fullscreen). The global <NoticeStack> reads this to decide WHERE
// to portal: into the player root when it's fullscreen (so notices stay visible
// over the video), otherwise fixed to the bottom-right of the screen.
//
// A real sonner-style toast renders in document.body, which is invisible while
// `.vds-player` is the fullscreen element — hence this indirection instead of
// just always portalling to <body>.
import { useSyncExternalStore } from "react";

export interface PlayerSurface {
  // The player root element to portal into while active. null when no player is
  // mounted / not fullscreen.
  el: HTMLElement | null;
  // True only while the player covers the screen (fullscreen or iOS pseudo-FS).
  active: boolean;
}

let surface: PlayerSurface = { el: null, active: false };
const listeners = new Set<() => void>();

export function setPlayerSurface(next: PlayerSurface) {
  // Skip no-op updates so we don't churn subscribers every render.
  if (surface.el === next.el && surface.active === next.active) return;
  surface = next;
  listeners.forEach((l) => l());
}

// Called on player unmount to make sure notices fall back to the screen.
export function clearPlayerSurface() {
  setPlayerSurface({ el: null, active: false });
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot() {
  return surface;
}

const SERVER: PlayerSurface = { el: null, active: false };
function getServerSnapshot() {
  return SERVER;
}

export function usePlayerSurface(): PlayerSurface {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
