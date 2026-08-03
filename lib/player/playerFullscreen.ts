/**
 * Who owns fullscreen on the watch page.
 *
 * We do NOT use Vidstack's fullscreen (which hands the screen to `.vds-player`).
 * The player element is keyed per episode, so changing episode unmounts it — and
 * the Fullscreen API drops fullscreen the moment its element leaves the DOM.
 * Re-entering afterwards is IMPOSSIBLE: Chrome answers
 *
 *   "Failed to execute 'requestFullscreen' on 'Element':
 *    API can only be initiated by a user gesture."
 *
 * even when the document is already fullscreen (verified in Chrome 150, and the
 * user's click is long gone by the time the next episode's source resolves).
 *
 * So the fullscreen element is `<html>`, which no navigation can unmount, and
 * "the player fills the screen" becomes CSS: the wrapper goes
 * `position:fixed; inset:0` (class `aniscroll-player-fs`). That is exactly the
 * pseudo-fullscreen this player already used on iOS — Safari there swaps the
 * <video> for the system player and hides our overlays — now generalised to
 * every platform, with real fullscreen on the root element on top of it so the
 * browser chrome still goes away.
 *
 * Consequences, handled by the player:
 *   - Vidstack's own `fullscreen` state stays false, so its fullscreen button
 *     would show the wrong icon → we hide it and render our own.
 *   - `[data-fullscreen]`-keyed CSS (Vidstack's theme AND ours) wouldn't apply →
 *     the player sets that attribute itself while this mode is on.
 *
 * State lives here, outside React, because it must survive the player's
 * per-episode remount.
 */

let active = false;
let listening = false;
const subscribers = new Set<() => void>();

function emit(): void {
  subscribers.forEach((fn) => {
    try {
      fn();
    } catch {
      /* a stale subscriber must not break the others */
    }
  });
}

function fsElement(): Element | null {
  if (typeof document === "undefined") return null;
  return (
    document.fullscreenElement ||
    (document as any).webkitFullscreenElement ||
    null
  );
}

function enterRootFullscreen(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement as any;
  const req = root?.requestFullscreen || root?.webkitRequestFullscreen;
  if (!req || fsElement()) return;
  try {
    void Promise.resolve(req.call(root)).catch(() => {
      /* refused (no gesture / unsupported) — the CSS mode still stands, the
         player just shares the screen with the browser chrome */
    });
  } catch {
    /* ditto */
  }
}

function exitRootFullscreen(): void {
  if (typeof document === "undefined" || !fsElement()) return;
  const exit =
    document.exitFullscreen?.bind(document) ||
    (document as any).webkitExitFullscreen?.bind(document);
  if (!exit) return;
  try {
    void Promise.resolve(exit()).catch(() => {});
  } catch {
    /* not fullscreen anymore */
  }
}

// Escape, F11 and the browser's own exit affordance all bypass our button, so
// mirror the real state back into ours or the player would stay pinned to the
// viewport in a windowed browser.
function listen(): void {
  if (listening || typeof document === "undefined") return;
  listening = true;
  const onChange = () => {
    if (active && !fsElement()) {
      active = false;
      emit();
    }
  };
  document.addEventListener("fullscreenchange", onChange);
  document.addEventListener("webkitfullscreenchange", onChange);
}

export function isPlayerFullscreen(): boolean {
  return active;
}

/** MUST be called from a user gesture when turning fullscreen ON. */
export function setPlayerFullscreen(on: boolean): void {
  if (active === on) return;
  active = on;
  emit();
  if (on) enterRootFullscreen();
  else exitRootFullscreen();
}

export function togglePlayerFullscreen(): void {
  setPlayerFullscreen(!active);
}

export function subscribePlayerFullscreen(fn: () => void): () => void {
  listen();
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}
