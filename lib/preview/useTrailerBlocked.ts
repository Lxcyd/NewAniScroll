import { useEffect, useSyncExternalStore } from "react";

import {
  isFatalTrailerError,
  isTrailerBlocked,
  markTrailerBlocked,
  markTrailerOk,
  subscribeBlocked,
  trailerStatus,
} from "./trailerBlocked";

/**
 * Is this trailer watchable from where the visitor is? Asked by a page that has
 * no player of its own.
 *
 * THE HOVER CARD LEARNS THIS FOR FREE: it mounts the embed anyway, so a blocked
 * video announces itself through `onError` and the card simply keeps its
 * artwork. The info page has no such luck — its trailer block is a still image
 * linking out to YouTube, so a blocked video turns it into a button that leads
 * to an error page, which is worse than no button at all.
 *
 * WHAT MAKES THE PROBE CHEAP, and the reason it is written this way: the player
 * reports the refusal WITHOUT BEING ASKED TO PLAY. Measured in France —
 *
 *     Bleach (0c4IoCA5fY0), never told to play  ->  etat -1, then onError 150
 *     a playable control, same treatment        ->  etat 5, and nothing more
 *
 * So this loads the embed and listens. No `playVideo`, therefore no video bytes:
 * the cost is the player's own boot and one config request, and the boot script
 * is shared with every other embed the browser has seen.
 *
 * It also runs at idle and only when the answer is unknown — a video either page
 * has already asked about is never asked about twice in a session.
 *
 * WHAT IT DELIBERATELY IS NOT: a server-side check. That is what this replaced.
 * The old one asked our Cloudflare Worker, which answered about a datacentre's
 * region rather than the visitor's — the wrong question, at the cost of a
 * blocking round trip on every cold payload. The YouTube Data API would answer
 * correctly but needs a key, a quota and the visitor's country. The player
 * already knows, and the player is free.
 */
const ORIGIN = "https://www.youtube-nocookie.com";
/** Long enough for a slow boot; after this, silence is taken as "fine". */
const VERDICT_TIMEOUT_MS = 9000;

export function useTrailerBlocked(id: string | null): boolean {
  const blocked = useSyncExternalStore(
    subscribeBlocked,
    () => isTrailerBlocked(id),
    // The server has no player and no session, so it never hides anything.
    // Answering anything else here would be a hydration mismatch, and React
    // pays for one of those by re-rendering the entire page on the client.
    () => false,
  );

  useEffect(() => {
    if (!id || trailerStatus(id) !== "unknown") return;

    let frame: HTMLIFrameElement | null = null;
    let handshake: ReturnType<typeof setInterval> | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    /** Kept apart from `deadline`: one delays the start, the other ends it. */
    let startTimer: ReturnType<typeof setTimeout> | null = null;
    let idleHandle: number | null = null;
    let done = false;

    const onMessage = (e: MessageEvent) => {
      if (e.origin !== ORIGIN || done) return;
      let data: { event?: string; info?: unknown };
      try {
        data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      if (data?.event !== "onError") return;
      done = true;
      if (isFatalTrailerError(data.info)) markTrailerBlocked(id);
      else markTrailerOk(id);
      cleanup();
    };

    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      if (handshake) clearInterval(handshake);
      if (deadline) clearTimeout(deadline);
      if (startTimer) clearTimeout(startTimer);
      frame?.remove();
      frame = null;
    };

    const start = () => {
      frame = document.createElement("iframe");
      frame.src =
        `${ORIGIN}/embed/${id}` +
        `?enablejsapi=1&controls=0&mute=1&playsinline=1&rel=0&iv_load_policy=3`;
      // Out of the layout and out of the way of anything that can be focused or
      // read aloud. Not `display:none`: a frame that is never laid out is one a
      // browser is entitled to skip loading, and loading is the entire point.
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("tabindex", "-1");
      frame.style.cssText =
        "position:absolute;width:1px;height:1px;left:-9999px;top:0;border:0;opacity:0;pointer-events:none";
      document.body.appendChild(frame);

      window.addEventListener("message", onMessage);
      // The embed says nothing until it is asked to; see TrailerStage.
      handshake = setInterval(() => {
        frame?.contentWindow?.postMessage(
          JSON.stringify({ event: "listening", id: 1, channel: "widget" }),
          ORIGIN,
        );
      }, 200);
      // No answer is an answer: a playable video simply never errors, so
      // silence has to resolve to "fine" or the block would stay hidden for
      // every trailer that works.
      deadline = setTimeout(() => {
        if (done) return;
        done = true;
        markTrailerOk(id);
        cleanup();
      }, VERDICT_TIMEOUT_MS);
    };

    const idle = window.requestIdleCallback;
    if (typeof idle === "function") idleHandle = idle(start, { timeout: 4000 });
    else startTimer = setTimeout(start, 2000);

    return () => {
      done = true;
      if (idleHandle != null) window.cancelIdleCallback?.(idleHandle);
      cleanup();
    };
  }, [id]);

  return blocked;
}
