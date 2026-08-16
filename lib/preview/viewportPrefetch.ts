import { PREVIEW_ATTR } from "./anchor";
import { fetchPreview } from "./previewStore";

/**
 * Fetch preview payloads — and through previewStore, the banners themselves —
 * for the cards currently on screen, before anyone hovers them.
 *
 * The black band a card shows for its first moments is a download that only
 * started when the pointer arrived. Nothing done at hover time can remove it;
 * the work has to have happened earlier. Since the only cards a visitor can
 * possibly hover next are the ones they are looking at, "on screen" is both the
 * right predictor and a natural bound on how much we speculate.
 *
 * What keeps this from being a burst of requests:
 *   - /api/v2/preview is anonymous and edge-cached for a day, so a warm id is a
 *     CDN hit: no function invocation, no Upstash command;
 *   - previewStore dedupes for the life of the page, and each anchor is
 *     unobserved the first time it is seen;
 *   - the queue drains on idle callbacks, a few at a time, so it never competes
 *     with whatever the page is still doing;
 *   - Save-Data and 2g connections opt out entirely.
 *
 * The MutationObserver is not optional: carousels, infinite grids and SPA
 * navigation all add anchors after this starts, and those are exactly the cards
 * a visitor scrolls down to.
 */

/** Start a little before the card is on screen — scrolling shouldn't race it. */
const ROOT_MARGIN = "300px";
/** Requests in flight from the prefetcher. Low: it is background work. */
const MAX_CONCURRENT = 3;

type Idle = (cb: () => void) => void;

const onIdle: Idle =
  typeof window !== "undefined" && "requestIdleCallback" in window
    ? (cb) => (window as any).requestIdleCallback(cb, { timeout: 500 })
    : (cb) => setTimeout(cb, 120);

function shouldSkip(): boolean {
  const conn = (navigator as any)?.connection;
  if (!conn) return false;
  return conn.saveData === true || /(^|-)2g$/.test(String(conn.effectiveType ?? ""));
}

/** Begins prefetching. Returns a teardown; safe to call on the server (no-op). */
export function startViewportPrefetch(): () => void {
  if (typeof window === "undefined" || typeof IntersectionObserver === "undefined") {
    return () => {};
  }
  if (shouldSkip()) return () => {};

  const queue: number[] = [];
  let inFlight = 0;
  let scheduled = false;
  let stopped = false;

  const pump = () => {
    scheduled = false;
    while (!stopped && inFlight < MAX_CONCURRENT && queue.length) {
      const id = queue.shift()!;
      inFlight++;
      void fetchPreview(id).finally(() => {
        inFlight--;
        schedule();
      });
    }
  };

  const schedule = () => {
    if (scheduled || stopped || !queue.length) return;
    scheduled = true;
    onIdle(pump);
  };

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        io.unobserve(entry.target);
        const id = Number(entry.target.getAttribute(PREVIEW_ATTR));
        if (Number.isFinite(id) && id > 0) queue.push(id);
      }
      schedule();
    },
    { rootMargin: ROOT_MARGIN },
  );

  const observeAll = (root: ParentNode) => {
    root.querySelectorAll(`[${PREVIEW_ATTR}]`).forEach((el) => io.observe(el));
  };

  observeAll(document);

  const mo = new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        if (node.hasAttribute(PREVIEW_ATTR)) io.observe(node);
        observeAll(node);
      });
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });

  return () => {
    stopped = true;
    io.disconnect();
    mo.disconnect();
  };
}
