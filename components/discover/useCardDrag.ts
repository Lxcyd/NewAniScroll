import { useEffect, useRef } from "react";

/**
 * Card-drag controller for the Discover feed.
 *
 * Ported from the reference AniScroll (MAUI) project's scroll-helpers.js. That
 * code talked to Blazor via DotNet interop; here it drives plain DOM refs and
 * calls back into React via `onDragEnd`. Behaviour kept 1:1:
 *
 *  - axis lock on the first significant movement (horizontal vs vertical)
 *  - vertical drag peeks neighbour cards (translateY), resolves to prev/next
 *  - horizontal drag past threshold = Tinder fly-off + list action, else snap
 *  - feathers + hint pills fade in proportional to horizontal drag
 *  - RAF-throttled paint, ghost-click suppression, wheel = card navigation
 *
 * The active card is found via `[data-active="true"]`; cards expose their parts
 * via data attributes so paint() can mutate them without React re-renders.
 */

const MOVE_THRESHOLD = 6;
const AXIS_LOCK = 10;
// Horizontal drag distance (px) required to commit the card to a list. A bit
// above the reference's 85 so a small left/right wiggle that returns to centre
// never lands the anime in a list — below this it just snaps back.
const HORIZ_THRESHOLD = 120;

type Axis = "none" | "horizontal" | "vertical";

export type DragEndInfo = {
  xOffset: number;
  yOffset: number;
  axis: Axis;
  moved: boolean;
};

type Params = {
  /** Container the listeners attach to (scoped, not document). */
  containerRef: React.RefObject<HTMLElement>;
  /** Card height in px (viewport height) — drives neighbour-peek translateY. */
  cardHeight: number;
  /** Called once a drag (or wheel step) resolves. */
  onDragEnd: (info: DragEndInfo) => void;
  /** When true, a horizontal fly-off animation runs before onDragEnd fires. */
  enabled: boolean;
};

export function useCardDrag({ containerRef, cardHeight, onDragEnd, enabled }: Params) {
  // Mutable drag state lives in a ref so listeners read the latest without
  // re-subscribing. cardHeight/onDragEnd are also mirrored into the ref.
  const state = useRef({
    isDragging: false,
    startX: 0,
    startY: 0,
    curX: 0,
    curY: 0,
    axis: "none" as Axis,
    hasMoved: false,
    rafId: 0,
    pointerId: null as number | null,
    suppressNextClick: false,
    wheelCooldown: false,
    baseTransforms: [] as { el: HTMLElement; baseY: number }[],
    cached: {
      fr: null as HTMLElement | null,
      fl: null as HTMLElement | null,
      hr: null as HTMLElement | null,
      hl: null as HTMLElement | null,
      img: null as HTMLElement | null,
    },
    cardHeight,
    onDragEnd,
    enabled,
  });

  state.current.cardHeight = cardHeight;
  state.current.onDragEnd = onDragEnd;
  state.current.enabled = enabled;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const s = state.current;
    const activeCard = () =>
      container.querySelector<HTMLElement>('[data-active="true"]');

    const paint = () => {
      const { axis, curX, curY, cached } = s;

      if (axis === "vertical") {
        // Peek neighbours: shift every card by curY off its base translateY.
        for (const { el, baseY } of s.baseTransforms) {
          el.style.transform = `translateY(${baseY + curY}px)`;
        }
      } else if (axis === "horizontal") {
        const mag = Math.min(1, Math.abs(curX) / HORIZ_THRESHOLD);
        const right = curX > 0;
        if (cached.fr) cached.fr.style.opacity = right ? String(mag) : "0";
        if (cached.fl) cached.fl.style.opacity = !right ? String(mag) : "0";
        if (cached.hr) cached.hr.style.opacity = right ? String(mag) : "0";
        if (cached.hl) cached.hl.style.opacity = !right ? String(mag) : "0";
        if (cached.img) {
          const rot = Math.max(-16, Math.min(16, curX * 0.022));
          cached.img.style.transform = `translateX(${curX}px) rotate(${rot}deg)`;
        }
      }
    };

    const startDrag = (x: number, y: number) => {
      if (s.isDragging || !s.enabled) return;
      s.isDragging = true;
      s.startX = x;
      s.startY = y;
      s.curX = 0;
      s.curY = 0;
      s.axis = "none";
      s.hasMoved = false;

      // Snapshot every card's base translateY for vertical neighbour-peek.
      s.baseTransforms = [];
      container.querySelectorAll<HTMLElement>("[data-card]").forEach((card) => {
        const m = card.style.transform.match(/translateY\(([-\d.]+)px\)/);
        s.baseTransforms.push({ el: card, baseY: m ? parseFloat(m[1]) : 0 });
      });

      const c = activeCard();
      if (c) {
        s.cached.fr = c.querySelector('[data-feather="right"]');
        s.cached.fl = c.querySelector('[data-feather="left"]');
        s.cached.hr = c.querySelector('[data-hint="right"]');
        s.cached.hl = c.querySelector('[data-hint="left"]');
        s.cached.img = c.querySelector("[data-poster]");
        c.dataset.dragging = "true";
      }
    };

    const onMove = (x: number, y: number) => {
      if (!s.isDragging) return;
      const dx = x - s.startX;
      const dy = y - s.startY;
      if (Math.abs(dx) > MOVE_THRESHOLD || Math.abs(dy) > MOVE_THRESHOLD)
        s.hasMoved = true;
      if (s.axis === "none" && (Math.abs(dx) > AXIS_LOCK || Math.abs(dy) > AXIS_LOCK))
        s.axis = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";

      if (s.axis === "vertical") {
        s.curY = dy;
        s.curX = 0;
      } else if (s.axis === "horizontal") {
        s.curX = dx;
        s.curY = 0;
      }

      if (!s.rafId)
        s.rafId = requestAnimationFrame(() => {
          s.rafId = 0;
          paint();
        });
    };

    const clearHints = (card: HTMLElement) => {
      ["right", "left"].forEach((d) => {
        const f = card.querySelector<HTMLElement>(`[data-feather="${d}"]`);
        if (f) f.style.opacity = "0";
        const h = card.querySelector<HTMLElement>(`[data-hint="${d}"]`);
        if (h) h.style.opacity = "0";
      });
    };

    const onEnd = () => {
      if (!s.isDragging) return;
      s.isDragging = false;
      if (s.rafId) {
        cancelAnimationFrame(s.rafId);
        s.rafId = 0;
      }

      // NOTE: we intentionally do NOT clear data-dragging here. The dragging
      // card is lifted (z-index) and unclipped (overflow:visible) via that
      // attribute; clearing it now would re-clip the poster mid fly-off and
      // make it look like the card jumps behind its neighbour. Each branch
      // below clears it at the right moment instead.
      const c = activeCard();

      if (s.hasMoved) {
        s.suppressNextClick = true;
        setTimeout(() => (s.suppressNextClick = false), 100);
      }

      const axis = s.axis;
      const horizValid = axis === "horizontal" && Math.abs(s.curX) >= HORIZ_THRESHOLD;
      const isRight = s.curX > 0;

      const fire = (axisOverride: Axis = axis) =>
        s.onDragEnd({
          xOffset: s.curX,
          yOffset: s.curY,
          axis: axisOverride,
          moved: s.hasMoved,
        });

      // ── HORIZONTAL: snap back (below threshold) ──
      // The drag didn't reach HORIZ_THRESHOLD: animate the poster back to
      // centre and report axis "none" so the page does NOT add it to a list.
      if (axis === "horizontal" && !horizValid) {
        const card = activeCard();
        if (card) {
          clearHints(card);
          const img = card.querySelector<HTMLElement>("[data-poster]");
          if (img) {
            img.style.transition =
              "transform 0.28s cubic-bezier(0.25,0.46,0.45,0.94)";
            img.style.transform = "";
            setTimeout(() => {
              img.style.transition = "";
              if (card) delete card.dataset.dragging;
            }, 300);
          } else if (card) {
            delete card.dataset.dragging;
          }
        }
        fire("none");
        return;
      }

      // ── HORIZONTAL: validated — Tinder fly-off ──
      if (horizValid) {
        const card = activeCard();
        if (card) {
          const flyX = isRight ? 920 : -920;
          const rot = isRight ? 38 : -38;
          const img = card.querySelector<HTMLElement>("[data-poster]");
          if (img) {
            img.style.transition =
              "transform 0.44s cubic-bezier(0.4,0,0.8,0.6), opacity 0.36s ease-in 0.06s";
            img.style.transform = `translateX(${flyX}px) translateY(-90px) rotate(${rot}deg)`;
            img.style.opacity = "0";
            // After the fly-off completes, reset the poster inline styles so the
            // card is clean if the user scrolls back to it later (no stale
            // translateX/opacity that would make it "teleport" back in).
            window.setTimeout(() => {
              img.style.transition = "none";
              img.style.transform = "";
              img.style.opacity = "";
              void img.offsetWidth;
              img.style.transition = "";
              // Re-clip + drop the z-index lift only now that the fly-off is done.
              if (card) delete card.dataset.dragging;
            }, 480);
          } else if (card) {
            delete card.dataset.dragging;
          }
          ["right", "left"].forEach((d) => {
            const f = card.querySelector<HTMLElement>(`[data-feather="${d}"]`);
            if (f) {
              f.style.transition = "opacity 0.12s";
              f.style.opacity = "0";
            }
            const h = card.querySelector<HTMLElement>(`[data-hint="${d}"]`);
            if (h) {
              h.style.transition = "opacity 0.12s";
              h.style.opacity = "0";
            }
          });
        }
        fire();
        return;
      }

      // ── VERTICAL + fallback ──
      // Clear the inline translateY the paint() applied to every card during
      // the drag, so React's own translateY (with the CSS transition class)
      // takes over cleanly instead of the card jumping from its dragged spot.
      for (const { el, baseY } of s.baseTransforms) {
        el.style.transform = `translateY(${baseY}px)`;
      }
      if (c) delete c.dataset.dragging;
      fire();
    };

    // ── Pointer-based start on the active card (delegated) ──
    const onPointerDown = (e: PointerEvent) => {
      if (s.isDragging || !s.enabled) return;
      const target = e.target as HTMLElement;
      const card = target.closest<HTMLElement>('[data-active="true"]');
      if (!card) return;
      // Don't hijack interactive children.
      if (target.closest("button, a, input, textarea, select")) return;
      // Capture the pointer on the container so every subsequent pointermove
      // is delivered here — even once the poster transforms out from under the
      // cursor. Without this, starting the drag ON the poster loses move events
      // (the poster slides away) and the swipe stutters. Starting beside it
      // worked only by accident because the static card stayed under the cursor.
      try {
        container.setPointerCapture(e.pointerId);
        s.pointerId = e.pointerId;
      } catch {
        /* setPointerCapture can throw on stale ids — non-fatal */
      }
      startDrag(e.clientX, e.clientY);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (s.isDragging) {
        onMove(e.clientX, e.clientY);
        e.preventDefault();
      }
    };
    const onPointerUp = () => {
      if (s.pointerId != null) {
        try {
          container.releasePointerCapture(s.pointerId);
        } catch {
          /* already released — non-fatal */
        }
        s.pointerId = null;
      }
      if (s.isDragging) onEnd();
    };

    const onClickCapture = (e: MouseEvent) => {
      if (s.suppressNextClick) {
        e.stopPropagation();
        e.preventDefault();
        s.suppressNextClick = false;
      }
    };

    const onWheel = (e: WheelEvent) => {
      if (s.isDragging || s.wheelCooldown || !s.enabled) return;
      if (Math.abs(e.deltaY) < 10) return;
      s.wheelCooldown = true;
      const yOffset = e.deltaY > 0 ? -100 : 100; // down = next
      s.onDragEnd({ xOffset: 0, yOffset, axis: "vertical", moved: false });
      setTimeout(() => (s.wheelCooldown = false), 350);
      e.preventDefault();
    };

    container.addEventListener("pointerdown", onPointerDown, { passive: false });
    container.addEventListener("pointermove", onPointerMove, { passive: false });
    container.addEventListener("pointerup", onPointerUp);
    container.addEventListener("pointercancel", onPointerUp);
    container.addEventListener("click", onClickCapture, true);
    container.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      if (s.rafId) cancelAnimationFrame(s.rafId);
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("pointercancel", onPointerUp);
      container.removeEventListener("click", onClickCapture, true);
      container.removeEventListener("wheel", onWheel);
    };
  }, [containerRef]);
}
