/**
 * Episode navigation that KEEPS the user in fullscreen.
 *
 * The problem: the player is keyed by `{server}-{aniId}-{episode}-{sub|dub}`
 * (see the watch page's `playerNode`), so changing episode UNMOUNTS the
 * `.vds-player` element — and the Fullscreen API drops fullscreen the moment
 * its element leaves the document. The old code worked around it by exiting
 * fullscreen *on purpose* before navigating (otherwise the next page loaded
 * "underneath" a frozen fullscreen frame and the button looked broken).
 *
 * The fix is a two-step handoff around the navigation:
 *
 *   1. `beginEpisodeTransition()` — called from the click/gesture, BEFORE
 *      `router.push`. It hands fullscreen to a page-level host element that
 *      lives in `_app` (see `components/shared/episodeTransitionOverlay.tsx`)
 *      and therefore survives ANY navigation. The host paints black with the
 *      site's pink loading bar on top, so the user sees "the next episode is
 *      loading" instead of a frozen frame.
 *   2. `claimEpisodeTransition(el)` — called by the NEW player as soon as its
 *      root element exists. It moves fullscreen back onto the real player and
 *      hides the host. Requesting fullscreen for another element while the
 *      document is ALREADY fullscreen doesn't need a fresh user gesture; if a
 *      browser refuses anyway we just leave fullscreen (i.e. the old
 *      behaviour) rather than trapping the user on a black host.
 *
 * Handing fullscreen back to `.vds-player` (rather than keeping an ancestor
 * fullscreen for good) matters: Vidstack derives its own `fullscreen` state
 * from `isFullscreen(player.el)`, and that state drives the button icon, the
 * `[data-fullscreen]` styling and WHERE it portals its menus. An ancestor host
 * would leave all of that thinking we're windowed.
 *
 * iOS never gets real fullscreen (Safari swaps in the system player and hides
 * our overlays), so the player fakes it with a CSS pseudo-fullscreen wrapper.
 * That's a per-player React state, which a remount would lose — so the flag is
 * mirrored here (`setPseudoFullscreenActive`) and the fresh player restores it
 * while a transition is pending.
 */

const MAX_WAIT_MS = 25_000;

/** How long to wait before believing a `fullscreenchange` (see `listen`). */
const SETTLE_MS = 300;

let hostEl: HTMLElement | null = null;
/** A transition is in flight: the host owns the screen until a player claims it. */
let pending = false;
/**
 * A `requestFullscreen()` WE issued is in flight (host taking the screen, or a
 * player taking it back). Swapping the fullscreen element is not atomic:
 * browsers exit the current element and enter the new one, firing intermediate
 * `fullscreenchange` events — including one where `fullscreenElement` is null.
 * Treating that as "the user pressed Escape" is what used to kill the whole
 * transition (and then force an exit through the stale-host safety net).
 */
let swapping = false;
/** The iOS CSS pseudo-fullscreen is currently on (mirrored from the player). */
let pseudoActive = false;
let watchdog: ReturnType<typeof setTimeout> | null = null;
let listening = false;

/** `?fsdebug` in the URL traces the handoff — fullscreen bugs are unreproducible
 *  without knowing WHICH step the browser refused. */
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

function fsElement(): Element | null {
  if (typeof document === "undefined") return null;
  return (
    document.fullscreenElement ||
    (document as any).webkitFullscreenElement ||
    null
  );
}

function requestFs(el: HTMLElement): Promise<void> {
  const req =
    el.requestFullscreen?.bind(el) ||
    (el as any).webkitRequestFullscreen?.bind(el);
  if (!req) return Promise.reject(new Error("no fullscreen API"));
  return Promise.resolve(req()) as Promise<void>;
}

function exitFs(): void {
  try {
    const exit =
      document.exitFullscreen?.bind(document) ||
      (document as any).webkitExitFullscreen?.bind(document);
    if (exit && fsElement()) void Promise.resolve(exit()).catch(() => {});
  } catch {
    /* not fullscreen / unsupported */
  }
}

function show() {
  // Toggled as a data attribute rather than React state so the host is visible
  // (and its progress-bar animation restarted) in the SAME tick as the
  // requestFullscreen call below — React state wouldn't have committed yet. The
  // host is always in the DOM and always laid out (opacity, not display), so
  // we never hand the screen to a `display:none` element.
  if (hostEl) hostEl.dataset.active = "1";
}

function hide() {
  if (hostEl) delete hostEl.dataset.active;
}

function disarm() {
  if (watchdog) clearTimeout(watchdog);
  watchdog = null;
}

function arm() {
  disarm();
  // Nothing claimed the screen (dead source, failed navigation…) — give the
  // page back rather than leaving the user on a black fullscreen host.
  watchdog = setTimeout(() => {
    cancelEpisodeTransition({ exitFullscreen: true });
  }, MAX_WAIT_MS);
}

function listen() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  const onChange = () => {
    const el = fsElement();
    dlog("fullscreenchange", {
      el: el === hostEl ? "host" : el?.tagName || null,
      pending,
      swapping,
    });
    // Never react while one of our own swaps is mid-flight — the intermediate
    // states are noise, and the request's own promise reports the outcome.
    if (swapping) return;

    if (pending && !el) {
      // Could be Escape… or a swap step we didn't initiate. Re-check once the
      // dust settles instead of tearing the transition down on the first sign.
      setTimeout(() => {
        if (!pending || swapping || fsElement()) return;
        dlog("fullscreen really gone → cancelling transition");
        cancelEpisodeTransition();
      }, SETTLE_MS);
      return;
    }
    // Safety net: some engines stack fullscreen elements instead of replacing
    // them, so exiting the player could surface the (hidden) host again.
    if (!pending && el && el === hostEl) {
      setTimeout(() => {
        if (pending || swapping || fsElement() !== hostEl) return;
        dlog("stale host owns the screen → exiting fullscreen");
        hide();
        exitFs();
      }, SETTLE_MS);
    }
  };
  document.addEventListener("fullscreenchange", onChange);
  document.addEventListener("webkitfullscreenchange", onChange);
}

/** Called by the `_app`-level host once it's in the DOM. */
export function registerTransitionHost(el: HTMLElement | null): void {
  hostEl = el;
  if (el) listen();
}

export function isEpisodeTransitionPending(): boolean {
  return pending;
}

/** Mirror of the player's iOS pseudo-fullscreen state (see module docs). */
export function setPseudoFullscreenActive(active: boolean): void {
  pseudoActive = active;
}

export function isPseudoFullscreenActive(): boolean {
  return pseudoActive;
}

/**
 * Hand the screen to the persistent host. Resolves once it actually owns
 * fullscreen, so the caller can navigate (and unmount the old player) without
 * racing the browser's fullscreen switch.
 *
 * Returns false when there was nothing to preserve (windowed playback) — the
 * caller just navigates and the site's own top progress bar does the talking.
 */
export async function beginEpisodeTransition(): Promise<boolean> {
  if (typeof document === "undefined" || !hostEl) {
    dlog("begin: no host registered");
    return false;
  }
  const current = fsElement();
  dlog("begin", { fullscreen: !!current, pseudoActive });
  if (!current && !pseudoActive) return false;
  pending = true;
  show();
  arm();
  // iOS pseudo-fullscreen: no real fullscreen to move, the host overlay alone
  // covers the (CSS-)fullscreen player.
  if (!current || current === hostEl) return true;
  // MUST stay synchronous up to here: we're inside the click that started the
  // navigation, and that user activation is what authorises the request.
  swapping = true;
  try {
    await requestFs(hostEl);
    dlog("begin: host owns the screen");
    return true;
  } catch (err) {
    dlog("begin: host request REFUSED", err);
    cancelEpisodeTransition();
    return false;
  } finally {
    swapping = false;
  }
}

/**
 * Move fullscreen onto the freshly mounted player and drop the host. Safe to
 * call on every mount: it no-ops unless a transition is actually pending.
 */
export function claimEpisodeTransition(el: HTMLElement | null | undefined): void {
  if (!pending) return;
  pending = false;
  disarm();
  const current = fsElement();
  dlog("claim", { from: current === hostEl ? "host" : current?.tagName || null });
  // iOS: nothing was really fullscreen, the new player re-applies its CSS
  // pseudo-fullscreen itself (restored from `isPseudoFullscreenActive`).
  if (!current || !el || current === el) {
    hide();
    return;
  }
  swapping = true;
  // Belt and braces: never leave the host up if the swap hangs.
  const failsafe = setTimeout(() => {
    swapping = false;
    hide();
  }, 3000);
  requestFs(el)
    .then(() => dlog("claim: player owns the screen"))
    .catch((err) => {
      // Browser insisted on a fresh user gesture — give the page back instead
      // of stranding the user on the host.
      dlog("claim: player request REFUSED", err);
      exitFs();
    })
    .finally(() => {
      clearTimeout(failsafe);
      swapping = false;
      hide();
    });
}

export function cancelEpisodeTransition(
  { exitFullscreen = false }: { exitFullscreen?: boolean } = {},
): void {
  if (!pending) return;
  dlog("cancel", { exitFullscreen });
  pending = false;
  disarm();
  hide();
  if (exitFullscreen) exitFs();
}

/**
 * The one way to change episode from inside the player. Preserves fullscreen
 * when we're in it; a plain `router.push` otherwise.
 */
export async function navigateToEpisode(
  router: { push: (url: string) => unknown },
  href: string | null | undefined,
): Promise<void> {
  if (!href) return;
  try {
    await beginEpisodeTransition();
  } catch {
    /* transition is a nicety — never block the navigation */
  }
  router.push(href);
}
