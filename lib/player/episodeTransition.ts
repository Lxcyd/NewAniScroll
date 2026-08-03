/**
 * Episode navigation that KEEPS the user in fullscreen.
 *
 * The player is keyed by `{server}-{aniId}-{episode}-{sub|dub}` (see the watch
 * page's `playerNode`), so changing episode unmounts it. Fullscreen survives
 * that only because `lib/player/playerFullscreen` never gives the screen to the
 * player element in the first place — it fullscreens `<html>` and makes the
 * player fill it with CSS. Read that module first; it explains why re-entering
 * fullscreen after the remount is impossible (Chrome demands a fresh user
 * gesture, which we no longer have once the next source has resolved).
 *
 * What's left for this module is the *feedback*: while the next episode loads,
 * the player is gone and the page behind is a spinner nobody can see under a
 * full-screen player. So a host element mounted in `_app` (it must survive the
 * navigation, hence not in the page tree) covers the screen with black plus the
 * site's pink loading bar — the same signal `<NextNProgress>` gives on a normal
 * page change. The new player hides it as soon as it mounts.
 */

/** Give the page back if nothing claims the transition (dead source, etc.). */
const MAX_WAIT_MS = 25_000;

let hostEl: HTMLElement | null = null;
/** A transition is in flight: the host is up until a player claims it. */
let pending = false;
let watchdog: ReturnType<typeof setTimeout> | null = null;

/** `?fsdebug` in the URL traces the handoff — fullscreen bugs are unreproducible
 *  without knowing which step the browser refused. */
let debugChecked = false;
let debugOn = false;
function dlog(...args: unknown[]): void {
  if (!debugChecked) {
    debugChecked = true;
    try {
      debugOn = window.location.search.includes("fsdebug");
    } catch {
      debugOn = false;
    }
  }
  if (debugOn) console.log("[ep-transition]", ...args);
}

function show(): void {
  // A data attribute, not React state: the host has to be visible in the same
  // tick as the click that triggers the navigation, before React could commit.
  if (hostEl) hostEl.dataset.active = "1";
}

function hide(): void {
  if (hostEl) delete hostEl.dataset.active;
}

function disarm(): void {
  if (watchdog) clearTimeout(watchdog);
  watchdog = null;
}

/** Called by the `_app`-level host once it's in the DOM. */
export function registerTransitionHost(el: HTMLElement | null): void {
  hostEl = el;
}

export function isEpisodeTransitionPending(): boolean {
  return pending;
}

/**
 * Raise the loading host over the fullscreen player. No-op when we're not in
 * the player's fullscreen mode — a windowed navigation already shows the site's
 * own top progress bar.
 */
export function beginEpisodeTransition(fullscreen: boolean): boolean {
  if (typeof document === "undefined" || !hostEl || !fullscreen) return false;
  dlog("begin");
  pending = true;
  show();
  disarm();
  watchdog = setTimeout(() => {
    dlog("watchdog: nothing claimed the transition");
    cancelEpisodeTransition();
  }, MAX_WAIT_MS);
  return true;
}

/** The new player is mounted — drop the host. */
export function claimEpisodeTransition(): void {
  if (!pending) return;
  dlog("claim");
  pending = false;
  disarm();
  hide();
}

export function cancelEpisodeTransition(): void {
  if (!pending) return;
  dlog("cancel");
  pending = false;
  disarm();
  hide();
}

/**
 * The one way to change episode from inside the player: raise the loading host
 * first (so the fullscreen user sees the load instead of a frozen frame), then
 * navigate.
 */
export function navigateToEpisode(
  router: { push: (url: string) => unknown },
  href: string | null | undefined,
  fullscreen: boolean,
): void {
  if (!href) return;
  try {
    beginEpisodeTransition(fullscreen);
  } catch {
    /* the transition is a nicety — never block the navigation */
  }
  router.push(href);
}
