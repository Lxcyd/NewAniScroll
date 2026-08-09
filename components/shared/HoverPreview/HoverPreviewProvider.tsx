import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/router";

import { PREVIEW_ATTR } from "@/lib/preview/anchor";
import { fetchPreview } from "@/lib/preview/previewStore";
import { startViewportPrefetch } from "@/lib/preview/viewportPrefetch";
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

  /**
   * Warm the connections the trailer will need, at page load rather than at
   * hover. An embed costs a DNS lookup plus a TLS handshake before the first
   * byte of player code moves, and on a cold connection that is most of the
   * delay between the card appearing and the video starting — doing it up front
   * takes it off the critical path entirely. `googlevideo` only gets a
   * dns-prefetch: the media host is picked per video (`rr3---sn-…`), so there is
   * no fixed origin to shake hands with.
   */
  useEffect(() => {
    if (!enabled) return;
    const links = [
      ["preconnect", "https://www.youtube-nocookie.com"],
      ["preconnect", "https://i.ytimg.com"],
      ["dns-prefetch", "https://googlevideo.com"],
    ].map(([rel, href]) => {
      const link = document.createElement("link");
      link.rel = rel;
      link.href = href;
      link.crossOrigin = "";
      document.head.appendChild(link);
      return link;
    });
    return () => links.forEach((l) => l.remove());
  }, [enabled]);

  // Payloads and banners for the cards already on screen, so a hover finds the
  // artwork in cache instead of starting its download. See viewportPrefetch.
  useEffect(() => {
    if (!enabled) return;
    return startViewportPrefetch();
  }, [enabled]);

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
      prefetchNeighbours(el);
    };

    /**
     * Warm the two cards on either side of the one under the pointer.
     *
     * Hovering a card is almost never the first thing that happens to it — the
     * pointer arrives along a row. By the time it settles on the next poster,
     * that poster's payload (and, through previewStore, its banner) is already
     * in hand, so the card opens filled instead of opening bare and catching up
     * half a second later.
     *
     * This costs nothing in a sweep: every card crossed would have been fetched
     * on its own hover anyway, and previewStore dedupes for the life of the
     * page. It only moves the work earlier.
     */
    const prefetchNeighbours = (el: HTMLElement) => {
      const all = Array.from(
        document.querySelectorAll<HTMLElement>(`[${PREVIEW_ATTR}]`),
      );
      const i = all.indexOf(el);
      if (i < 0) return;
      for (const sibling of [all[i - 1], all[i + 1]]) {
        const id = Number(sibling?.getAttribute(PREVIEW_ATTR));
        if (Number.isFinite(id) && id > 0) void fetchPreview(id);
      }
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

    // The card travels with the page.
    //
    // Hayase gets this for free: its popup is a CHILD of the poster, so it
    // scrolls because the poster does. Ours is portalled to <body> and
    // positioned, so "moves with the page" has to be re-created — one rAF per
    // scroll frame, re-measuring the anchor and handing the new rect down.
    let raf = 0;
    const onScroll = () => {
      if (raf || !openRef.current) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const live = openRef.current;
        if (!live) return;
        if (!live.el.isConnected) return close();
        setOpen({ ...live, rect: rectOf(live.el) });
      });
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };

    // Clicking a card navigates; dragging a carousel shouldn't drag a popup
    // along. But a press INSIDE the popup is aimed at the popup — this listener
    // is on `document` in the capture phase, so without the exemption it tore
    // the card down before pause / mute / favourite ever saw their own click.
    const onPointerDown = (e: Event) => {
      const node = e.target as Element | null;
      if (node && typeof node.closest === "function" && node.closest("[data-preview-popup]")) {
        return;
      }
      close();
    };

    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("keydown", onKey);
    // Pointer left the window entirely — no further pointerover will arrive.
    document.addEventListener("mouseleave", close);
    window.addEventListener("blur", close);

    return () => {
      cancel();
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
      if (raf) cancelAnimationFrame(raf);
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
