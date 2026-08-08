import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/router";

import { PREVIEW_ATTR } from "@/lib/preview/anchor";
import { fetchPreview } from "@/lib/preview/previewStore";
import PreviewCard, { type AnchorRect } from "./PreviewCard";

/**
 * Site-wide anime hover preview — a port of Hayase's card preview
 * (`ui/cards/small.svelte` + the `hover` action in `modules/navigate.ts`),
 * mounted once in _app.
 *
 * Two deliberate departures from the original, both forced by this codebase:
 *
 *  1. Hayase renders the preview as an absolutely-positioned CHILD of the card.
 *     Our carousels are `overflow-x-scroll`, which would clip it, so the card is
 *     portalled to <body> and positioned against the anchor's rect. Same
 *     geometry — centred on the card, spilling over its neighbours.
 *  2. Hayase attaches the hover action per card. We have no shared card
 *     component (see lib/preview/anchor.ts), so one delegated `pointerover`
 *     listener on `document` finds the nearest `data-anime-preview` ancestor.
 *
 * The timing is Hayase's, and it is much more aggressive than it looks:
 * {@link HOVER_TIME} is 30 ms, re-armed on every `pointermove` while pending.
 * The effect is that the card appears the instant the pointer STOPS on a
 * poster, and never while it is travelling across one.
 */

/** Hayase's HOVER_TIME. */
const HOVER_TIME = 30;

/** Below this the popup would cover most of the viewport — not worth showing. */
const MIN_VIEWPORT_WIDTH = 1024;

type OpenState = {
  id: number;
  el: HTMLElement;
  rect: AnchorRect;
  /** The card's own poster, painted until the real banner arrives. */
  poster: string | null;
};

function rectOf(el: HTMLElement): AnchorRect {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

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

    let timer: ReturnType<typeof setTimeout> | null = null;
    let pendingEl: HTMLElement | null = null;

    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      pendingEl = null;
    };

    const close = () => {
      cancel();
      if (openRef.current) setOpen(null);
    };

    const show = (el: HTMLElement) => {
      const id = Number(el.getAttribute(PREVIEW_ATTR));
      if (!Number.isFinite(id) || id <= 0 || !el.isConnected) return;
      const rect = rectOf(el);
      if (!rect.width || !rect.height) return;
      setOpen({
        id,
        el,
        rect,
        poster: el.querySelector("img")?.getAttribute("src") || null,
      });
    };

    const arm = (el: HTMLElement) => {
      // Already showing this card — nothing to do.
      if (openRef.current?.el === el) return;
      pendingEl = el;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        pendingEl = null;
        show(el);
      }, HOVER_TIME);
      // Start the fetch immediately: 30 ms of delay buys nothing, but the card
      // is mounted before the response lands either way.
      const id = Number(el.getAttribute(PREVIEW_ATTR));
      if (Number.isFinite(id) && id > 0) void fetchPreview(id);
    };

    const anchorAt = (target: EventTarget | null): HTMLElement | null => {
      const node = target as Element | null;
      if (!node || typeof node.closest !== "function") return null;
      return node.closest(`[${PREVIEW_ATTR}]`) as HTMLElement | null;
    };

    const onPointerOver = (e: Event) => {
      const node = e.target as Element | null;
      if (!node || typeof node.closest !== "function") return;
      // Inside the popup itself — that's still "hovering the preview".
      if (node.closest("[data-preview-popup]")) {
        cancel();
        return;
      }
      const anchor = anchorAt(e.target);
      if (anchor) arm(anchor);
      else close();
    };

    // Hayase re-arms the timer on every pointermove, so the card only opens once
    // the pointer settles. Without it, sweeping a row would flash a card per
    // poster crossed.
    const onPointerMove = (e: Event) => {
      if (!pendingEl) return;
      if (anchorAt(e.target) !== pendingEl) return;
      if (timer) clearTimeout(timer);
      const el = pendingEl;
      timer = setTimeout(() => {
        timer = null;
        pendingEl = null;
        show(el);
      }, HOVER_TIME);
    };

    // Scrolling doesn't dismiss the card in Hayase (the popup is a child of the
    // card and moves with it). Ours is portalled, so we follow the anchor
    // instead — one rAF per scroll frame, and we give up if the card scrolled
    // out of view.
    let raf = 0;
    const onScroll = () => {
      const current = openRef.current;
      if (!current) return;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const live = openRef.current;
        if (!live) return;
        if (!live.el.isConnected) return close();
        const rect = rectOf(live.el);
        // Anchor scrolled clean out of the viewport — nothing to point at.
        if (rect.top + rect.height < 0 || rect.top > window.innerHeight) return close();
        setOpen({ ...live, rect });
      });
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };

    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointermove", onPointerMove, true);
    // Clicking a card navigates; dragging a carousel shouldn't drag a popup along.
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("keydown", onKey);
    // Pointer left the window entirely — no further pointerover will arrive.
    document.addEventListener("mouseleave", close);
    window.addEventListener("blur", close);

    return () => {
      cancel();
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointermove", onPointerMove, true);
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
