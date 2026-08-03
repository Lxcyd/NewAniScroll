/**
 * "Load the next page when the visitor reaches the bottom."
 *
 * This existed as the same hand-rolled useEffect copy-pasted into four pages
 * (anime/popular, anime/trending, anime/recent, search). Every copy had the
 * same two problems:
 *
 *  1. It read `document.body.offsetHeight` inside the scroll handler. That is a
 *     forced synchronous layout, on every scroll event, on exactly the pages
 *     that hold the longest DOM — the classic layout-thrash that makes a list
 *     page feel heavy however little JS it runs.
 *  2. It called `window.removeEventListener(...)` on the handler from INSIDE
 *     the handler to stop paging, while the effect's cleanup removed it too —
 *     two mechanisms for one thing, and the inner one silently stopped working
 *     the moment the effect re-ran (it re-adds a fresh listener each time
 *     `page` changes).
 *
 * Here the measurement is coalesced to one read per animation frame, and
 * "should we still be paging" is just the `enabled` flag: false unsubscribes
 * entirely, so a finished list costs nothing at all.
 */

import { useEffect, useRef } from "react";

/** Distance from the bottom, in px, that counts as "reached the end". */
const THRESHOLD_PX = 3;

export function useInfiniteScroll(
  /** Called (at most once per frame) when the viewport reaches the bottom. */
  onReachEnd: () => void,
  /** Paging is live only while this is true — e.g. `page <= 5 && !!nextPage`. */
  enabled: boolean,
) {
  // Keep the latest callback without making it a dependency: re-subscribing on
  // every render would defeat the point.
  const cb = useRef(onReachEnd);
  cb.current = onReachEnd;

  useEffect(() => {
    if (!enabled) return;

    let frame = 0;
    const read = () => {
      frame = 0;
      const bottom =
        window.innerHeight + window.pageYOffset >=
        document.documentElement.scrollHeight - THRESHOLD_PX;
      if (bottom) cb.current();
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(read);
    };

    // Check once on mount: a short first page may not fill the viewport, in
    // which case no scroll event would ever fire and paging would stall.
    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, [enabled]);
}
