// The single, app-wide notice renderer. Reads the unified noticeStore and draws
// a sonner-style COLLAPSED stack: only the 3 newest cards render — the newest is
// fully visible at the front, older ones peek behind (scaled + offset up). On
// hover the stack fans out to full, readable cards. Each card has a ✕ and a thin
// countdown bar.
//
// Portal target: INTO the fullscreen player root when a player covers the screen
// (see lib/notifications/playerSurface) — a body-level toast is invisible while
// `.vds-player` is the fullscreen element — otherwise fixed to the screen's
// bottom-right. This is the mechanism that finally lets player notices (subs
// burned-in) and site notices (party created) share ONE animated stack.
//
// The fan-out itself is CSS-driven (.ip-toast-anchor:hover, see globals.css); no
// hover state lives in React so the windowed player's mouse-move churn can't
// interrupt the transition.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import {
  useNotices,
  dismissNotice,
  type Notice,
  type NoticeType,
} from "@/lib/notifications/noticeStore";
import { usePlayerSurface } from "@/lib/notifications/playerSurface";

// Per-type palette. Values mirror sonner 1.0.3 richColors (dark theme) so the
// look is identical to the toasts we're replacing.
const TYPE_STYLES: Record<
  NoticeType,
  { bg: string; border: string; color: string; iconPath: string }
> = {
  error: {
    bg: "hsl(358, 76%, 10%)",
    border: "hsl(357, 89%, 16%)",
    color: "hsl(358, 100%, 81%)",
    // filled warning triangle + "!"
    iconPath:
      "M12 2 1 21h22L12 2zm0 5.5c.55 0 1 .45 1 1v5a1 1 0 0 1-2 0v-5c0-.55.45-1 1-1zm0 9.25a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2z",
  },
  success: {
    bg: "hsl(140, 100%, 6%)",
    border: "hsl(150, 100%, 12%)",
    color: "hsl(150, 86%, 65%)",
    // filled circle + check
    iconPath:
      "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.2 14.4l-3.6-3.6 1.4-1.4 2.2 2.2 4.8-4.8 1.4 1.4-6.2 6.2z",
  },
  info: {
    bg: "hsl(215, 100%, 6%)",
    border: "hsl(223, 100%, 12%)",
    color: "hsl(216, 87%, 65%)",
    iconPath: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 5h2v2h-2V7zm0 4h2v6h-2v-6z",
  },
  message: {
    bg: "hsl(0, 0%, 9%)",
    border: "hsl(0, 0%, 20%)",
    color: "hsl(0, 0%, 93%)",
    iconPath: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 5h2v2h-2V7zm0 4h2v6h-2v-6z",
  },
};

const MAX = 3;
const GAP = 14; // px between fully-expanded cards (sonner uses ~14)
// Collapsed stack: each card behind is offset so that TOP-edge to TOP-edge
// between consecutive cards is exactly PEEK px, whatever their individual
// heights. Cards stay at full size (no scale) so that top-edge distance is the
// literal, constant gap the design calls for.
const PEEK = 14;

export default function NoticeStack() {
  const notices = useNotices();
  const surface = usePlayerSurface();

  // Measured card heights (id → px), so the expanded layout stacks cards by
  // their real size + a gap.
  const heights = useRef<Record<string | number, number>>({});
  // Bumped whenever a card reports a new measured height, so the layout re-runs
  // with the real height instead of the 56px placeholder (avoids the "cards
  // shift down for a frame when a new notice arrives while expanded" bug).
  const [, setMeasureTick] = useState(0);
  const recordHeight = (id: string | number, el: HTMLDivElement | null) => {
    if (!el) return;
    const h = el.offsetHeight;
    if (heights.current[id] !== h) {
      heights.current[id] = h;
      setMeasureTick((t) => t + 1);
    }
  };

  // Suppress the enter transition for the FRAME a new card mounts, so an
  // arriving 4th card doesn't make the existing ones visibly slide.
  const [animateOff, setAnimateOff] = useState(false);
  const prevCount = useRef(0);
  useEffect(() => {
    if (notices.length > prevCount.current) {
      setAnimateOff(true);
      const r1 = requestAnimationFrame(() =>
        requestAnimationFrame(() => setAnimateOff(false)),
      );
      prevCount.current = notices.length;
      return () => cancelAnimationFrame(r1);
    }
    prevCount.current = notices.length;
  }, [notices.length]);

  if (notices.length === 0) return null;
  if (typeof document === "undefined") return null;

  // Inside the player only when it covers the screen; otherwise a <body> toast
  // is reachable, so we render bottom-right of the SCREEN, outside the player.
  const insidePlayer = surface.active && !!surface.el;
  const portalTarget = insidePlayer ? surface.el! : document.body;

  // Newest first (front of the collapsed stack = index 0).
  const visible = notices.slice(-MAX).reverse();

  // Cumulative offset (from the bottom anchor) of each card once expanded: sum
  // of the real heights of the cards in front of it, plus a gap per step.
  const expandedOffset = (depth: number) => {
    let y = 0;
    for (let d = 0; d < depth; d++) {
      y += (heights.current[visible[d].id] || 56) + GAP;
    }
    return y;
  };
  const frontH = heights.current[visible[0]?.id] || 56;
  const expandedH =
    expandedOffset(visible.length - 1) +
    (heights.current[visible[visible.length - 1]?.id] || 56);
  const collapsedH = frontH + (visible.length - 1) * PEEK;

  return createPortal(
    <div
      className={"ip-toast-anchor" + (animateOff ? " ip-toast-no-anim" : "")}
      style={{
        // Inside player (fullscreen): absolute in the player root, lifted above
        // the control bar. Otherwise: fixed to the screen's bottom-right.
        position: insidePlayer ? "absolute" : "fixed",
        right: 16,
        bottom: insidePlayer ? 88 : 16,
        zIndex: insidePlayer ? 60 : 999999999,
        width: "min(356px, 86vw)",
        height: 0, // cards are absolutely positioned off this anchor
        pointerEvents: "none",
        ["--collapsed-hit-h" as any]: `${Math.round(collapsedH)}px`,
        ["--expanded-hit-h" as any]: `${Math.round(Math.max(expandedH, frontH))}px`,
      }}
    >
      {/* Invisible hover hit area — collapsed height at rest, expanded height
          while hovered (see .ip-toast-hit in globals.css). */}
      <div
        className="ip-toast-hit"
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: "100%",
          pointerEvents: "auto",
        }}
      />
      {visible.map((n, depth) => {
        const isFront = depth === 0;
        // Cards are natural-bottom-anchored (bottom:0). To place a behind card so
        // its TOP edge sits exactly `depth * PEEK` above the front card's top,
        // translate it up by (frontTop - itsTop) = (frontH + depth*PEEK) - itsH.
        // No scale: the top-edge gap must be the literal, constant PEEK.
        const cardH = heights.current[n.id] || 56;
        const collapsedTransform = `translateY(${-(frontH + depth * PEEK - cardH)}px) scale(1)`;
        const expandedTransform = `translateY(${-expandedOffset(depth)}px) scale(1)`;
        return (
          <div
            key={n.id}
            role="status"
            aria-live="polite"
            className="ip-toast-card"
            ref={(el) => recordHeight(n.id, el)}
            style={{
              // Cards are display-only for hit-testing EXCEPT the front one (its
              // ✕ needs clicks); the backdrop owns expand.
              pointerEvents: isFront ? "auto" : "none",
              position: "absolute",
              right: 0,
              bottom: 0,
              width: "100%",
              transformOrigin: "bottom center",
              opacity: 1,
              zIndex: MAX - depth,
              ["--collapsed-transform" as any]: collapsedTransform,
              ["--expanded-transform" as any]: expandedTransform,
            }}
          >
            <NoticeCard notice={n} />
            {/* ✕ close — sonner-style top-LEFT pill, only on the front card.
                Sibling of the clipped card so it can overhang the corner. */}
            {isFront && (
              <button
                type="button"
                aria-label="Close"
                onClick={() => dismissNotice(n.id)}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  transform: "translate(-35%, -35%)",
                  width: 20,
                  height: 20,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "50%",
                  background: TYPE_STYLES[n.type].bg,
                  border: `1px solid ${TYPE_STYLES[n.type].border}`,
                  color: TYPE_STYLES[n.type].color,
                  cursor: "pointer",
                  lineHeight: 1,
                  padding: 0,
                  zIndex: 1,
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  width={12}
                  height={12}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.4}
                  strokeLinecap="round"
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            )}
          </div>
        );
      })}
    </div>,
    portalTarget,
  );
}

function NoticeCard({ notice: n }: { notice: Notice }) {
  const s = TYPE_STYLES[n.type];
  const persistent = !Number.isFinite(n.dur);
  const customIcon: ReactNode = n.icon;
  return (
    <div
      className={n.className}
      style={{
        position: "relative",
        // overflow:hidden so the countdown bar's ends follow the rounded
        // corners. The ✕ pill lives in a non-clipped wrapper (sibling) so it can
        // overhang.
        overflow: "hidden",
        display: "flex",
        alignItems: n.description ? "flex-start" : "center",
        gap: 6,
        padding: 16,
        borderRadius: 8,
        background: s.bg,
        border: `1px solid ${s.border}`,
        color: s.color,
        fontSize: 13,
        fontWeight: 500,
        lineHeight: 1.5,
        boxShadow: "0 4px 12px rgba(0,0,0,0.15), 0 8px 30px rgba(0,0,0,0.35)",
      }}
    >
      {customIcon != null ? (
        <span style={{ flexShrink: 0, marginRight: 4, lineHeight: 1 }}>
          {customIcon}
        </span>
      ) : (
        <svg
          viewBox="0 0 24 24"
          width={16}
          height={16}
          fill="currentColor"
          style={{ flexShrink: 0, marginRight: 4, marginTop: n.description ? 1 : 0 }}
          aria-hidden="true"
        >
          <path d={s.iconPath} />
        </svg>
      )}
      <span style={{ minWidth: 0, flex: 1 }}>
        {n.msg}
        {n.description && (
          <span
            style={{
              display: "block",
              marginTop: 3,
              fontWeight: 400,
              opacity: 0.85,
              fontSize: 12.5,
            }}
          >
            {n.description}
          </span>
        )}
      </span>
      {/* Optional inline action button (e.g. "Undo"). */}
      {n.action && (
        <button
          type="button"
          onClick={() => {
            n.action!.onClick();
            dismissNotice(n.id);
          }}
          style={{
            flexShrink: 0,
            alignSelf: "center",
            marginLeft: 8,
            padding: "4px 10px",
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            color: s.color,
            background: "color-mix(in srgb, currentColor 14%, transparent)",
            border: `1px solid ${s.border}`,
            lineHeight: 1.2,
          }}
        >
          {n.action.label}
        </button>
      )}
      {/* Thin countdown bar on non-persistent cards (visible once expanded on
          hover). Full-width; the card clips overflow so its ends follow the
          rounded bottom corners. When it finishes, the notice is killed via
          onAnimationEnd. The store also arms a setTimeout of the same duration
          as a safety net for cards beyond the top-3 (whose bar never runs). */}
      {!persistent && (
        <span
          aria-hidden="true"
          onAnimationEnd={() => dismissNotice(n.id)}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: 2,
            transformOrigin: "left center",
            background: "color-mix(in srgb, currentColor 45%, transparent)",
            animation: `toastCountdown ${n.dur}ms linear forwards`,
          }}
        />
      )}
    </div>
  );
}
