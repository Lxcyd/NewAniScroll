import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/router";

import { PREVIEW_ATTR } from "@/lib/preview/anchor";
import { fetchPreview } from "@/lib/preview/previewStore";
import PreviewCard, { type AnchorRect } from "./PreviewCard";

/**
 * Site-wide anime hover preview — mounted once in _app.
 *
 * Hovering any element marked with `previewAnchor(id)` (lib/preview/anchor.ts)
 * pops a floating card with the trailer, the meta line and the quick actions.
 *
 * Why one delegated listener instead of per-card handlers: a home page carries
 * 100+ cards across a dozen unrelated layouts. Two `document` listeners cost
 * nothing and mean a new card type becomes previewable by adding an attribute,
 * with no React tree in common.
 *
 * The delays are the whole UX. Opening after {@link OPEN_DELAY} means a mouse
 * crossing a row on its way somewhere else never triggers anything, and the
 * shorter {@link SWITCH_DELAY} means that once a card IS open, moving along the
 * row feels like the card follows the pointer rather than re-arming each time.
 * {@link CLOSE_DELAY} is the grace period for crossing the gap between the card
 * and the popup that covers it.
 */

const OPEN_DELAY = 550;
const SWITCH_DELAY = 200;
const CLOSE_DELAY = 140;

/** Below this the popup would cover most of the viewport — not worth showing. */
const MIN_VIEWPORT_WIDTH = 1024;

type OpenState = {
  id: number;
  rect: AnchorRect;
  /** The card's own poster, painted behind the trailer while it loads. */
  poster: string | null;
};

export default function HoverPreviewProvider() {
  const router = useRouter();
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState<OpenState | null>(null);

  // Read inside the DOM listeners, which are bound once and must not close over
  // a stale `open`.
  const openRef = useRef<OpenState | null>(null);
  openRef.current = open;

  // Only on a real pointer: a touch device fires a synthetic hover on tap, which
  // would pop the card over the link the user just pressed.
  useEffect(() => {
    const mq = window.matchMedia("(hover: hover) and (pointer: fine)");
    const apply = () => setEnabled(mq.matches && window.innerWidth >= MIN_VIEWPORT_WIDTH);
    apply();
    mq.addEventListener("change", apply);
    window.addEventListener("resize", apply);
    return () => {
      mq.removeEventListener("change", apply);
      window.removeEventListener("resize", apply);
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      setOpen(null);
      return;
    }

    let openTimer: ReturnType<typeof setTimeout> | null = null;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    // The id an open timer is currently counting down for. Without it, moving
    // the pointer from the poster to a badge inside the SAME card would re-arm
    // the delay and the card would never appear.
    let pendingId: number | null = null;

    const cancelOpen = () => {
      if (openTimer) clearTimeout(openTimer);
      openTimer = null;
      pendingId = null;
    };
    const cancelClose = () => {
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = null;
    };

    const close = () => {
      cancelOpen();
      cancelClose();
      if (openRef.current) setOpen(null);
    };

    const scheduleOpen = (el: HTMLElement) => {
      const id = Number(el.getAttribute(PREVIEW_ATTR));
      if (!Number.isFinite(id) || id <= 0) return;
      cancelClose();
      if (openRef.current?.id === id) return; // already showing this one
      if (pendingId === id) return; // same card, timer already running
      cancelOpen();
      pendingId = id;
      // Start the fetch now rather than at open time: the request overlaps the
      // delay, so a warm edge hit lands before the card is even mounted.
      void fetchPreview(id);
      openTimer = setTimeout(() => {
        openTimer = null;
        pendingId = null;
        // Re-measure at fire time — the carousel may have scrolled under the
        // pointer during the delay.
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || !el.isConnected) return;
        setOpen({
          id,
          rect: { top: r.top, left: r.left, width: r.width, height: r.height },
          poster: el.querySelector("img")?.getAttribute("src") || null,
        });
      }, openRef.current ? SWITCH_DELAY : OPEN_DELAY);
    };

    const scheduleClose = () => {
      cancelOpen();
      if (!openRef.current || closeTimer) return;
      closeTimer = setTimeout(() => {
        closeTimer = null;
        setOpen(null);
      }, CLOSE_DELAY);
    };

    const onPointerOver = (e: Event) => {
      const target = e.target as Element | null;
      if (!target || typeof target.closest !== "function") return;
      // Inside the popup itself — that's still "hovering the preview".
      if (target.closest("[data-preview-popup]")) {
        cancelOpen();
        cancelClose();
        return;
      }
      const anchor = target.closest(`[${PREVIEW_ATTR}]`) as HTMLElement | null;
      if (anchor) scheduleOpen(anchor);
      else scheduleClose();
    };

    // Any scroll invalidates the anchor rect we positioned against, and the
    // capture phase is what catches the carousels' own overflow scrolling.
    const onScroll = () => close();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };

    document.addEventListener("pointerover", onPointerOver, true);
    // Clicking a card navigates; dragging a carousel shouldn't drag a popup along.
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("keydown", onKey);
    // Pointer left the window entirely — no further pointerover will arrive.
    document.addEventListener("mouseleave", close);
    window.addEventListener("blur", close);

    return () => {
      cancelOpen();
      cancelClose();
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mouseleave", close);
      window.removeEventListener("blur", close);
    };
  }, [enabled]);

  // A popup surviving into the next page would float over unrelated content.
  useEffect(() => {
    const hide = () => setOpen(null);
    router.events.on("routeChangeStart", hide);
    return () => router.events.off("routeChangeStart", hide);
  }, [router]);

  if (!enabled || !open || typeof document === "undefined") return null;

  return createPortal(
    <PreviewCard
      // Remount on id change: the card owns its fetch, its trailer iframe and
      // its position, and all three are per-anime.
      key={open.id}
      id={open.id}
      rect={open.rect}
      poster={open.poster}
    />,
    document.body,
  );
}
