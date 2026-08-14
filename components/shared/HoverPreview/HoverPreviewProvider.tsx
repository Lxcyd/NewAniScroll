import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/router";

import { PREVIEW_ATTR } from "@/lib/preview/anchor";
import { isPreviewLocked, onPreviewUnlocked } from "@/lib/preview/previewLock";
import { fetchPreview } from "@/lib/preview/previewStore";
import { startViewportPrefetch } from "@/lib/preview/viewportPrefetch";
import PreviewCard, { type AnchorRect } from "./PreviewCard";
import TrailerStage from "./TrailerStage";

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
 * The timing is Hayase's in shape — a delay re-armed on every `pointermove`, so
 * the card appears when the pointer STOPS on a poster and never while it is
 * travelling across one — but not in length. See {@link STILL_TIME}.
 */

/**
 * How long the pointer must hold still before a card opens.
 *
 * Hayase uses 30 ms. That is short enough to be beaten by a hand that is still
 * moving: micro-adjustments over a small area are not a smooth stream of events
 * but bursts separated by pauses, and any pause longer than the delay opens the
 * card. The observed result was backwards — sweeping fast across a row showed
 * nothing, while fidgeting in one spot popped a card the user had not settled
 * on. A window wider than the gaps in a moving hand is what makes "static"
 * actually mean static; the cost is that a deliberate stop waits this long.
 */
const STILL_TIME = 200;

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

  /**
   * The open card's own "you moved" handler, while it is mounted.
   *
   * One card exists at a time, so this is a single slot rather than a list. The
   * identity of {@link subscribeRect} never changes, so subscribing costs the
   * card one effect for its whole life.
   */
  const rectListener = useRef<((rect: AnchorRect) => void) | null>(null);
  const subscribeRect = useCallback((cb: (rect: AnchorRect) => void) => {
    rectListener.current = cb;
    return () => {
      if (rectListener.current === cb) rectListener.current = null;
    };
  }, []);

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
   * Warm the connection the trailer will need, at page load rather than at
   * hover. A cold origin costs a DNS lookup plus a TLS handshake before the
   * first byte of video moves, and that is most of the delay between the card
   * appearing and the picture starting — doing it up front takes it off the
   * critical path entirely.
   *
   * Back to YouTube's own hosts. This warmed our Worker while trailers were
   * proxied MP4s; the proxy is gone and the preview is an embed again, so the
   * origins that matter are the embed document, its images and the media host.
   */
  useEffect(() => {
    if (!enabled) return;
    const links = [
      // The host EmbedTrailer actually loads — warming www.youtube.com while the
      // frame goes to youtube-nocookie buys nothing.
      ["preconnect", "https://www.youtube-nocookie.com"],
      // Where the player fetches its poster — the first pixels the viewer sees.
      //
      // The MEDIA host is deliberately absent: googlevideo hostnames are minted
      // per session and per region (rr3---sn-<random>), so pinning one would
      // warm a door this visitor will never walk through.
      ["preconnect", "https://i.ytimg.com"],
      /*
       * The player's anti-bot script comes off google.com, and it is IN the
       * boot's critical path — the player will not start without it.
       *
       * Taken from lite-youtube-embed's warm list, which is the most-measured
       * public work on this. It is the one host we were missing; the ad hosts
       * it also warms are marked "not certain if in the critical path" in that
       * project's own comments, and a preconnect we cannot justify is a
       * connection opened on the visitor's behalf for nothing.
       */
      ["preconnect", "https://www.google.com"],
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
    /** Last pointer position seen, so a re-fired event at rest isn't movement. */
    let lastPos: { x: number; y: number } | null = null;

    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      pendingEl = null;
    };


    const close = () => {
      cancel();
      // The card has a dialog of its own open — reaching for it means leaving
      // the card, and that must not be read as "done with the preview".
      if (isPreviewLocked()) return;
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

    /** (Re)start the countdown for `el`. Called on arrival and on every move. */
    const armCountdown = (el: HTMLElement) => {
      if (timer) clearTimeout(timer);
      pendingEl = el;
      timer = setTimeout(() => {
        timer = null;
        pendingEl = null;
        show(el);
      }, STILL_TIME);
    };

    const arm = (el: HTMLElement) => {
      // Already showing this card — nothing to do.
      if (openRef.current?.el === el) return;
      armCountdown(el);
      // Start the fetch immediately: the wait for stillness buys nothing here,
      // and the card is mounted before the response lands either way.
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

    // Every move restarts the countdown, so the card only opens once the pointer
    // settles. Without it, sweeping a row would flash a card per poster crossed.
    //
    // "Every move" is meant literally: no slop, no threshold. A single pixel of
    // drift is the hand still choosing, and letting small displacements through
    // is exactly what let a fidgeting pointer open cards it never stopped on.
    // Only a position that has not changed at all counts as at rest — which is
    // why the previous coordinates are compared rather than just counting the
    // event: browsers do emit pointermove without displacement.
    const onPointerMove = (e: Event) => {
      const p = e as PointerEvent;
      const moved = !lastPos || lastPos.x !== p.clientX || lastPos.y !== p.clientY;
      lastPos = { x: p.clientX, y: p.clientY };
      if (!pendingEl || !moved) return;
      if (anchorAt(e.target) !== pendingEl) return;
      armCountdown(pendingEl);
    };

    // The card travels with the page.
    //
    // Hayase gets this for free: its popup is a CHILD of the poster, so it
    // scrolls because the poster does. Ours is portalled to <body> and
    // positioned, so "moves with the page" has to be re-created — one rAF per
    // scroll frame, re-measuring the anchor and handing the new rect down.
    //
    // Handed down through a subscription rather than through state. Publishing
    // a new `open` object per scroll frame re-rendered the whole card — the
    // trailer, the ambient stack, the synopsis — and its own layout effect then
    // re-rendered it a second time to apply the position: two full React passes
    // per frame, during a scroll, which is exactly when the browser has the
    // least to spare. The card moves itself now (see PreviewCard), and `rect` is
    // kept in step for whatever renders next.
    let raf = 0;
    const onScroll = () => {
      if (raf || !openRef.current) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const live = openRef.current;
        if (!live) return;
        if (!live.el.isConnected) return close();
        live.rect = rectOf(live.el);
        rectListener.current?.(live.rect);
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

    // Dialog dismissed: the pointer is long gone from the card by then, so the
    // card goes too rather than lingering as a ghost.
    const unsubscribe = onPreviewUnlocked(() => setOpen(null));

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
      unsubscribe();
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

  if (!enabled || typeof document === "undefined") return null;

  return createPortal(
    <>
      {/*
        The trailer player, and it is rendered whether or not a card is open —
        that is the entire reason it lives here rather than in the card.
        Mounting it per card meant booting YouTube's player from nothing on
        every poster: ~450 ms of iframe birth plus a settle delay to hide the
        boot's first, ugly layout, both paid again each time. One player that
        outlives the cards pays that once a session. It renders nothing at all
        until the first card claims it, so a visitor who never hovers never
        loads it.
      */}
      <TrailerStage />
      {open && (
        <PreviewCard
          // Remount on id change: the card owns its fetch and its position, and
          // both are per-anime. The trailer is no longer among them.
          key={open.id}
          id={open.id}
          rect={open.rect}
          poster={open.poster}
          subscribeRect={subscribeRect}
        />
      )}
    </>,
    document.body,
  );
}
