import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";

import { useEffect, useRef, useState } from "react";
// @ts-ignore — react-dom types not installed but createPortal is exported
import { createPortal } from "react-dom";
import {
  MediaPlayer,
  MediaProvider,
  Track,
  type MediaPlayerInstance,
} from "@vidstack/react";
import {
  defaultLayoutIcons,
  DefaultVideoLayout,
} from "@vidstack/react/player/layouts/default";
import HoverPreview from "./HoverPreview";
import SubtitleSettings from "./SubtitleSettings";
import SkipOverlay from "./SkipOverlay";
// @ts-ignore — context module is plain JS, no types
import { useWatchProvider } from "@/lib/context/watchPageProvider";

type Stream = {
  url: string;
  quality?: string;
  isM3U8?: boolean;
  referer?: string;
  /** Skip our local /api/v2/proxy/m3u8 — URL is already through an external
   *  proxy that handles CORS + segment rewriting (e.g. anime-proxy for vidmoly). */
  directUrl?: boolean;
};

type Subtitle = {
  file?: string;
  url?: string;
  label?: string;
  kind?: string;
  language?: string;
  default?: boolean;
};

export type UniversalStreamData = {
  streams?: Stream[];
  sources?: Stream[];
  iframe?: string;
  subtitles?: Subtitle[];
  referer?: string;
  error?: boolean;
};

type Props = {
  streamData: UniversalStreamData | null;
  poster?: string;
  onError?: (reason?: string) => void;
  ambient?: boolean;
  serverId?: string;
  /** Used as the download filename when the user hits the download button. */
  downloadName?: string;
  /** Persisted player preference — defaults to false. */
  autoplay?: boolean;
  /** Pre-computed URL for the next episode. SkipOverlay surfaces a
   *  "Next Episode" button during the outro segment (and in the last
   *  30 s of the episode) when this is non-null. */
  nextEpisodeHref?: string | null;
  /** MAL id for the anime — used as the AniSkip lookup key in our
   *  /api/v2/skip proxy. Null when MAL doesn't have a matching
   *  entry (rare). */
  malId?: number | null;
  /** AniList id — used to resolve the matching Anime-Skip showId
   *  via the external-link table (preferred source over AniSkip). */
  aniListId?: number | null;
  /** 1-based episode number for the skip-times lookup. */
  episodeNumber?: number;
};

function proxied(url: string, referer?: string | null): string {
  if (!url) return url;
  const ref = referer ? `&referer=${encodeURIComponent(referer)}` : "";
  return `/api/v2/proxy/m3u8?url=${encodeURIComponent(url)}${ref}`;
}

/**
 * StaticGlow — CSS-only ambient (poster + pink accent).
 * Used as the base layer always, and as the ONLY layer for iframe embeds
 * (where we can't reach into the cross-origin video element).
 */
function StaticGlow({
  poster,
  intense = false,
}: {
  poster?: string;
  intense?: boolean;
}) {
  // CSS-only fallback ambient. Used before LiveAmbient has its first video
  // frame to draw from, and as the only ambient layer for iframe embeds
  // (where cross-origin restrictions prevent canvas sampling).
  //
  // If no poster is provided we render nothing — a hardcoded brand-color
  // gradient would tint the entire player and pollute LiveAmbient's edges.
  if (!poster) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{
        zIndex: 0,
        backgroundImage: `url(${poster})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        filter: "blur(140px) saturate(1.8)",
        transform: "scale(1.1)",
        opacity: intense ? 0.95 : 0.8,
      }}
    />
  );
}

/**
 * LiveAmbient — projector stack with GPU bilinear scaling.
 *
 * The previous "stretch a small canvas to full size via CSS" approach was
 * unreliable: most browsers resample upscaled <canvas> with nearest-neighbor
 * regardless of imageSmoothingQuality. Result: visible pixel grid in the
 * gradient.
 *
 * Fix: keep each <canvas> at its native pixel size, and use a CSS `scale()`
 * transform on a wrapper to enlarge it. CSS transforms ARE always GPU-
 * accelerated with bilinear filtering, so the result is silky-smooth even
 * with a 320×180 source. Heavy CSS blur on top hides any residual artifacts
 * and gives the soft ambient feel.
 *
 * Z-index: wrapper sits at z-index:-1 (behind the player which is z:0). The
 * player has `overflow:hidden` so its controls always stay above and visible.
 *
 * Temporal blending: pairwise 50/50 with previous frame, softens scene cuts.
 */
function LiveAmbient({
  playerRef,
}: {
  playerRef: React.RefObject<MediaPlayerInstance>;
}) {
  const layerRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const sourceRef = useRef<HTMLCanvasElement | null>(null);
  const prevRef = useRef<HTMLCanvasElement | null>(null);

  // Multi-scale projector stack — concentric copies behind the player.
  const LAYERS = 5;
  // Each subsequent layer is enlarged by this fraction beyond layer 0.
  const SCALE_STEP = 0.08;
  // Canvas pixel size. Stays small because CSS transform handles the visible
  // scaling with GPU bilinear filtering. Higher would just waste pixels.
  const SRC_W = 320;
  const SRC_H = 180;

  useEffect(() => {
    if (!sourceRef.current) {
      const c = document.createElement("canvas");
      c.width = SRC_W; c.height = SRC_H;
      sourceRef.current = c;
    }
    if (!prevRef.current) {
      const c = document.createElement("canvas");
      c.width = SRC_W; c.height = SRC_H;
      prevRef.current = c;
    }

    let raf = 0;
    let lastFrameTime = -1;

    const tick = () => {
      raf = requestAnimationFrame(tick);

      const playerEl = playerRef.current?.el as HTMLElement | undefined;
      const video = playerEl?.querySelector("video") as HTMLVideoElement | null;
      if (!video || video.readyState < 2 || video.videoWidth === 0) return;
      if (video.currentTime === lastFrameTime) return;
      lastFrameTime = video.currentTime;

      const source = sourceRef.current!;
      const prev   = prevRef.current!;
      const sctx   = source.getContext("2d");
      const pctx   = prev.getContext("2d");
      if (!sctx || !pctx) return;

      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = "high";

      try {
        sctx.drawImage(video, 0, 0, SRC_W, SRC_H);
        // Pairwise temporal blend → softens scene cuts.
        sctx.globalAlpha = 0.5;
        sctx.drawImage(prev, 0, 0);
        sctx.globalAlpha = 1.0;
        pctx.clearRect(0, 0, SRC_W, SRC_H);
        pctx.drawImage(source, 0, 0);
        for (const layer of layerRefs.current) {
          if (!layer) continue;
          const lctx = layer.getContext("2d");
          if (!lctx) continue;
          lctx.clearRect(0, 0, SRC_W, SRC_H);
          lctx.drawImage(source, 0, 0);
        }
      } catch {
        // Cross-origin taint — silently skip.
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playerRef]);

  // Wrapper sits BEHIND the player (z:-1). pointer-events:none so the player
  // controls catch every click. Inside, each canvas is rendered at native
  // pixel size, then a wrapper div uses `width/height: 100%` + CSS object-
  // fit-like behavior to stretch it visually. The actual bilinear smoothing
  // comes from the CSS `transform: scale()` applied to each canvas wrapper.
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{ zIndex: -1 }}
    >
      {Array.from({ length: LAYERS }).map((_, i) => {
        const scale = 1 + i * SCALE_STEP;
        // Wrapper fills the player; the canvas inside is positioned to
        // cover it entirely with CSS scaling, which uses GPU bilinear.
        return (
          <div
            key={i}
            className="absolute inset-0 overflow-visible"
            style={{
              transform: `scale(${scale})`,
              transformOrigin: "center",
              // Heavy blur smooths the gradient + cancels any residual
              // pixel artifacts from canvas → CSS upscaling.
              filter: "blur(72px) saturate(1.8)",
              opacity: 0.95 * Math.pow(0.65, i),
              willChange: "transform",
            }}
          >
            <canvas
              ref={(el) => { layerRefs.current[i] = el; }}
              width={SRC_W}
              height={SRC_H}
              // width/height: 100% stretches the canvas to fill the wrapper
              // via CSS — this is the only path where browsers DO interpolate
              // (the canvas is treated as a replaced element). object-fit
              // ensures it covers fully.
              style={{
                width: "100%",
                height: "100%",
                display: "block",
                objectFit: "cover",
                imageRendering: "auto",
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

// Inserts (or reuses) a wrapper <div> immediately before `anchor` so React can
// portal our buttons there. Returning a stable DOM node keeps React happy
// across renders (no remount churn).
function ensureSiblingBefore(anchor: HTMLElement, id: string): HTMLElement {
  const parent = anchor.parentElement;
  if (!parent) return anchor;
  const existing = parent.querySelector<HTMLElement>(`:scope > [data-slot="${id}"]`);
  if (existing) return existing;
  const slot = document.createElement("div");
  slot.dataset.slot = id;
  slot.style.display = "contents";
  parent.insertBefore(slot, anchor);
  return slot;
}

// Inserts (or reuses) a wrapper <div> as the FIRST child of `parent`. Same
// rationale as ensureSiblingBefore — gives React a stable portal target.
function ensureFirstChildSlot(parent: HTMLElement, id: string): HTMLElement {
  const existing = parent.querySelector<HTMLElement>(`:scope > [data-slot="${id}"]`);
  if (existing) {
    // Re-position to first child if Vidstack rebuilt the menu and pushed it down.
    if (parent.firstChild !== existing) {
      parent.insertBefore(existing, parent.firstChild);
    }
    return existing;
  }
  const slot = document.createElement("div");
  slot.dataset.slot = id;
  slot.style.display = "contents";
  parent.insertBefore(slot, parent.firstChild);
  return slot;
}

const ICON_BTN_CLS =
  "vds-button moopa-vds-btn group ring-media-focus relative inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-md outline-none ring-inset hover:bg-white/20 data-[focus]:ring-4";
const ICON_BTN_STYLE: React.CSSProperties = {
  color: "rgb(var(--media-controls-color, 240 240 240))",
};

function CustomControls({
  downloadUrl,
  downloadFilename,
  downloadExt,
  onSubsClick,
  hasSubtitles,
  subBtnRef,
  castAvailable,
  castConnected,
  onCastClick,
}: {
  downloadUrl: string;
  downloadFilename: string;
  downloadExt: string;
  onSubsClick: () => void;
  hasSubtitles: boolean;
  subBtnRef: React.MutableRefObject<HTMLButtonElement | null>;
  castAvailable: boolean;
  castConnected: boolean;
  onCastClick: () => void;
}) {
  return (
    <>
      <a
        href={downloadUrl}
        download={downloadFilename}
        title={`Download ${downloadExt.toUpperCase()}`}
        aria-label="Download"
        className={ICON_BTN_CLS}
        style={ICON_BTN_STYLE}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-7 w-7">
          <path d="M12 16l-5-5h3V4h4v7h3l-5 5zm-7 2h14v2H5v-2z" />
        </svg>
      </a>

      {hasSubtitles && (
        <button
          ref={subBtnRef}
          type="button"
          onClick={onSubsClick}
          title="Subtitles"
          aria-label="Subtitles"
          className={ICON_BTN_CLS}
          style={ICON_BTN_STYLE}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-7 w-7">
            <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-9 11H6v-2h5v2zm7 0h-5v-2h5v2zm0-4H6V9h12v2z" />
          </svg>
        </button>
      )}

      {castAvailable && (
        <button
          type="button"
          onClick={onCastClick}
          title={castConnected ? "Casting…" : "Cast"}
          aria-label="Cast"
          className={ICON_BTN_CLS}
          style={{
            ...ICON_BTN_STYLE,
            color: castConnected
              ? "#E94560"
              : "rgb(var(--media-controls-color, 240 240 240))",
          }}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-7 w-7">
            <path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm18-7H5v1.63c3.96 1.28 7.09 4.41 8.37 8.37H19V7zM1 10v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zm20-7H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
          </svg>
        </button>
      )}
    </>
  );
}

// Popover listing the available subtitle tracks. Click a row to toggle —
// clicking the active track again disables captions. A pinned "Customize…"
// row at the bottom opens the visual settings panel (font, color, size).
function SubtitleMenu({
  tracks,
  activeIndex,
  onSelect,
  onClose,
  onCustomize,
  anchorEl,
  playerEl,
}: {
  tracks: Array<{ label: string; language: string }>;
  activeIndex: number; // -1 = subtitles off
  onSelect: (index: number) => void;
  onClose: () => void;
  onCustomize: () => void;
  anchorEl: HTMLElement | null;
  // Where to portal the menu. We render INSIDE the player so it stays
  // visible when the player enters fullscreen (in fullscreen mode the
  // top-level <body> tree is hidden).
  playerEl: HTMLElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (
        ref.current &&
        !ref.current.contains(e.target as Node) &&
        anchorEl &&
        !anchorEl.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, anchorEl]);

  // Position via `bottom` (anchored above the controls bar) and let the menu
  // size to its content. `maxHeight` is clamped to whatever fits between the
  // bar (bottom anchor) and the top of the player so it can never overflow.
  const [pos, setPos] = useState<{
    right: number;
    bottom: number;
    maxHeight: number;
  } | null>(null);

  useEffect(() => {
    if (!playerEl || !anchorEl) return;

    // Snapshot geometry on open — the anchor is guaranteed visible at this
    // moment (user just clicked it). One-shot cache so the menu doesn't
    // jump if Vidstack later hides the controls bar.
    const playerRect = playerEl.getBoundingClientRect();
    const anchorRect = anchorEl.getBoundingClientRect();

    // Anchor horizontally to the CC button.
    const right = Math.max(8, playerRect.right - anchorRect.right);
    // Match Vidstack's Settings menu: it sits just above the controls bar,
    // ~4px gap. Reading the bar height from the bottom-most controls group
    // produces the same vertical alignment as the native menu.
    const groups = Array.from(
      playerEl.querySelectorAll<HTMLElement>(".vds-controls-group")
    ).filter((el) => el.isConnected && el.getBoundingClientRect().height > 0);
    const bottomMostBar = groups.reduce<DOMRect | null>((best, el) => {
      const r = el.getBoundingClientRect();
      return !best || r.bottom > best.bottom ? r : best;
    }, null);
    const barHeight = bottomMostBar
      ? playerRect.bottom - bottomMostBar.top
      : 56;
    const bottom = barHeight + 4;
    const availableHeight = playerRect.height - bottom - 8;
    // Match Vidstack's max-height (60% of player height) so the menu feels
    // like part of the same UI family.
    const maxHeight = Math.max(120, Math.min(Math.floor(playerRect.height * 0.6), availableHeight));
    setPos({ right, bottom, maxHeight });
  }, [playerEl, anchorEl]);

  // Vidstack's enter animation: opacity 0→1 + translateY(12px → 0) over 0.3s.
  // Replicate exactly so our menu feels native.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (!pos) return;
    const r = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(r);
  }, [pos]);

  if (!playerEl || !pos) return null;
  const computedMaxHeight = pos.maxHeight;

  const menuNode = (
    <div
      ref={ref}
      role="menu"
      aria-label="Subtitle track selection"
      style={{
        position: "absolute",
        right: pos.right,
        bottom: pos.bottom,
        zIndex: 50,
        minWidth: 200,
        // Match Vidstack: max-height is 60% of player height (already
        // baked into pos.maxHeight via the geometry calc above).
        maxHeight: computedMaxHeight,
        // Match Vidstack's settings menu visual: dark bg, subtle blur, same
        // padding scale, same border radius.
        backgroundColor: "var(--media-menu-bg, rgb(10 10 10 / 0.95))",
        backdropFilter: "blur(4px)",
        border: "var(--media-menu-border, 1px solid rgb(255 255 255 / 0.1))",
        borderRadius: "var(--media-menu-border-radius, 8px)",
        boxShadow: "var(--media-menu-box-shadow, 1px 1px 1px rgb(10 10 10 / 0.5))",
        color: "#fff",
        fontFamily: "var(--media-font-family, sans-serif)",
        fontSize: 14,
        display: "flex",
        flexDirection: "column",
        overscrollBehavior: "contain",
        // Vidstack's exact enter animation: translateY(12px → 0) + fade,
        // 0.3s ease-out. Matches the Settings menu byte-for-byte.
        opacity: entered ? 1 : 0,
        transform: entered ? "translateY(0)" : "translateY(12px)",
        transition: "opacity 0.3s ease-out, transform 0.3s ease-out",
      }}
    >
      {/* Pinned header with the master ON/OFF toggle. Activates the previously
          active track if the user had picked one, otherwise the default. */}
      <div
        style={{
          padding: 6,
          borderBottom: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <SubtitleToggleRow
          enabled={activeIndex >= 0}
          onToggle={(next) => {
            if (next) {
              // Re-enable: prefer the persisted language (from localStorage),
              // then English, then the first available track. Matches the
              // sync-on-mount behavior so the toggle never silently picks
              // an unexpected track.
              let pickedIdx = -1;
              try {
                const wantLang = (localStorage.getItem("moopa.subs.lang") || "").toLowerCase();
                if (wantLang) {
                  pickedIdx = tracks.findIndex(
                    (t) => (t.language || "").toLowerCase() === wantLang
                  );
                }
                if (pickedIdx < 0) {
                  pickedIdx = tracks.findIndex(
                    (t) => (t.language || "").toLowerCase() === "en"
                  );
                }
              } catch {}
              if (pickedIdx < 0) pickedIdx = activeIndex >= 0 ? activeIndex : 0;
              onSelect(pickedIdx);
            } else {
              onSelect(-1);
            }
          }}
        />
      </div>

      {/* Scrollable language list. We attach a wheel handler that consumes
          the event when the scroller is at its top/bottom edge — `overscroll-
          behavior: contain` alone doesn't always stop overflow scroll on the
          page wrapper because the player root has `overflow: hidden` of its
          own and the wheel still bubbles up to the document. */}
      <div
        onWheel={(e) => {
          const el = e.currentTarget;
          const atTop = el.scrollTop <= 0;
          const atBottom = Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight;
          if ((atTop && e.deltaY < 0) || (atBottom && e.deltaY > 0)) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 6,
          overscrollBehavior: "contain",
          // Disabled state: dim the list when subs are off, but still let the
          // user pick a language (which auto-enables).
          opacity: activeIndex < 0 ? 0.55 : 1,
        }}
      >
        {tracks.map((t, i) => {
          const isActive = activeIndex === i;
          return (
            <SubMenuRow
              key={`${t.language}-${i}`}
              label={t.label || t.language || `Track ${i + 1}`}
              selected={isActive}
              onClick={() => {
                // Picking a track always enables subs (and switches if
                // another was active).
                onSelect(i);
                onClose();
              }}
            />
          );
        })}
      </div>

      {/* Pinned footer: visual customization shortcut */}
      <div
        style={{
          borderTop: "1px solid rgba(255,255,255,0.08)",
          padding: 6,
        }}
      >
        <SubMenuRow
          label="Customize subtitles…"
          selected={false}
          onClick={() => {
            onCustomize();
            onClose();
          }}
          icon={
            <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 14, height: 14 }}>
              <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
            </svg>
          }
        />
      </div>
    </div>
  );

  return createPortal(menuNode, playerEl);
}

// Toggle row at the top of the subtitle menu. Visual: label + pill switch
// (same style as the Autoplay item in the Settings menu).
function SubtitleToggleRow({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <div
      role="switch"
      aria-checked={enabled}
      tabIndex={0}
      onClick={() => onToggle(!enabled)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle(!enabled);
        }
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        borderRadius: 6,
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      <span style={{ flex: 1, fontWeight: 500 }}>Subtitles</span>
      <span
        aria-hidden
        style={{
          width: 32,
          height: 18,
          borderRadius: 999,
          backgroundColor: enabled ? "#E94560" : "rgba(255,255,255,0.18)",
          position: "relative",
          flexShrink: 0,
          transition: "background-color 120ms ease",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: enabled ? 16 : 2,
            width: 14,
            height: 14,
            borderRadius: "50%",
            backgroundColor: "#fff",
            transition: "left 120ms ease",
          }}
        />
      </span>
    </div>
  );
}

function SubMenuRow({
  label,
  selected,
  onClick,
  icon,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <div
      role="menuitemradio"
      aria-checked={selected}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        borderRadius: 6,
        cursor: "pointer",
        userSelect: "none",
        color: selected ? "#E94560" : "rgba(255,255,255,0.92)",
        backgroundColor: selected ? "rgba(233,69,96,0.08)" : "transparent",
      }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.06)";
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      {/* Leading slot: caller-supplied icon takes precedence; otherwise we
          show the check mark when selected, or an empty placeholder for
          consistent alignment. */}
      <span style={{ width: 14, display: "inline-flex", justifyContent: "center" }}>
        {icon ? (
          icon
        ) : selected ? (
          <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 14, height: 14 }}>
            <path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
          </svg>
        ) : null}
      </span>
      <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
    </div>
  );
}

// Row injected into Vidstack's Settings menu (above Speed/Quality/Captions).
// Mirrors the visual style of `.vds-menu-button` so it doesn't look bolted on.
// We render with role=menuitemcheckbox + aria-checked so screen readers announce
// the toggle state correctly.
// Generic toggle row that matches Vidstack's native menu item layout — same
// icon size (22px), same spacing as Speed/Quality. Used for both Autoplay
// and Ambient lights inside the Settings menu.
function SettingsToggleRow({
  label,
  enabled,
  onToggle,
  iconPath,
}: {
  label: string;
  enabled: boolean;
  onToggle: (next: boolean) => void;
  iconPath: string;
}) {
  return (
    <div
      // Use `menuitem` so Vidstack's existing menu-item CSS rules apply
      // (padding, hover background, focus outline). aria-checked still
      // exposes the toggle state to screen readers.
      role="menuitem"
      aria-checked={enabled}
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(!enabled);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle(!enabled);
        }
      }}
      className="vds-menu-button"
      style={{
        display: "flex",
        alignItems: "center",
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      {/* Match Vidstack's native menuitem icon size. Their CSS sets
          --media-menu-item-icon-size: 22px with a 6px right margin; we
          use those exact numbers so the row chrome stays uniform with
          Speed / Quality. */}
      <svg
        viewBox="0 0 24 24"
        fill="currentColor"
        style={{ width: 22, height: 22, marginRight: 6, flexShrink: 0 }}
      >
        <path d={iconPath} />
      </svg>
      <span style={{ flex: 1 }}>{label}</span>
      {/* Pill-style toggle */}
      <span
        aria-hidden
        style={{
          width: 28,
          height: 16,
          borderRadius: 999,
          backgroundColor: enabled ? "#E94560" : "rgba(255,255,255,0.18)",
          position: "relative",
          flexShrink: 0,
          transition: "background-color 120ms ease",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: enabled ? 14 : 2,
            width: 12,
            height: 12,
            borderRadius: "50%",
            backgroundColor: "#fff",
            transition: "left 120ms ease",
          }}
        />
      </span>
    </div>
  );
}

/**
 * Unified player:
 *  - Direct streams → Vidstack MediaPlayer with DefaultVideoLayout
 *    (speed / quality / captions / chromecast / PiP, pink #E94560 accent,
 *     live ambient light sampled from video frames)
 *  - Iframe embeds → same chrome + poster-only ambient glow (can't inject
 *    controls cross-origin)
 */
export default function UniversalPlayer({
  streamData,
  poster,
  onError,
  ambient = true,
  serverId,
  downloadName = "anime.mp4",
  autoplay = false,
  nextEpisodeHref = null,
  malId = null,
  aniListId = null,
  episodeNumber,
}: Props) {
  const playerRef = useRef<MediaPlayerInstance>(null);
  const [subMenuOpen, setSubMenuOpen] = useState(false);
  const [subStyleOpen, setSubStyleOpen] = useState(false);
  // Index of the active text track in the subtitleTracks list. -1 = subtitles off.
  const [activeTrackIdx, setActiveTrackIdx] = useState(-1);
  // Ref to the CC button so we can position the popover above it.
  const subBtnRef = useRef<HTMLButtonElement | null>(null);
  // Context-driven autoplay state — provider hydrates from localStorage on
  // mount and persists every change, so toggling here is instantly remembered
  // across every page (other watch sessions, episode navigation, refresh).
  const watchCtx = useWatchProvider() || {};
  const ctxAutoplay: boolean = !!watchCtx.autoplay;
  const setAutoPlayCtx: (v: boolean) => void = watchCtx.setAutoPlay || (() => {});
  /* AniSkip chapter cues, populated by SkipOverlay after it fetches
     the API. Each entry: { start, end, type }. We translate them
     into a WebVTT chapters track served via a blob URL so Vidstack
     splits the seek bar into per-pill chapters natively — same
     mechanic Miruro uses (no overlay hacks, no DOM portaling). */
  const skipTimes: Array<{ start: number; end: number; type: string }> =
    watchCtx.skipTimes || [];
  const chaptersTrackUrl = useChaptersVtt(skipTimes);
  // Ambient lights toggle — defaults to true if undefined (older context).
  const ctxAmbient: boolean = watchCtx.ambientLights !== false;
  const setAmbientCtx: (v: boolean) => void = watchCtx.setAmbientLights || (() => {});
  // The user toggle wins over the prop — we leave the prop in place so
  // callers can still force-disable ambient (e.g. an embedded preview),
  // but the user setting overrides "ambient is on by default".
  // Suppress ambient lights in fullscreen — they're invisible anyway (the
  // player covers the whole screen, no room for the glow to extend into)
  // and the per-frame canvas draw + N×CSS blur layers are a measurable GPU
  // hit that's pure waste at that resolution.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const update = () => {
      const fsEl =
        document.fullscreenElement ||
        (document as any).webkitFullscreenElement ||
        null;
      setIsFullscreen(!!fsEl);
    };
    update();
    document.addEventListener("fullscreenchange", update);
    document.addEventListener("webkitfullscreenchange", update);
    return () => {
      document.removeEventListener("fullscreenchange", update);
      document.removeEventListener("webkitfullscreenchange", update);
    };
  }, []);
  const ambientEnabled = ambient && ctxAmbient && !isFullscreen;
  // Reference to the vds-controls-group element where we portal our buttons.
  const [controlsGroupEl, setControlsGroupEl] = useState<HTMLElement | null>(null);
  // Anchor node inside that group: we insert our buttons IMMEDIATELY BEFORE
  // Vidstack's settings menu so the order is:
  //   [time]  ...spacer...  [Download] [Subs] [Cast] | [Settings] [PiP] [Fullscreen]
  const [settingsAnchorEl, setSettingsAnchorEl] = useState<HTMLElement | null>(null);
  // The list of items rendered inside Vidstack's Settings menu when it's open.
  // We portal an "Autoplay" toggle row into here so the user can flip it
  // alongside Speed / Quality / Captions.
  const [settingsItemsEl, setSettingsItemsEl] = useState<HTMLElement | null>(null);
  const [castAvailable, setCastAvailable] = useState(false);
  const [castConnected, setCastConnected] = useState(false);

  // Locate (and re-locate) Vidstack's bottom controls group + Settings menu
  // anchor. Vidstack remounts its layout in several situations — viewport
  // resize crossing the small/large breakpoint, fullscreen toggle, source
  // change — and any DOM nodes we cached become orphans (still in memory but
  // no longer in the document, so our portaled buttons disappear).
  //
  // A MutationObserver watching the player's subtree re-runs the lookup
  // whenever children are added or removed. Cheap to keep alive — Vidstack
  // doesn't churn on every frame.
  useEffect(() => {
    let cancelled = false;
    let obs: MutationObserver | null = null;

    const setup = () => {
      if (cancelled) return;
      const playerEl = playerRef.current?.el as HTMLElement | undefined;
      if (!playerEl) {
        // playerRef hasn't been attached yet — try again next tick.
        setTimeout(setup, 100);
        return;
      }
      sync(playerEl);
      obs = new MutationObserver(() => sync(playerEl));
      // childList: catches the controls bar / menu being mounted/unmounted.
      // attributes: catches Vidstack toggling data-open on the settings menu
      //   (open/close fires no childList event, just an attribute flip).
      // attributeFilter: keep observer cheap by only watching the attrs that
      //   actually drive our injection logic.
      obs.observe(playerEl, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-open", "class"],
      });
      // The settings menu may be portaled to <body> on mobile / fullscreen, so
      // also observe the document root for those mutations.
      obs.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-open"],
      });
    };

    const sync = (playerEl: HTMLElement) => {
      // Suppress Chrome's native cast overlay (top-left badge) every time —
      // when Vidstack remounts the <video> element this attribute is lost.
      const video = playerEl.querySelector<HTMLVideoElement>("video");
      if (video && !video.hasAttribute("disableremoteplayback")) {
        video.setAttribute("disableremoteplayback", "");
      }

      // Bottom controls group — last vds-controls-group attached to the document.
      const groups = playerEl.querySelectorAll<HTMLElement>(".vds-controls-group");
      let bottom: HTMLElement | null = null;
      for (let i = groups.length - 1; i >= 0; i--) {
        if (groups[i].isConnected) {
          bottom = groups[i];
          break;
        }
      }

      // Update only if the node identity changed — avoids pointless re-renders.
      setControlsGroupEl((prev) => (prev === bottom ? prev : bottom));

      if (bottom) {
        const anchor =
          bottom.querySelector<HTMLElement>(".vds-settings-menu") ||
          bottom.querySelector<HTMLElement>("media-menu.vds-menu") ||
          bottom.querySelector<HTMLElement>("[data-class*='settings']") ||
          bottom.querySelector<HTMLElement>(".vds-pip-button") ||
          null;
        setSettingsAnchorEl((prev) => (prev === anchor ? prev : anchor));
      } else {
        setSettingsAnchorEl((prev) => (prev === null ? prev : null));
      }

      // The Settings menu is opened/closed dynamically. Vidstack tags the
      // root menu list with BOTH `vds-settings-menu-items` and `vds-menu-items`;
      // submenus (Speed, Quality, Audio) only get `vds-menu-items`. So we
      // target the more specific class to avoid landing in a submenu.
      // Vidstack also portals the menu OUT of the player subtree on mobile —
      // search the document root, not just the player.
      let itemsEl: HTMLElement | null =
        playerEl.querySelector<HTMLElement>(".vds-settings-menu-items") ||
        document.querySelector<HTMLElement>(".vds-settings-menu-items");
      // Only inject when the menu is actually visible (Vidstack toggles
      // [data-open] on the parent menu wrapper). Avoids portaling into a
      // hidden tree.
      if (itemsEl) {
        const menuRoot = itemsEl.closest<HTMLElement>(".vds-settings-menu");
        const isOpen =
          menuRoot?.hasAttribute("data-open") ||
          itemsEl.offsetParent !== null;
        if (!isOpen) itemsEl = null;
      }
      setSettingsItemsEl((prev) => (prev === itemsEl ? prev : itemsEl));
    };

    setup();

    return () => {
      cancelled = true;
      obs?.disconnect();
    };
  }, []);

  // ── Keep controls visible while subtitle menu is open ──
  // Vidstack auto-hides the controls bar after 2s of mouse idle. The CC
  // popover lives outside the bar, so the user's mouse leaving the bar to
  // hover the menu would normally trigger the hide. `controls.pause()` is
  // Vidstack's official way to suspend idle tracking; pair it with
  // `controls.resume()` when the menu closes.
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    if (subMenuOpen) {
      try { (player as any).controls?.pause?.(); } catch {}
      return () => {
        try { (player as any).controls?.resume?.(); } catch {}
      };
    }
  }, [subMenuOpen]);

  // ── Keep controls visible while hovering custom buttons ──
  // Vidstack auto-hides its controls after ~2 s of mouse inactivity. Our
  // custom buttons (Download / Subs / Cast) are portaled into Vidstack's
  // control group so they LOOK like part of the bar, but their hover does
  // NOT reset Vidstack's idle timer — it only listens for pointermove on
  // the player root. Result: hover too long and the whole bar disappears
  // out from under the user's cursor.
  //
  // Fix: forward any pointermove that hits our portaled buttons up to the
  // player root by re-dispatching it. We catch on `pointermove` with
  // capture at the document level and check whether the target lives
  // inside our custom-controls slot.
  useEffect(() => {
    const player = playerRef.current;
    const playerEl = player?.el as HTMLElement | undefined;
    if (!playerEl) return;

    const onMove = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      // Only forward when the cursor is over a button we injected (any
      // child of [data-slot] wrappers, which is where our portals live).
      if (!t.closest("[data-slot]")) return;
      playerEl.dispatchEvent(
        new PointerEvent("pointermove", {
          clientX: e.clientX,
          clientY: e.clientY,
          bubbles: true,
        })
      );
    };

    document.addEventListener("pointermove", onMove, { capture: true });
    return () =>
      document.removeEventListener("pointermove", onMove, { capture: true });
  }, []);

  // ── Subtitle track sync ──
  // Vidstack manages text tracks via `playerRef.current.textTracks`. We mirror
  // the active track index into React state so the CC button can show whether
  // captions are on, and let the user pick a track from our custom popover.
  // selectSubtitleTrack(-1) disables captions; >=0 activates the matching one.
  //
  // Persistence: we remember the user's last chosen language in localStorage
  // and re-apply it across episodes / animes. If that language isn't in the
  // new stream's track list we fall back to English, then to the first
  // available track. "Off" is also remembered (user explicitly disabled subs).
  const SUB_PREF_LANG_KEY = "moopa.subs.lang";
  const SUB_PREF_ENABLED_KEY = "moopa.subs.enabled";

  const readPrefLang = (): string | null => {
    try { return localStorage.getItem(SUB_PREF_LANG_KEY); } catch { return null; }
  };
  const readPrefEnabled = (): boolean => {
    try {
      const v = localStorage.getItem(SUB_PREF_ENABLED_KEY);
      // Default: subs on (matches the legacy "first track wins" behavior).
      return v === null ? true : v === "1";
    } catch { return true; }
  };

  const selectSubtitleTrack = (idx: number) => {
    setActiveTrackIdx(idx);
    const tracks = playerRef.current?.textTracks;
    if (!tracks) return;
    // Walk the textTracks list, only touching captions/subtitles tracks (skip
    // chapters/metadata). Index aligns with the <Track> children we render.
    let captionIndex = 0;
    let selectedLang: string | null = null;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (!t) continue;
      const isCaption = t.kind === "subtitles" || t.kind === "captions";
      if (!isCaption) continue;
      const showing = captionIndex === idx;
      t.mode = showing ? "showing" : "disabled";
      if (showing) selectedLang = t.language || (t as any).label || null;
      captionIndex++;
    }
    // Persist the choice so the next episode / anime restores it.
    try {
      localStorage.setItem(SUB_PREF_ENABLED_KEY, idx >= 0 ? "1" : "0");
      if (selectedLang) localStorage.setItem(SUB_PREF_LANG_KEY, selectedLang);
    } catch {}
  };

  // Sync state when tracks are added/changed (e.g. after Vidstack mounts).
  // Also auto-apply the persisted language preference whenever a new track
  // list arrives (episode change, anime change).
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const tracks = player.textTracks;
    if (!tracks) return;

    // Returns the (caption-only) index of the track whose language best
    // matches `pref`, or -1 if none. Exact match wins; case-insensitive.
    const findByLang = (pref: string | null): number => {
      if (!pref) return -1;
      const want = pref.toLowerCase();
      let captionIndex = 0;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (!t) continue;
        const isCaption = t.kind === "subtitles" || t.kind === "captions";
        if (!isCaption) continue;
        const lang = (t.language || "").toLowerCase();
        if (lang === want) return captionIndex;
        captionIndex++;
      }
      return -1;
    };

    const sync = () => {
      let captionIndex = 0;
      let activeIdx = -1;
      let hasAnyShowing = false;
      let firstAvailable = -1;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (!t) continue;
        const isCaption = t.kind === "subtitles" || t.kind === "captions";
        if (!isCaption) continue;
        if (firstAvailable < 0) firstAvailable = captionIndex;
        if (t.mode === "showing") {
          activeIdx = captionIndex;
          hasAnyShowing = true;
        }
        captionIndex++;
      }

      // No track is currently showing → decide based on persisted prefs.
      if (!hasAnyShowing && firstAvailable >= 0) {
        const enabled = readPrefEnabled();
        if (enabled) {
          const pref = readPrefLang();
          const byPref = findByLang(pref);
          const byEnglish = byPref < 0 ? findByLang("en") : -1;
          const fallback = byPref >= 0 ? byPref : byEnglish >= 0 ? byEnglish : firstAvailable;
          // Apply via the same selection path so persistence stays consistent.
          selectSubtitleTrack(fallback);
          return;
        }
      }
      setActiveTrackIdx(activeIdx);
    };

    sync();
    const onChange = () => sync();
    tracks.addEventListener("add", onChange);
    tracks.addEventListener("remove", onChange);
    tracks.addEventListener("mode-change", onChange);
    return () => {
      tracks.removeEventListener("add", onChange);
      tracks.removeEventListener("remove", onChange);
      tracks.removeEventListener("mode-change", onChange);
    };
  }, [streamData]);

  // ── HLS error handler ──
  // hls.js fires `hls-error` on the player element for every load failure.
  // Most are transient (single segment timeout, etc.) and HLS retries on its
  // own. The ones we care about are FATAL errors with HTTP 401/403/404/410:
  // these mean the stream is genuinely gone (token expired, file removed) and
  // looping won't help. Bubbling those up to our `onError` lets the watch
  // page mark the server failed and pick the next one.
  useEffect(() => {
    const playerEl = playerRef.current?.el as HTMLElement | undefined;
    if (!playerEl) return;

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || !detail.fatal) return;
      const status = detail.response?.code || detail.response?.status;
      if (status === 401 || status === 403 || status === 404 || status === 410) {
        onError?.(`Stream HTTP ${status}`);
      }
    };

    playerEl.addEventListener("hls-error", handler as EventListener);
    return () => playerEl.removeEventListener("hls-error", handler as EventListener);
  }, [onError, streamData]);

  // ── Autoplay ──
  // Chrome rejects unmuted autoplay without a user gesture, period. The
  // only path that always works is muted-then-let-Chrome's-MEI-decide:
  // after a few sessions of the user watching with sound, Chrome elevates
  // the origin's autoplay policy to "allowed" and unmuted autoplay starts
  // working at refresh on its own — no client code can shortcut this.
  // So we just kick off muted playback (always accepted) and let MEI handle
  // the unmute promotion organically.
  useEffect(() => {
    if (!autoplay) return;
    const playerEl = playerRef.current?.el as HTMLElement | undefined;
    if (!playerEl) return;

    let cancelled = false;
    const tryPlay = async () => {
      if (cancelled) return;
      const video = playerEl.querySelector<HTMLVideoElement>("video");
      if (!video || !video.paused) return;
      try {
        video.setAttribute("muted", "");
        video.defaultMuted = true;
        video.muted = true;
        video.setAttribute("playsinline", "");
        await video.play();
      } catch {}
    };

    tryPlay();
    const onReady = () => tryPlay();
    playerEl.addEventListener("can-play", onReady);
    playerEl.addEventListener("loaded-data", onReady);
    return () => {
      cancelled = true;
      playerEl.removeEventListener("can-play", onReady);
      playerEl.removeEventListener("loaded-data", onReady);
    };
  }, [autoplay, streamData]);

  // ── Chromecast (Chrome / Edge / Opera) ──
  // Lazy-load the Cast SDK once, then expose the button as soon as the
  // framework is ready (matches YouTube/Netflix behavior — button visible
  // even without a receiver on the network; clicking it triggers Chrome's
  // device picker which handles the "no devices" case natively).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = window as any;

    let cleanup: (() => void) | null = null;
    let pollCancelled = false;

    const init = () => {
      try {
        const ctx = w.cast?.framework?.CastContext?.getInstance?.();
        if (!ctx) return false;
        ctx.setOptions({
          receiverApplicationId: w.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
          autoJoinPolicy: w.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
        });
        // SDK is ready → show the button regardless of current device state.
        setCastAvailable(true);
        const onState = (e: any) => {
          setCastConnected(e.value === w.cast.framework.CastState.CONNECTED);
        };
        ctx.addEventListener(
          w.cast.framework.CastContextEventType.CAST_STATE_CHANGED,
          onState
        );
        setCastConnected(ctx.getCastState() === w.cast.framework.CastState.CONNECTED);
        cleanup = () =>
          ctx.removeEventListener(
            w.cast.framework.CastContextEventType.CAST_STATE_CHANGED,
            onState
          );
        return true;
      } catch {
        return false;
      }
    };

    // Try immediately — SDK might already be loaded from a prior page.
    if (init()) return () => cleanup?.();

    // Subscribe to the SDK's ready callback. We chain (don't overwrite) any
    // existing handler so multiple players on the same page coexist.
    const prev = w.__onGCastApiAvailable;
    w.__onGCastApiAvailable = (isAvailable: boolean) => {
      if (typeof prev === "function") prev(isAvailable);
      if (isAvailable) init();
    };

    // Inject the SDK if no other player has already done so.
    if (!document.querySelector('script[src*="cast_sender.js"]')) {
      const s = document.createElement("script");
      s.src = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
      s.async = true;
      document.head.appendChild(s);
    }

    // Some browsers (Edge, hardened Chrome) don't fire __onGCastApiAvailable
    // even after the script loads. Poll for window.cast.framework as a backup.
    const poll = () => {
      if (pollCancelled) return;
      if (init()) return;
      setTimeout(poll, 500);
    };
    setTimeout(poll, 500);

    return () => {
      pollCancelled = true;
      if (cleanup) cleanup();
    };
  }, []);

  const requestCast = () => {
    const w = window as any;
    try {
      const ctx = w.cast?.framework?.CastContext?.getInstance?.();
      if (!ctx) return;
      ctx.requestSession().catch(() => {});
    } catch {}
  };

  const bestStream =
    streamData?.streams?.[0] || streamData?.sources?.[0] || null;
  const iframeSrc = streamData?.iframe || null;

  if (streamData?.error || (!bestStream && !iframeSrc)) {
    return (
      <div className="flex-center aspect-video w-full h-full bg-black text-white/50 font-karla">
        Source unavailable
      </div>
    );
  }

  // ── Iframe embeds ──
  if (iframeSrc) {
    // Vidmoly is anti-embed for non-whitelisted domains. Sending no referer
    // sometimes bypasses the check; sandbox grants the JS-redirect chain
    // permissions to actually load the player.
    const isVidmoly = /vidmoly\.(to|biz|net)/i.test(iframeSrc);
    return (
      <div className="relative h-full w-full">
        {ambientEnabled && <StaticGlow poster={poster} intense />}
        <IframeEmbed
          src={iframeSrc}
          serverId={serverId}
          onError={onError}
          referrerPolicy={isVidmoly ? "no-referrer" : "origin"}
        />
      </div>
    );
  }

  // If the extractor pre-wrapped the URL through an external proxy (vidmoly →
  // anime-proxy), use it as-is. Otherwise wrap through our local proxy.
  const src = bestStream!.directUrl
    ? bestStream!.url
    : proxied(bestStream!.url, bestStream!.referer || streamData?.referer);
  const isM3U8 =
    bestStream!.isM3U8 === true ||
    (bestStream!.isM3U8 !== false && bestStream!.url.includes(".m3u8"));

  // Download URL — same-origin endpoint that streams the actual video.
  // For HLS, we use /api/v2/download-stream which fetches m3u8 + concatenates
  // every segment into one .ts file (browser saves it as a single playable
  // video, not a useless playlist file). For MP4, /api/v2/download streams
  // the file directly.
  const safeName = downloadName.replace(/[^\w.-]/g, "_") || "anime";
  const refererParam = bestStream!.referer || streamData?.referer;
  // Unwrap anime-proxy wrapping if present — download-stream handles its own
  // anime-proxy routing per host detection.
  const innerUrl = (() => {
    try {
      const u = new URL(bestStream!.url);
      if (u.hostname.endsWith("anime-api-proxy.vercel.app")) {
        const inner = u.searchParams.get("url");
        if (inner) return inner;
      }
    } catch {}
    return bestStream!.url;
  })();
  const ext = isM3U8 ? "ts" : "mp4";
  const downloadUrl = isM3U8
    ? `/api/v2/download-stream?url=${encodeURIComponent(innerUrl)}` +
      `&filename=${encodeURIComponent(safeName + ".ts")}` +
      (refererParam ? `&referer=${encodeURIComponent(refererParam)}` : "")
    : `/api/v2/download?url=${encodeURIComponent(innerUrl)}` +
      `&filename=${encodeURIComponent(safeName + ".mp4")}` +
      (refererParam ? `&referer=${encodeURIComponent(refererParam)}` : "");

  const subtitleTracks = (streamData?.subtitles || [])
    .map((s) => {
      const url = s.file || s.url;
      if (!url) return null;
      return {
        src: proxied(url, bestStream!.referer || streamData?.referer),
        label: s.label || s.language || "Subtitle",
        language: s.language || "en",
        kind: (s.kind as any) || "subtitles",
        default: s.default,
      };
    })
    .filter(Boolean) as Array<{
      src: string;
      label: string;
      language: string;
      kind: any;
      default?: boolean;
    }>;

  return (
    // `isolation: isolate` creates a new stacking context here. Without it,
    // the ambient's z-index:-1 would slip behind elements OUTSIDE this
    // component (Servers list, episode buttons, etc.) and cover them via
    // the ambient's transform:scale() overflow. With isolate, z-index:-1
    // is clamped to "behind this component but not behind its siblings".
    <div className="relative h-full w-full" style={{ isolation: "isolate" }}>
      {ambientEnabled && <LiveAmbient playerRef={playerRef} />}

      <MediaPlayer
        ref={playerRef}
        // Note: overflow-visible (not hidden) so portaled menus (subtitles
        // settings, etc.) can extend slightly past the bottom edge of the
        // player without being clipped. The bg-black still draws the player
        // box; only stray child elements can now overflow.
        className="vds-player relative z-10 h-full w-full overflow-visible bg-black"
        src={{
          src,
          type: isM3U8 ? "application/vnd.apple.mpegurl" : "video/mp4",
        }}
        poster={poster}
        load="eager"
        playsinline
        // We deliberately don't pass `autoplay` to Vidstack — its internal
        // autoplay implementation fires before our source is necessarily
        // ready and triggers Chrome's "Unmuting failed" mitigation, which
        // can leave the player paused. We drive autoplay ourselves in the
        // effect below (muted-first, then opportunistic unmute).
        // We also don't pass `muted` — Vidstack treats it as controlled and
        // would constantly reset our manual unmute back to true on every
        // render. The effect sets `video.muted = true` directly at mount
        // (to satisfy autoplay policy) and flips to false on first user
        // activity, with no React-level reconciliation fighting back.
        volume={1}
        crossorigin="anonymous"
        aspectRatio="16/9"
        onError={() => onError?.("Playback error")}
      >
        <MediaProvider>
          {subtitleTracks.map((t, i) => (
            <Track
              key={t.src}
              src={t.src}
              kind={t.kind}
              label={t.label}
              language={t.language}
              default={t.default || i === 0}
            />
          ))}
          {/* Chapters track: a synthesised WebVTT from AniSkip's
              op/ed segments. Vidstack reads this and renders the
              seek bar as N pill-shaped <vds-slider-chapter> slots
              (styled in globals.css), matching the Miruro look. */}
          {chaptersTrackUrl && (
            <Track
              key={chaptersTrackUrl}
              src={chaptersTrackUrl}
              kind="chapters"
              default
            />
          )}
        </MediaProvider>

        <DefaultVideoLayout icons={defaultLayoutIcons} />
      </MediaPlayer>

      {/* Custom buttons portaled INTO Vidstack's bottom control group, BEFORE
          the Settings menu so the visual order is:
            [time] ...spacer... [Download] [Subs] [Cast] | [Settings] [PiP] [Fullscreen]
          We portal into the group itself but use settingsAnchorEl as the
          insertion point — when present, React inserts our nodes before it. */}
      {controlsGroupEl && createPortal(
        <CustomControls
          downloadUrl={downloadUrl}
          downloadFilename={`${safeName}.${ext}`}
          downloadExt={ext}
          onSubsClick={() => setSubMenuOpen((v) => !v)}
          hasSubtitles={subtitleTracks.length > 0}
          subBtnRef={subBtnRef}
          castAvailable={castAvailable}
          castConnected={castConnected}
          onCastClick={requestCast}
        />,
        // When we have a Settings anchor we render into a wrapper inserted
        // BEFORE it; otherwise we append at the end of the group.
        settingsAnchorEl
          ? ensureSiblingBefore(settingsAnchorEl, "moopa-custom-controls-slot")
          : controlsGroupEl
      )}

      {/* Custom toggles injected at the top of Vidstack's Settings menu.
          settingsItemsEl is set/cleared by our MutationObserver depending on
          whether the menu is currently open. */}
      {settingsItemsEl && createPortal(
        <>
          <SettingsToggleRow
            label="Autoplay"
            enabled={ctxAutoplay}
            onToggle={setAutoPlayCtx}
            // Material "play_arrow" icon — same family as the rest of the menu.
            iconPath="M8 5v14l11-7z"
          />
          <SettingsToggleRow
            label="Ambient lights"
            enabled={ctxAmbient}
            onToggle={setAmbientCtx}
            // Material "lightbulb_outline" icon.
            iconPath="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7zm2.85 11.1-.85.6V16h-4v-2.3l-.85-.6C7.8 12.16 7 10.63 7 9c0-2.76 2.24-5 5-5s5 2.24 5 5c0 1.63-.8 3.16-2.15 4.1z"
          />
        </>,
        ensureFirstChildSlot(settingsItemsEl, "moopa-toggles-slot")
      )}

      {/* Hover preview — actual video frame at the cursor position on the scrubber */}
      <HoverPreview playerRef={playerRef} src={src} isM3U8={isM3U8} />

      {/* AniSkip segment overlay + Skip button. Renders null when no
          skip data exists for the current episode AND there's no next
          episode to surface, so the chrome is unchanged for series
          AniSkip doesn't cover and one-off OVAs. */}
      <SkipOverlay
        playerRef={playerRef}
        malId={malId}
        aniListId={aniListId}
        episode={episodeNumber}
        nextEpisodeHref={nextEpisodeHref}
      />

      {/* Subtitle picker. Mounted globally (not inside the player) so it can
          float above the controls without being clipped by the player's
          `overflow: hidden`. */}
      {subMenuOpen && subtitleTracks.length > 0 && (
        <SubtitleMenu
          tracks={subtitleTracks.map((t) => ({ label: t.label, language: t.language }))}
          activeIndex={activeTrackIdx}
          onSelect={(idx) => selectSubtitleTrack(idx)}
          onClose={() => setSubMenuOpen(false)}
          onCustomize={() => setSubStyleOpen(true)}
          anchorEl={subBtnRef.current}
          playerEl={(playerRef.current?.el as HTMLElement | undefined) || null}
        />
      )}

      <SubtitleSettings open={subStyleOpen} onClose={() => setSubStyleOpen(false)} />
    </div>
  );
}

function IframeEmbed({
  src,
  serverId,
  onError,
  referrerPolicy = "origin",
}: {
  src: string;
  serverId?: string;
  onError?: (reason?: string) => void;
  referrerPolicy?: React.HTMLAttributeReferrerPolicy;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    const timeout = setTimeout(() => {
      setFailed(true);
      onError?.("Iframe didn't load within 20s");
    }, 20000);
    const iframe = iframeRef.current;
    const handleLoad = () => clearTimeout(timeout);
    iframe?.addEventListener("load", handleLoad);
    return () => {
      clearTimeout(timeout);
      iframe?.removeEventListener("load", handleLoad);
    };
  }, [src, serverId]);

  if (failed) {
    return (
      <div className="flex-center aspect-video w-full h-full bg-black text-white/50 font-karla">
        Failed to load player
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      src={src}
      className="relative z-10 aspect-video h-full w-full bg-black"
      frameBorder="0"
      scrolling="no"
      allowFullScreen
      referrerPolicy={referrerPolicy}
      allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
    />
  );
}

/* Turns an AniSkip-shaped skip list into a WebVTT chapters string
   and exposes it as a blob URL. Vidstack accepts text-track sources
   as URLs only (no inline data), so we materialise the VTT as a
   short-lived blob and revoke it on change.

   Each kept segment becomes one cue; the gaps BETWEEN segments
   become implicit "Episode" cues so Vidstack creates N+1 chapter
   slots and the seek bar splits into per-segment pills. */
const SEGMENT_NAMES: Record<string, string> = {
  op: "Intro",
  ed: "Outro",
  recap: "Recap",
};
function buildChaptersVtt(
  segments: Array<{ start: number; end: number; type: string }>,
  duration: number,
): string | null {
  if (!segments.length || duration <= 0) return null;
  // Sort + clamp so we can synthesise the "Episode" cues between
  // them. We also drop overlaps (defensive: AniSkip can occasionally
  // ship overlapping op/recap on the same episode).
  const sorted = [...segments]
    .filter((s) => s.end > s.start && s.start < duration)
    .map((s) => ({ ...s, end: Math.min(s.end, duration) }))
    .sort((a, b) => a.start - b.start);
  const cues: Array<{ start: number; end: number; name: string }> = [];
  let cursor = 0;
  for (const s of sorted) {
    if (s.start > cursor + 0.5) {
      cues.push({ start: cursor, end: s.start, name: "Episode" });
    }
    cues.push({
      start: Math.max(s.start, cursor),
      end: s.end,
      name: SEGMENT_NAMES[s.type] || s.type,
    });
    cursor = s.end;
  }
  if (cursor < duration - 0.5) {
    cues.push({ start: cursor, end: duration, name: "Episode" });
  }
  if (cues.length < 2) return null;
  const fmt = (t: number) => {
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = (t % 60).toFixed(3);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s
      .padStart(6, "0")}`;
  };
  const body = cues
    .map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.name}`)
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}

function useChaptersVtt(
  segments: Array<{ start: number; end: number; type: string }>,
): string | null {
  // We need the duration to synthesise the trailing "Episode" cue.
  // It's available from the player ref but at this point in the
  // component tree we don't have it yet; use the highest segment.end
  // as a safe lower bound — Vidstack tolerates a final cue that
  // ends before the real duration (extra time is just unlabelled).
  const duration = segments.reduce((m, s) => Math.max(m, s.end), 0);
  const vtt = buildChaptersVtt(segments, duration);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!vtt) {
      setUrl(null);
      return;
    }
    const blob = new Blob([vtt], { type: "text/vtt" });
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [vtt]);
  return url;
}
