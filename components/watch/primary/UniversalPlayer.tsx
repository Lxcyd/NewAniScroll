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
  // Same approach as LiveAmbient: element sized exactly to the player, heavy
  // CSS blur creates the visible glow by bleeding colors past its box.
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{
        zIndex: 0,
        backgroundImage: poster
          ? `url(${poster})`
          : "linear-gradient(135deg, #E94560 0%, #8E1B3B 100%)",
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
 * LiveAmbient — YouTube/Spotify-style ambient.
 * A low-res canvas is drawn from the video every frame (~30 fps), sized via
 * CSS to extend beyond the player, heavily blurred, and faded out with a
 * radial mask. Result: one coherent gradient that IS the video's colors,
 * with no visible edge/rectangle.
 */
function LiveAmbient({
  playerRef,
}: {
  playerRef: React.RefObject<MediaPlayerInstance>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let raf = 0;

    const tick = () => {
      raf = requestAnimationFrame(tick);

      const canvas = canvasRef.current;
      if (!canvas) return;

      const playerEl = playerRef.current?.el as HTMLElement | undefined;
      const video = playerEl?.querySelector("video") as HTMLVideoElement | null;
      if (!video || video.readyState < 2 || video.videoWidth === 0) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      try {
        // Draw the full frame at low res — CSS blur + mask handle smoothing
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      } catch {
        // Cross-origin taint — silently skip
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playerRef]);

  // Canvas positioned EXACTLY over the player. The CSS blur() filter extends
  // the colors ~blur_radius pixels beyond the canvas's bounding box in every
  // direction — that overflow IS the visible ambient light. The player (z-10)
  // covers the sharp center; only the blurred tail remains visible around it.
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      width={48}
      height={27}
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{
        zIndex: 0,
        filter: "blur(140px) saturate(1.8)",
        transform: "scale(1.1)",
        opacity: 0.95,
      }}
    />
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

    // Capture the bar's height at first measurement and reuse it. The bar
    // gets hidden by Vidstack as soon as our menu opens (mouse leaves the
    // bar area to enter the popover), making subsequent measurements
    // unreliable. By freezing the FIRST valid measurement we keep the menu
    // fixed where the user expects it.
    let frozenBarHeight: number | null = null;

    const measure = () => {
      const playerRect = playerEl.getBoundingClientRect();
      const anchorRect = anchorEl.getBoundingClientRect();

      // Try to read the bar height NOW; if the bar is hidden, fall back to
      // the last known value (or to the button as a last resort).
      const groups = Array.from(
        playerEl.querySelectorAll<HTMLElement>(".vds-controls-group")
      ).filter((el) => el.isConnected && el.getBoundingClientRect().height > 0);
      const topmostBarRect = groups.reduce<DOMRect | null>((best, el) => {
        const r = el.getBoundingClientRect();
        return !best || r.top < best.top ? r : best;
      }, null);

      if (topmostBarRect) {
        // Distance from bottom of player to top of bar.
        frozenBarHeight = playerRect.bottom - topmostBarRect.top;
      }

      // Bottom anchor: above the bar (or fallback to button) with 8px gap.
      const barOffset = frozenBarHeight
        ?? (playerRect.bottom - anchorRect.bottom);
      const bottom = barOffset + 8;
      const right = playerRect.right - anchorRect.right;
      const availableHeight = playerRect.height - bottom - 8;
      const maxHeight = Math.max(120, Math.min(320, availableHeight));
      setPos({ right, bottom, maxHeight });
    };

    measure();
    // Re-measure only on real layout changes (window resize, fullscreen
    // toggle), not on every Vidstack DOM tweak.
    const ro = new ResizeObserver(() => measure());
    ro.observe(playerEl);
    return () => ro.disconnect();
  }, [playerEl, anchorEl]);

  const style: React.CSSProperties = pos
    ? { position: "absolute", right: pos.right, bottom: pos.bottom, zIndex: 50 }
    : { display: "none" };
  const computedMaxHeight = pos?.maxHeight ?? 320;

  if (!playerEl) return null;

  const menuNode = (
    <div
      ref={ref}
      role="menu"
      aria-label="Subtitle track selection"
      style={{
        ...style,
        minWidth: 200,
        // Cap height to whatever fits between the controls bar (bottom anchor)
        // and the top of the player, with a small margin. Without this the
        // menu would overflow on top when the player is short (windowed mode,
        // 16:9 with low viewport height).
        maxHeight: Math.min(320, computedMaxHeight),
        backgroundColor: "rgba(20, 20, 28, 0.97)",
        backdropFilter: "blur(8px)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 8,
        boxShadow: "0 6px 24px rgba(0,0,0,0.5)",
        color: "#fff",
        fontFamily: "var(--media-font-family, sans-serif)",
        fontSize: 14,
        display: "flex",
        flexDirection: "column",
        overscrollBehavior: "contain",
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
              // Re-enable: pick the previously selected track if it's still
              // valid, else pick the first available one.
              const idx = activeIndex >= 0 ? activeIndex : 0;
              onSelect(idx);
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
  // Ambient lights toggle — defaults to true if undefined (older context).
  const ctxAmbient: boolean = watchCtx.ambientLights !== false;
  const setAmbientCtx: (v: boolean) => void = watchCtx.setAmbientLights || (() => {});
  // The user toggle wins over the prop — we leave the prop in place so
  // callers can still force-disable ambient (e.g. an embedded preview),
  // but the user setting overrides "ambient is on by default".
  const ambientEnabled = ambient && ctxAmbient;
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

  // ── Subtitle track sync ──
  // Vidstack manages text tracks via `playerRef.current.textTracks`. We mirror
  // the active track index into React state so the CC button can show whether
  // captions are on, and let the user pick a track from our custom popover.
  // selectSubtitleTrack(-1) disables captions; >=0 activates the matching one.
  const selectSubtitleTrack = (idx: number) => {
    setActiveTrackIdx(idx);
    const tracks = playerRef.current?.textTracks;
    if (!tracks) return;
    // Walk the textTracks list, only touching captions/subtitles tracks (skip
    // chapters/metadata). Index aligns with the <Track> children we render.
    let captionIndex = 0;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (!t) continue;
      const isCaption = t.kind === "subtitles" || t.kind === "captions";
      if (!isCaption) continue;
      t.mode = captionIndex === idx ? "showing" : "disabled";
      captionIndex++;
    }
  };

  // Sync state when tracks are added/changed (e.g. after Vidstack mounts).
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const tracks = player.textTracks;
    if (!tracks) return;

    const sync = () => {
      let captionIndex = 0;
      let activeIdx = -1;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (!t) continue;
        const isCaption = t.kind === "subtitles" || t.kind === "captions";
        if (!isCaption) continue;
        if (t.mode === "showing") activeIdx = captionIndex;
        captionIndex++;
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

  // ── Force-play on mount when autoplay is enabled ──
  // Vidstack's `autoplay` prop only triggers a play() at the moment the
  // source loads. If our `autoplay` value flips from false→true *after*
  // the source is already loaded (e.g. because the localStorage hydration
  // ran a tick after Vidstack mounted), the prop change is ignored. So we
  // explicitly call play() once the player exposes `play`. Safe to call
  // even if play already started — it's idempotent.
  useEffect(() => {
    if (!autoplay) return;
    const playerEl = playerRef.current?.el as HTMLElement | undefined;
    if (!playerEl) return;
    const tryPlay = () => {
      const video = playerEl.querySelector<HTMLVideoElement>("video");
      if (!video || !video.paused) return;
      // Always start muted to satisfy autoplay policy on cold loads — if
      // sound is currently allowed (warm nav), the unmute hook below will
      // flip it back at the first user gesture.
      try { video.muted = true; } catch {}
      video.play?.().catch(() => {});
    };
    // Try right now (in case the source is already ready).
    tryPlay();
    // Try again after each canplay/loadeddata in case the source loads
    // asynchronously after this hook runs.
    const onReady = () => tryPlay();
    playerEl.addEventListener("can-play", onReady);
    playerEl.addEventListener("loaded-data", onReady);
    return () => {
      playerEl.removeEventListener("can-play", onReady);
      playerEl.removeEventListener("loaded-data", onReady);
    };
  }, [autoplay, streamData]);

  // ── Autoplay unmute strategy ──
  // Chrome/Firefox have two relevant rules:
  //   A. Muted autoplay is always allowed.
  //   B. Programmatic `video.muted = false` BEFORE a user gesture
  //      (pointerdown / keydown / touchstart) gets punished: the browser
  //      pauses the video as a security mitigation.
  //
  // Some events DON'T count as a gesture for rule B even though they're
  // "interactions": mousemove, wheel, scroll. So we only attempt unmute on
  // gesture-qualifying events.
  //
  // Defense-in-depth: if the unmute attempt still ends up pausing the
  // video (race conditions, Safari, etc.), we detect the pause and
  // immediately resume — muted again — so the picture stays moving.
  useEffect(() => {
    if (!autoplay) return;
    const playerEl = playerRef.current?.el as HTMLElement | undefined;
    if (!playerEl) return;

    let done = false;
    let lastUnmuteAt = 0;

    const tryUnmute = () => {
      if (done) return;
      const video = playerEl.querySelector<HTMLVideoElement>("video");
      if (!video) return;
      if (!video.muted) {
        done = true;
        return;
      }
      try {
        lastUnmuteAt = Date.now();
        video.muted = false;
        video.volume = 1;
        if (!video.muted) done = true;
      } catch {}
    };

    // If our unmute pauses the video (Chrome's mitigation), revert the
    // mute and resume play within a tick. The user keeps watching the
    // picture; they can click the volume button to unmute when ready.
    const onPause = () => {
      if (Date.now() - lastUnmuteAt > 500) return; // not from our unmute
      const video = playerEl.querySelector<HTMLVideoElement>("video");
      if (!video) return;
      try {
        video.muted = true;
        // Reset the latch so the next gesture can try again.
        done = false;
        lastUnmuteAt = 0;
        video.play?.().catch(() => {});
      } catch {}
    };

    // Only proper user gestures (pointerdown/keydown/touchstart) qualify
    // for unmute. mousemove/wheel/scroll do NOT — using them triggers the
    // pause-mitigation. We listen in capture to fire before Vidstack.
    const opts = { capture: true } as AddEventListenerOptions;
    document.addEventListener("pointerdown", tryUnmute, opts);
    document.addEventListener("keydown", tryUnmute, opts);
    document.addEventListener("touchstart", tryUnmute, opts);
    playerEl.addEventListener("pause", onPause);

    return () => {
      document.removeEventListener("pointerdown", tryUnmute, opts);
      document.removeEventListener("keydown", tryUnmute, opts);
      document.removeEventListener("touchstart", tryUnmute, opts);
      playerEl.removeEventListener("pause", onPause);
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
    <div className="relative h-full w-full">
      {ambientEnabled && (
        <>
          <StaticGlow poster={poster} />
          <LiveAmbient playerRef={playerRef} />
        </>
      )}

      <MediaPlayer
        ref={playerRef}
        className="vds-player relative z-10 h-full w-full overflow-hidden bg-black"
        src={{
          src,
          type: isM3U8 ? "application/vnd.apple.mpegurl" : "video/mp4",
        }}
        poster={poster}
        load="eager"
        playsinline
        autoplay={autoplay}
        // We deliberately don't pass `muted` here. Vidstack treats `muted`
        // as a controlled prop and would constantly reset our manual unmute
        // back to true on every render. Instead, the effect below sets
        // `video.muted = true` directly at mount (to satisfy autoplay
        // policy on cold load) and flips to false on first user activity,
        // without any React-level reconciliation fighting back.
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
