import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";

import { useEffect, useRef, useState } from "react";
// @ts-ignore — react-dom types not installed but createPortal is exported
import { createPortal } from "react-dom";
import {
  MediaPlayer,
  MediaProvider,
  Track,
  useMediaState,
  isHLSProvider,
  type MediaPlayerInstance,
  type MediaProviderChangeEvent,
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
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { VIDSTACK_FR } from "@/lib/i18n/vidstackFr";

type Stream = {
  url: string;
  quality?: string;
  isM3U8?: boolean;
  referer?: string;
  /** Skip our local /api/v2/proxy/m3u8 — URL is already through an external
   *  proxy that handles CORS + segment rewriting (e.g. anime-proxy for vidmoly). */
  directUrl?: boolean;
  /** Origin doesn't send Access-Control-Allow-Origin headers (sibnet's cvn
   *  CDN is the canonical case). The <video> element has to be created
   *  WITHOUT `crossorigin="anonymous"` or every Range fetch is blocked by
   *  the browser. Side effect: the canvas-based LiveAmbient sampler can't
   *  read pixel data for this source (tainted canvas), so it falls back
   *  to StaticGlow — small UX cost for actually playing the video. */
  noCors?: boolean;
  /** Set by the VOE extractor: DDoS-Guard cookie captured at extraction time.
   *  Forwarded to the proxy as `vcookie=` so the Cloudflare Worker (which has
   *  no shared in-memory state with the extractor) can authenticate against
   *  cloudwindow-route. */
  voeCookie?: string | null;
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
  /** Server hands the browser an embed URL to fetch itself, so the IP-bound
   *  master.m3u8 token is issued to the user's IP — segments then stream
   *  straight from the host CDN with no proxy. UniversalPlayer runs the
   *  extractor on mount; if it fails, falls back to the iframe field. */
  clientExtract?: { type: "vidmoly"; embedUrl: string };
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
  /** MAL id for the anime — used as the AniSkip fallback key. Null
   *  when MAL doesn't have a matching entry (rare). */
  malId?: number | null;
  /** AniList id — preferred lookup key (our skip proxy hits
   *  Anime-Skip with this via findShowsByExternalId). */
  aniListId?: number | null;
  /** 1-based episode number for the skip-times lookup. */
  episodeNumber?: number;
};

// Proxy base — defaults to the in-tree Vercel endpoint, but production should
// override via NEXT_PUBLIC_PROXY_BASE (a Cloudflare Worker URL, see worker/).
// Workers have unmetered bandwidth and an automatic edge cache; the Vercel
// proxy meters every byte against Fast Origin Transfer.
const PROXY_BASE =
  (typeof process !== "undefined" &&
    (process as any).env?.NEXT_PUBLIC_PROXY_BASE) ||
  "/api/v2/proxy/m3u8";

// hls.js tuning for snappy seeking. The defaults buffer only ~30s ahead and
// keep almost no back-buffer, so every seek forces a fresh network round-trip —
// and each megaplay segment goes through our proxy → CDN. That round-trip is
// fast for popular titles (JJK: edge-cached at the Worker) but slow for less
// popular ones (SnK / Demon Slayer: cache miss → origin fetch). The fix is to
// buffer far MORE aggressively so a seek usually lands in data we already
// fetched, and to prefetch ahead of playback so the buffer stays deep.
//
// (An earlier version cut these buffers + dropped startFragPrefetch to chase
// the "video resets near the end" bug. That bug's real cause was elsewhere —
// the chapters-VTT blob being rebuilt on a sub-second durationchange, since
// fixed by quantizing the duration — so the buffer cuts were unnecessary and
// just made seeking slow. Restored here.)
const HLS_CONFIG = {
  lowLatencyMode: false,
  // Buffer well ahead so forward seeks land in already-fetched data. The byte
  // cap (maxBufferSize) is the real ceiling for HD; the seconds caps just let
  // hls.js keep filling when bandwidth is there.
  maxBufferLength: 60,
  maxMaxBufferLength: 240,
  maxBufferSize: 120 * 1000 * 1000, // 120 MB — freed on player unmount
  // Keep a deep back-buffer so rewinds / small back-seeks are instant too.
  backBufferLength: 90,
  // Prefetch the first fragment before playback starts and keep the loader
  // working ahead of the playhead — the biggest win for "click far ahead and it
  // loads fast". Safe now that the end-reset cause is fixed.
  startFragPrefetch: true,
  // Tolerate slow CDN segments a bit longer before giving up, but still fail
  // fast enough that a genuinely dead segment doesn't hang the seek.
  fragLoadingMaxRetry: 6,
  fragLoadingRetryDelay: 500,
  fragLoadingMaxRetryTimeout: 10000,
  // Don't stall on tiny gaps between segments (some megaplay encodes have a few
  // ms of PTS drift at boundaries); jump them instead of buffering forever.
  maxBufferHole: 0.5,
};

function proxied(
  url: string,
  referer?: string | null,
  voeCookie?: string | null,
): string {
  if (!url) return url;
  const ref = referer ? `&referer=${encodeURIComponent(referer)}` : "";
  const ck = voeCookie ? `&vcookie=${encodeURIComponent(voeCookie)}` : "";
  return `${PROXY_BASE}?url=${encodeURIComponent(url)}${ref}${ck}`;
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
  const { t } = useTranslation();
  return (
    <>
      <a
        href={downloadUrl}
        download={downloadFilename}
        title={
          downloadExt === "m3u8"
            ? t("player.downloadPlaylist")
            : `${t("player.download")} ${downloadExt.toUpperCase()}`
        }
        aria-label={t("player.download")}
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
          title={t("player.subtitles")}
          aria-label={t("player.subtitles")}
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
          title={castConnected ? t("player.casting") : t("player.cast")}
          aria-label={t("player.cast")}
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
  const { t } = useTranslation();
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

    // Re-measure on every mount AND on a microtask after, since
    // Vidstack may animate the controls bar in/out and the anchor's
    // box can shift in the same frame the menu opens. Two ticks gives
    // us the post-animation resting position.
    const measure = () => {
      // We work in VIEWPORT coordinates (and pair this with `position:
      // fixed` on the menu) because the player root is `position:
      // static`, so `position: absolute` would otherwise resolve
      // against an unrelated ancestor.
      const playerRect = playerEl.getBoundingClientRect();
      const anchorRect = anchorEl.getBoundingClientRect();

      // Anchor the menu's RIGHT edge to the CC button's right edge —
      // matches how Vidstack's Settings menu aligns to its own button.
      const right = Math.max(8, window.innerWidth - anchorRect.right);
      // Anchor the menu's BOTTOM to ~8 px above the button top, same
      // vertical alignment as the native chapters / settings menus.
      const bottom = Math.max(
        8,
        window.innerHeight - anchorRect.top + 8,
      );
      const availableHeight = anchorRect.top - playerRect.top - 16;
      const maxHeight = Math.max(
        120,
        Math.min(Math.floor(playerRect.height * 0.6), availableHeight),
      );
      setPos({ right, bottom, maxHeight });
    };
    measure();
    const r = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(r);
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
      aria-label={t("player.subtitleTrackSelection")}
      // Tag with Vidstack's menu class + aria-hidden="false" so the
      // rest of the layer (notably SkipOverlay's auto-hide observer)
      // treats this popover as a first-class Vidstack menu and the
      // Skip / Next Episode buttons fade out while it's open — same
      // behaviour as the chapters / settings menus.
      className="vds-menu-items"
      aria-hidden="false"
      style={{
        position: "fixed",
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
              // Re-enable: persisted lang → French → English → first track.
              // Same priority order as the on-mount sync so the toggle never
              // silently picks an unexpected track.
              let pickedIdx = -1;
              try {
                const wantLang = (localStorage.getItem("moopa.subs.lang") || "").toLowerCase();
                const find = (code: string) =>
                  tracks.findIndex(
                    (t) => (t.language || "").toLowerCase() === code
                  );
                if (wantLang) pickedIdx = find(wantLang);
                if (pickedIdx < 0) pickedIdx = find("fr");
                if (pickedIdx < 0) pickedIdx = find("en");
              } catch {}
              if (pickedIdx < 0) pickedIdx = activeIndex >= 0 ? activeIndex : 0;
              onSelect(pickedIdx);
            } else {
              onSelect(-1);
            }
          }}
        />
        {/* Customize subtitles shortcut sits right under the master
            toggle now (used to live in a pinned footer) — keeps the
            primary "styling" action close to the on/off switch and
            puts the long language list below where it belongs. */}
        <SubMenuRow
          label={t("player.customizeSubtitles")}
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
        {tracks.map((tr, i) => {
          const isActive = activeIndex === i;
          return (
            <SubMenuRow
              key={`${tr.language}-${i}`}
              label={tr.label || tr.language || t("player.track", { n: i + 1 })}
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
  const { t } = useTranslation();
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
      <span style={{ flex: 1, fontWeight: 500 }}>{t("player.subtitles")}</span>
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

// Action row (vs toggle row): used on small layout to surface Download /
// Subs / Cast as plain Settings-menu items, since the bottom bar is too
// narrow on phones to host them as standalone buttons. Either renders a
// download link OR fires an onClick — exactly one of `href` / `onClick`
// is required.
function SettingsActionRow({
  label,
  iconPath,
  href,
  downloadFilename,
  onClick,
}: {
  label: string;
  iconPath: string;
  href?: string;
  downloadFilename?: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <svg
        viewBox="0 0 24 24"
        fill="currentColor"
        style={{ width: 22, height: 22, marginRight: 6, flexShrink: 0 }}
      >
        <path d={iconPath} />
      </svg>
      <span style={{ flex: 1 }}>{label}</span>
    </>
  );
  const sharedStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    cursor: "pointer",
    userSelect: "none",
    color: "inherit",
    textDecoration: "none",
  };
  if (href) {
    return (
      <a
        role="menuitem"
        tabIndex={0}
        className="vds-menu-button"
        href={href}
        download={downloadFilename}
        style={sharedStyle}
      >
        {content}
      </a>
    );
  }
  return (
    <div
      role="menuitem"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
      className="vds-menu-button"
      style={sharedStyle}
    >
      {content}
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
  const { t, i18n } = useTranslation();
  const playerRef = useRef<MediaPlayerInstance>(null);
  // Live hls.js instance — captured on provider setup so the seek handler can
  // abort in-flight segment loads and re-anchor on the new position.
  const hlsRef = useRef<any>(null);

  // Identity-stable caches for the <MediaPlayer> `src` object and the subtitle
  // <Track> list. These MUST keep the same object identity across re-renders
  // that don't change the underlying value — handing Vidstack a new `src` object
  // makes it fire provider-change and reload from 0 (the end-reset bug). We
  // can't use useMemo for them because they're computed AFTER the loading/iframe
  // early-returns below, and a conditionally-called hook breaks rules-of-hooks.
  // A ref-backed memo keyed on a string signature is unconditional and safe.
  const srcMemoRef = useRef<{ key: string; value: { src: string; type: "application/vnd.apple.mpegurl" | "video/mp4" } } | null>(null);
  const subsMemoRef = useRef<{ key: string; value: any[] } | null>(null);

  // Apply our hls.js tuning the moment the HLS provider is created. Setting
  // `provider.config` here (before setup) makes hls.js build its instance with
  // the bigger buffers / fast-fail loading defined in HLS_CONFIG, so seeking
  // is responsive. No-op for the native MP4 provider.
  const onProviderChange = (
    provider: any,
    _event: MediaProviderChangeEvent,
  ) => {
    if (isHLSProvider(provider)) {
      provider.config = { ...provider.config, ...HLS_CONFIG };
    }
  };

  // Capture the hls.js instance once Vidstack has set the provider up.
  const onProviderSetup = (provider: any) => {
    if (isHLSProvider(provider)) {
      hlsRef.current = provider.instance || null;
    }
  };

  const [subMenuOpen, setSubMenuOpen] = useState(false);
  const [subStyleOpen, setSubStyleOpen] = useState(false);
  // ── Mobile / iOS detection ─────────────────────────────────
  // Touch the platform exactly once so the player can:
  //  - Reroute custom buttons (Download / Subs / Cast) into the Settings
  //    menu on phones — the bottom bar is too narrow to fit them next to
  //    Time + Fullscreen without overflowing.
  //  - Bypass iOS Safari's native fullscreen (which swaps in the system
  //    video player and hides every overlay we draw). Pseudo-fullscreen
  //    via CSS keeps our chrome on screen.
  const [isIOS, setIsIOS] = useState(false);
  const [isSmallLayout, setIsSmallLayout] = useState(false);
  // iOS pseudo-fullscreen — Safari hides our buttons in real fullscreen
  // because it swaps the <video> for the native player. We pin the
  // wrapper to viewport with `position:fixed` and lock orientation.
  const [iosPseudoFs, setIosPseudoFs] = useState(false);
  useEffect(() => {
    const ua = navigator.userAgent || "";
    // iPadOS 13+ identifies as MacIntel with maxTouchPoints > 1.
    const ios =
      /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === "MacIntel" && (navigator as any).maxTouchPoints > 1);
    setIsIOS(ios);
    const mq = window.matchMedia("(max-width: 576px)");
    const sync = () => setIsSmallLayout(mq.matches);
    sync();
    mq.addEventListener?.("change", sync);
    return () => mq.removeEventListener?.("change", sync);
  }, []);
  // Index of the active text track in the subtitleTracks list. -1 = subtitles off.
  const [activeTrackIdx, setActiveTrackIdx] = useState(-1);
  // ── Client-side extraction state ──
  // When streamData.clientExtract is set, the server is asking the browser to
  // do the embed-page fetch itself so the resulting CDN token IP-binds to the
  // user, not to any proxy. While this runs we render a tiny loading frame;
  // on success we swap in the extracted stream; on failure we fall through
  // to the iframe fallback (streamData.iframe is set in tandem).
  const [clientStream, setClientStream] = useState<Stream | null>(null);
  const [clientStatus, setClientStatus] = useState<
    "idle" | "pending" | "ok" | "failed"
  >("idle");
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
  // Real video duration drives the trailing "Episode" cue. We read
  // `useMediaState("duration")` (the value Vidstack uses for its own
  // seek bar — same denominator the chapter pills are scaled against)
  // rather than the HTML element's `duration` property, otherwise the
  // pills get scaled against one number while the slider geometry
  // uses another, and everything visually drifts.
  const videoDuration = useMediaState("duration", playerRef);
  // Reactive volume + muted — same proven hook as `videoDuration`, reading
  // Vidstack's $state (the actual values). Drive the persistence effect below.
  const volumeState = useMediaState("volume", playerRef);
  const mutedState = useMediaState("muted", playerRef);
  const chaptersTrackUrl = useChaptersVtt(skipTimes, videoDuration);
  // No JS click-compensation anymore: the chapter pills now use a transparent
  // border (not a margin) for the inter-pill gap, so they keep their full
  // geometric width and Vidstack's native click→time mapping is exact. The old
  // compensation raced Vidstack's own seek and produced a ~1s visible drift.

  // Current chapter title — computed ourselves rather than relying on
  // Vidstack's built-in <ChapterTitle>. Its title comes from a reactive
  // `activeCue` signal that only emits on a value CHANGE; the first cue is
  // active at load but is the signal's initial value, so it's never emitted
  // and the label stays blank until playback transitions into the second cue
  // (confirmed: entering the intro then returning to pill 1 makes it appear).
  // We read the active chapter cue against currentTime directly, so the right
  // title shows from the first frame and on every pill.
  const chapterTitle = useActiveChapterTitle(playerRef, chaptersTrackUrl);

  // Drive Vidstack's native chapter-title element with our computed value.
  // Vidstack's own element only fills in after the first cue transition, so
  // we write the correct title into it directly. The element keeps its
  // existing position/styling in the control bar (next to the time); we only
  // override its text content so the first pill shows a label too.
  useEffect(() => {
    const root = playerRef.current?.el as HTMLElement | undefined;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(".vds-chapter-title");
    if (!el) return;

    // Vidstack writes the active cue's own text into this element on a delay
    // (one transition behind), so a plain textContent assignment races with
    // Vidstack and can leave both labels in the DOM → "ÉpisodeEpisode".
    // We own the element: write our value, then keep it pinned with a
    // MutationObserver that re-applies our text whenever Vidstack mutates it.
    let applying = false;
    const apply = () => {
      if (el.textContent === chapterTitle) return;
      applying = true;
      el.textContent = chapterTitle;
      applying = false;
    };
    apply();
    const obs = new MutationObserver(() => {
      if (!applying) apply();
    });
    obs.observe(el, { childList: true, characterData: true, subtree: true });
    return () => obs.disconnect();
  }, [chapterTitle]);
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
  const ambientEnabled = ambient && ctxAmbient && !isFullscreen && !iosPseudoFs;
  const [castAvailable, setCastAvailable] = useState(false);
  const [castConnected, setCastConnected] = useState(false);

  // STABLE portal hosts. We portal our custom buttons / settings rows into
  // these divs (whose children ONLY React manages) and then position the divs
  // inside Vidstack's controls group / settings menu imperatively. Vidstack
  // rebuilding its own subtree (it does so even on a benign `durationchange`
  // near the end of playback) detaches our host as a single unit but never
  // touches React's children inside it — so React never has to remove a node
  // that Vidstack already removed. That `removeChild` throw was what tripped the
  // PlayerErrorBoundary → player remount → HLS reload from 0 ("video resets to
  // the start near the end"). Stable containers eliminate it at the source.
  const controlsHostRef = useRef<HTMLDivElement | null>(null);
  const settingsHostRef = useRef<HTMLDivElement | null>(null);
  if (typeof document !== "undefined") {
    if (!controlsHostRef.current) {
      const d = document.createElement("div");
      d.dataset.slot = "moopa-custom-controls-host";
      d.style.display = "contents";
      controlsHostRef.current = d;
    }
    if (!settingsHostRef.current) {
      const d = document.createElement("div");
      d.dataset.slot = "moopa-settings-host";
      d.style.display = "contents";
      settingsHostRef.current = d;
    }
  }
  // Whether each host is currently attached into the live Vidstack subtree.
  // Drives the conditional portal render; flipping these never unmounts the
  // <video>, only re-targets our injected chrome.
  const [controlsHostAttached, setControlsHostAttached] = useState(false);
  const [settingsHostAttached, setSettingsHostAttached] = useState(false);

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
      // iOS Safari only honours inline playback when BOTH `playsinline` and
      // the legacy `webkit-playsinline` attribute are present at the time of
      // first play. The React `playsInline` prop only writes the modern one,
      // so older iOS builds fall back to the native fullscreen player on tap.
      if (video) {
        if (!video.hasAttribute("playsinline")) video.setAttribute("playsinline", "");
        if (!video.hasAttribute("webkit-playsinline"))
          video.setAttribute("webkit-playsinline", "");
        // Tell Safari we'll handle remote playback ourselves so it doesn't
        // pop the AirPlay picker the moment the user enters fullscreen.
        if (!video.hasAttribute("x-webkit-airplay"))
          video.setAttribute("x-webkit-airplay", "allow");
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

      // Position the STABLE controls host inside the live group, before the
      // Settings menu. We move the host node (a single unit) — React's content
      // inside it is never disturbed, so no portal teardown / removeChild.
      const controlsHost = controlsHostRef.current;
      if (bottom && controlsHost && !isSmallLayout) {
        const anchor =
          bottom.querySelector<HTMLElement>(".vds-settings-menu") ||
          bottom.querySelector<HTMLElement>("media-menu.vds-menu") ||
          bottom.querySelector<HTMLElement>("[data-class*='settings']") ||
          bottom.querySelector<HTMLElement>(".vds-pip-button") ||
          null;
        // Re-insert only if the host isn't already correctly placed (avoids
        // needless DOM churn on every observer callback).
        if (anchor) {
          if (controlsHost.parentElement !== bottom || controlsHost.nextSibling !== anchor) {
            bottom.insertBefore(controlsHost, anchor);
          }
        } else if (controlsHost.parentElement !== bottom) {
          bottom.appendChild(controlsHost);
        }
        setControlsHostAttached((p) => (p ? p : true));
      } else {
        // No group (or small layout) — detach the host. React content survives
        // in the orphaned node; flipping the flag just hides the chrome.
        if (controlsHost?.parentElement) controlsHost.remove();
        setControlsHostAttached((p) => (p ? false : p));
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
      // Position the STABLE settings host as the first child of the menu list.
      const settingsHost = settingsHostRef.current;
      if (itemsEl && settingsHost) {
        if (settingsHost.parentElement !== itemsEl || itemsEl.firstChild !== settingsHost) {
          itemsEl.insertBefore(settingsHost, itemsEl.firstChild);
        }
        setSettingsHostAttached((p) => (p ? p : true));
      } else {
        if (settingsHost?.parentElement) settingsHost.remove();
        setSettingsHostAttached((p) => (p ? false : p));
      }
    };

    setup();

    return () => {
      cancelled = true;
      obs?.disconnect();
    };
    // `isSmallLayout` gates whether the controls host attaches to the bar, so
    // re-run the locator when the breakpoint flips.
  }, [isSmallLayout]);

  // ── iOS fullscreen interception ──
  // Safari on iPhone/iPad responds to a fullscreen request by handing the
  // <video> off to the system player, which hides every overlay we draw
  // (Skip / Next / custom buttons). Intercept the Vidstack fullscreen
  // button at capture phase, block the native handler, and toggle a
  // CSS pseudo-fullscreen on our wrapper. Orientation lock is best-effort
  // — Safari only allows it after a user gesture inside a real fullscreen.
  useEffect(() => {
    if (!isIOS) return;
    const playerEl = playerRef.current?.el as HTMLElement | undefined;
    if (!playerEl) return;

    // Block Vidstack's fullscreen on the button across EVERY event it might
    // act on. On touch devices Vidstack triggers fullscreen on pointerup, so
    // intercepting `click` alone is too late (the native iOS player has
    // already opened). We veto pointerup/touchend/click in the capture phase
    // and only toggle the native fullscreen flag ONCE per tap (pointerup),
    // letting the others just suppress the default + propagation.
    const hitFsButton = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (!t) return null;
      return t.closest<HTMLElement>(
        ".vds-fullscreen-button, [data-fullscreen-button], button[aria-label*='ullscreen']",
      );
    };
    const suppress = (e: Event) => {
      if (!hitFsButton(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onPointerUp = (e: Event) => {
      if (!hitFsButton(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setIosPseudoFs((v) => !v);
    };
    // Capture phase so we beat Vidstack's own handlers.
    playerEl.addEventListener("pointerup", onPointerUp, { capture: true });
    playerEl.addEventListener("touchend", suppress, { capture: true });
    playerEl.addEventListener("click", suppress, { capture: true });

    // Intercepting the fullscreen BUTTON isn't enough: iOS also pushes the
    // <video> into its system fullscreen player via other paths (tap-to-play
    // on some versions, the native mini-controls, AirPlay handoff…). Each of
    // those fires `webkitbeginfullscreen` on the <video>. We catch it, bail
    // out of the native player immediately, and switch to our own CSS
    // pseudo-fullscreen so our controls/overlays stay visible.
    let boundVideo: HTMLVideoElement | null = null;
    const onBeginFs = () => {
      try {
        (boundVideo as any)?.webkitExitFullscreen?.();
      } catch {}
      setIosPseudoFs(true);
    };
    // The <video> is created by the provider slightly after this effect runs,
    // so poll a few frames until it exists, then bind the listener once.
    let raf = 0;
    const bind = () => {
      const v = playerEl.querySelector<HTMLVideoElement>("video");
      if (!v) {
        raf = requestAnimationFrame(bind);
        return;
      }
      boundVideo = v;
      v.addEventListener("webkitbeginfullscreen", onBeginFs);
    };
    bind();

    return () => {
      playerEl.removeEventListener("pointerup", onPointerUp, { capture: true });
      playerEl.removeEventListener("touchend", suppress, { capture: true });
      playerEl.removeEventListener("click", suppress, { capture: true });
      cancelAnimationFrame(raf);
      boundVideo?.removeEventListener("webkitbeginfullscreen", onBeginFs);
    };
  }, [isIOS]);

  // Lock body scroll while iOS pseudo-fullscreen is active and try to
  // rotate the screen to landscape — same UX as the native player.
  useEffect(() => {
    if (!iosPseudoFs) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    try {
      (screen.orientation as any)?.lock?.("landscape").catch(() => {});
    } catch {}
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIosPseudoFs(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      try {
        (screen.orientation as any)?.unlock?.();
      } catch {}
      window.removeEventListener("keydown", onKey);
    };
  }, [iosPseudoFs]);

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

  // ── Keep controls visible in iOS pseudo-fullscreen ──
  // Exiting pseudo-fullscreen is done by re-tapping the fullscreen button. If
  // Vidstack's idle auto-hide hides the bar (after ~2s), the first tap only
  // re-reveals it and the exit tap is lost — the user gets stuck. Pinning the
  // controls visible (controls.pause) for the whole pseudo-fullscreen session
  // keeps the fullscreen button on screen so a single tap always exits.
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !iosPseudoFs) return;
    try { (player as any).controls?.pause?.(); } catch {}
    return () => {
      try { (player as any).controls?.resume?.(); } catch {}
    };
  }, [iosPseudoFs]);

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

  // Tracks the site language across renders so we can tell a genuine
  // language SWITCH (user flipped FR↔EN mid-session) from a normal mount.
  // On a switch we force the subtitle to the new site language even over a
  // previously saved manual pick; on a plain mount the saved pick wins.
  const prevLangRef = useRef(i18n.language);

  // Sync state when tracks are added/changed (e.g. after Vidstack mounts).
  // Also auto-apply the persisted language preference whenever a new track
  // list arrives (episode change, anime change).
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const tracks = player.textTracks;
    if (!tracks) return;

    // Did the SITE language just change (vs a re-run from a source change)?
    const langSwitched = prevLangRef.current !== i18n.language;
    prevLangRef.current = i18n.language;

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

    // Apply our language preference exactly once per source. Crucially we do
    // this EVEN when a track is already "showing" — megaplay ships its English
    // track with `default: true`, so Vidstack auto-shows it before we run, and
    // gating on "nothing showing yet" meant we never overrode it. After this
    // first authoritative pass we step back and only mirror manual changes.
    let prefApplied = false;

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

      // First authoritative pass for this source: pick the track that matches
      // the user's saved language, else the SITE language default:
      //   - site FR → French, then English, then first track.
      //   - site EN → English, then first track.
      if (!prefApplied && firstAvailable >= 0) {
        const enabled = readPrefEnabled();
        if (enabled) {
          const siteIsFrench = i18n.language === "fr";
          // On a site-language switch, force the new language and IGNORE the
          // saved manual pick (the user just expressed a stronger preference
          // by switching the whole site). On a normal mount the saved pick wins.
          const pref = langSwitched ? null : readPrefLang();
          const byPref = findByLang(pref);
          let resolved = byPref;
          if (resolved < 0 && siteIsFrench) resolved = findByLang("fr");
          if (resolved < 0) resolved = findByLang("en");
          if (resolved < 0 && siteIsFrench) resolved = findByLang("fr");
          const target = resolved >= 0 ? resolved : firstAvailable;
          prefApplied = true;
          // Only re-select if it isn't already the showing track — avoids a
          // redundant mode-change event loop.
          if (target !== activeIdx) {
            selectSubtitleTrack(target);
            return;
          }
          setActiveTrackIdx(target);
          return;
        }
        // Subtitles disabled by preference → turn everything off once.
        if (hasAnyShowing) {
          prefApplied = true;
          selectSubtitleTrack(-1);
          return;
        }
        prefApplied = true;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamData, i18n.language]);

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

  // NOTE: the earlier "end-reset guard" (watching for seek/reload to 0 near the
  // end) was removed. A full event trace proved the real cause was NOT the
  // HLS/media layer: a benign `durationchange` near the end made Vidstack
  // rebuild its controls subtree, which threw `removeChild` from a React portal
  // whose container Vidstack had just destroyed. The PlayerErrorBoundary caught
  // that and REMOUNTED the player → the HLS source reloaded from currentTime 0.
  // Fixed at the source by portaling our chrome into stable host nodes we own
  // (see controlsHostRef / settingsHostRef), so Vidstack rebuilds no longer
  // tear down our portals and the boundary never fires.

  // ── Spam-seek coalescing ──
  // A single seek is handled fine by hls.js natively, so we leave it alone.
  // But when the user SPAMS the scrub bar, every click lands on an unbuffered
  // spot and kicks off a fresh segment fetch; on a slow/cache-miss CDN those
  // stack up and the player appears to "load for a long time" before it settles
  // on the last position. We detect rapid consecutive seeks and, on the 2nd+
  // one, immediately `stopLoad()` (which aborts the in-flight fragment request
  // — closing its connection so we stop waiting on a fetch the user already
  // skipped past) and then, once the user stops moving for ~180ms, `startLoad()`
  // at the FINAL position. Net effect: only the position you land on gets
  // fetched, instead of every spot you flew over. We never touch the isolated
  // single-seek path, so normal seeking keeps hls.js's native (no-extra-latency)
  // behaviour.
  useEffect(() => {
    const playerEl = playerRef.current?.el as HTMLElement | undefined;
    if (!playerEl) return;

    let video: HTMLVideoElement | null = null;
    let seekCount = 0;
    let lastSeekAt = 0;
    let settleTimer = 0;

    const onSeeking = () => {
      const hls = hlsRef.current;
      if (!hls || !video) return;
      const now = performance.now();
      seekCount = now - lastSeekAt < 450 ? seekCount + 1 : 1;
      lastSeekAt = now;
      if (seekCount < 2) return; // isolated seek → let hls.js handle it natively

      // Spam: drop whatever fragment is mid-flight right now…
      try { hls.stopLoad(); } catch {}
      window.clearTimeout(settleTimer);
      // …and resume loading only once the user settles, at the final spot.
      settleTimer = window.setTimeout(() => {
        try { hls.startLoad(video!.currentTime); } catch {}
        seekCount = 0;
      }, 180);
    };

    let pollId = 0;
    const bind = () => {
      video = playerEl.querySelector<HTMLVideoElement>("video");
      if (!video) return false;
      video.addEventListener("seeking", onSeeking);
      return true;
    };
    if (!bind()) {
      let tries = 0;
      pollId = window.setInterval(() => {
        if (bind() || ++tries > 40) window.clearInterval(pollId);
      }, 250);
    }

    return () => {
      window.clearTimeout(settleTimer);
      window.clearInterval(pollId);
      video?.removeEventListener("seeking", onSeeking);
    };
  }, [streamData]);

  // ── Client-side extraction runner ──
  // Vidmoly's master.m3u8 token is bound to whichever IP fetched the embed
  // page. Doing that fetch from the browser (instead of any server-side
  // proxy) means the token authorises the user's IP — segments then stream
  // direct from the vidmoly CDN, no Worker / Fly / Vercel FOT in the path.
  // We trigger the dynamic import only when this codepath is needed so the
  // extractor module isn't shipped to users of every other server.
  useEffect(() => {
    const ce = streamData?.clientExtract;
    if (!ce || ce.type !== "vidmoly") {
      setClientStatus("idle");
      setClientStream(null);
      return;
    }
    setClientStatus("pending");
    setClientStream(null);
    const ac = new AbortController();
    // Hard timeout: the browser fetch to vidmoly can hang on iOS (slow/blocked
    // CORS preflight with no fast rejection), leaving us stuck on "Loading…"
    // forever with no iframe fallback. After 6s we give up and mark the client
    // extraction failed so the iframe path takes over. We track the timeout
    // abort separately from the cleanup abort: only the former should flip to
    // "failed" (a cleanup abort means the component/source went away).
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, 6000);
    (async () => {
      try {
        const mod = await import("@/lib/clientVidmoly");
        const res = await mod.extractVidmolyClient(ce.embedUrl, {
          signal: ac.signal,
        });
        // Timeout fired: the extractor resolves with {error:"aborted"} (it
        // swallows the AbortError internally), so we must flip to "failed"
        // HERE — before the generic aborted-guard below — or we'd stay stuck
        // on "pending" and never reach the iframe fallback.
        if (timedOut) {
          console.warn("[UniversalPlayer] client vidmoly timed out → iframe");
          setClientStatus("failed");
          return;
        }
        // Cleanup abort (unmount / source change): drop the result silently.
        if (ac.signal.aborted) return;
        clearTimeout(timeout);
        if (res.masterUrl) {
          setClientStream({
            url: res.masterUrl,
            quality: "auto",
            isM3U8: res.masterUrl.includes(".m3u8"),
            // The URL is the raw CDN m3u8 — no extra wrapping needed.
            directUrl: true,
          });
          setClientStatus("ok");
        } else {
          console.warn(
            "[UniversalPlayer] client vidmoly extraction failed:",
            res.error,
          );
          setClientStatus("failed");
        }
      } catch (e: any) {
        // Timeout abort → fall through to the iframe. Cleanup abort → ignore.
        if (timedOut) {
          console.warn("[UniversalPlayer] client vidmoly timed out → iframe");
          setClientStatus("failed");
        } else if (!ac.signal.aborted) {
          console.warn(
            "[UniversalPlayer] client vidmoly threw:",
            e?.message || e,
          );
          setClientStatus("failed");
        }
      }
    })();
    return () => {
      clearTimeout(timeout);
      ac.abort();
    };
  }, [streamData]);

  // ── Persistent volume (app-wide, shared across every player) ──
  // One value in localStorage, restored onto every player instance and every
  // episode/anime/session. Restore goes through Vidstack's `player.volume`
  // setter (which queues onto the canPlay queue and survives init); saving reads
  // the reactive `volumeState` (above). `volumePersistArmedRef` gates saving
  // until ~0.5s after restore settles, so the default (1) → restore churn can't
  // overwrite the saved value before we've applied it.
  // Persistence is GATED on real user interaction (this latch), never on the
  // mount lifecycle. The player re-mounts several times during server fallback;
  // an earlier "arm 0.5s after restore" gate kept getting reset to false and its
  // timer cleared by the next re-mount, so the latch never opened and nothing
  // ever saved (the [VOL] trace showed every change with `armed:false`). A
  // one-way latch set on the first pointer/keyboard interaction can't be undone
  // by re-mounts, and it naturally excludes the autoplay-mute + restore churn
  // (those happen with no user input). useRef so it survives every re-mount.
  const volArmedRef = useRef(false);

  // ── Restore saved volume/mute + arm persistence ──
  useEffect(() => {
    let el: HTMLElement | null = null;
    let player: any = null;
    let pollId = 0;

    const readNum = (k: string): number | null => {
      try {
        const raw = localStorage.getItem(k);
        const v = raw == null ? NaN : parseFloat(raw);
        return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
      } catch {
        return null;
      }
    };
    const savedVol = readNum("aniscroll:volume");
    let savedMuted: boolean | null = null;
    try {
      const m = localStorage.getItem("aniscroll:muted");
      savedMuted = m == null ? null : m === "1";
    } catch {}

    const apply = () => {
      if (!player) return;
      try {
        if (savedVol != null) player.volume = savedVol;
        // Only ever restore an intentional MUTE. Don't force unmute — autoplay
        // owns the muted-to-start behaviour and would fight us.
        if (savedMuted === true) player.muted = true;
      } catch {}
    };
    const arm = () => {
      volArmedRef.current = true;
    };

    const bind = () => {
      player = playerRef.current;
      el = (player?.el as HTMLElement) || null;
      if (!player || !el) return false;
      apply();
      el.addEventListener("can-play", apply);
      // Capture phase so we latch before the click's own handlers run.
      el.addEventListener("pointerdown", arm, true);
      el.addEventListener("keydown", arm, true);
      return true;
    };
    if (!bind()) {
      let tries = 0;
      pollId = window.setInterval(() => {
        if (bind() || ++tries > 40) window.clearInterval(pollId);
      }, 250);
    }

    return () => {
      window.clearInterval(pollId);
      el?.removeEventListener("can-play", apply);
      el?.removeEventListener("pointerdown", arm, true);
      el?.removeEventListener("keydown", arm, true);
    };
  }, [streamData]);

  // Persist the level + mute, but only after the user has actually touched the
  // player (so autoplay-mute and the restore don't overwrite the saved value).
  useEffect(() => {
    if (!volArmedRef.current) return;
    try {
      if (typeof volumeState === "number") {
        localStorage.setItem(
          "aniscroll:volume",
          String(Math.min(1, Math.max(0, volumeState))),
        );
      }
      localStorage.setItem("aniscroll:muted", mutedState ? "1" : "0");
    } catch {}
  }, [volumeState, mutedState]);

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
      // Only force autoplay at the very START. `can-play` / `loaded-data` fire
      // again every time hls.js re-buffers — including after a near-end stall or
      // an internal reset. Calling play() then would resume from wherever the
      // element sits, and play() on an *ended* element restarts it from 0, which
      // was a path into the "video jumps back to the start near the end" bug.
      // Past the first second the user is already watching; a re-buffer must not
      // trigger a fresh play() (and we never want to fight a user/end pause).
      if (video.ended || video.currentTime > 1) return;
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

  // Browser-extraction path: suppress the iframe fallback until extraction
  // settles, so the player doesn't briefly mount vidmoly's own embed before
  // the m3u8 URL is ready. `idle` covers the first render before our effect
  // has fired; `pending` while it's fetching; `ok` once we have the URL.
  // Only `failed` falls through to the iframe.
  const wantsClientExtract =
    streamData?.clientExtract?.type === "vidmoly" && clientStatus !== "failed";

  const bestStream = wantsClientExtract
    ? clientStatus === "ok"
      ? clientStream
      : null
    : streamData?.streams?.[0] || streamData?.sources?.[0] || null;
  const iframeSrc = wantsClientExtract ? null : streamData?.iframe || null;

  if (wantsClientExtract && clientStatus !== "ok") {
    return (
      <div className="flex-center aspect-video w-full h-full bg-black text-white/40 font-karla">
        {t("player.loading")}
      </div>
    );
  }

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
      <div
        className={`relative h-full w-full${iosPseudoFs ? " moopa-ios-fs" : ""}`}
      >
        {/* No ambient glow behind iframe embeds — the poster-based gradient was
            distracting and added nothing for an embed we can't sample frames
            from. (Removed per request.) */}
        <IframeEmbed
          src={iframeSrc}
          serverId={serverId}
          onError={onError}
          referrerPolicy={isVidmoly ? "no-referrer" : "origin"}
        />
        {/* No explicit exit-fullscreen cross: re-tapping the fullscreen
            button toggles pseudo-fullscreen off. */}
      </div>
    );
  }

  // If the extractor pre-wrapped the URL through an external proxy (vidmoly →
  // anime-proxy), use it as-is. Otherwise wrap through our local proxy.
  const src = bestStream!.directUrl
    ? bestStream!.url
    : proxied(
        bestStream!.url,
        bestStream!.referer || streamData?.referer,
        bestStream!.voeCookie,
      );
  const isM3U8 =
    bestStream!.isM3U8 === true ||
    (bestStream!.isM3U8 !== false && bestStream!.url.includes(".m3u8"));

  // CRITICAL: memoize the src object handed to <MediaPlayer>. Passing an inline
  // object literal `src={{ src, type }}` minted a NEW identity on EVERY render,
  // and Vidstack treats a new `src` object as a source change — it fires
  // `provider-change`, DESTROYS the hls.js instance and reloads from currentTime
  // 0. Our MutationObserver calls setState (host attach flags) whenever Vidstack
  // rebuilds its controls bar, which it does on a benign `durationchange` near
  // the end. That re-render + fresh src object = the "video resets to the start"
  // bug (confirmed by the JUMP-TO-0 trace: provider-change → load → hlsDestroying
  // → emptied → ct 0). A stable src identity stops the reload entirely.
  const srcKey = `${src}|${isM3U8 ? 1 : 0}`;
  if (!srcMemoRef.current || srcMemoRef.current.key !== srcKey) {
    srcMemoRef.current = {
      key: srcKey,
      value: {
        src,
        type: isM3U8 ? "application/vnd.apple.mpegurl" : "video/mp4",
      },
    };
  }
  const playerSrc = srcMemoRef.current.value;

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
  // Output extension:
  //   - MP4 streams download as .mp4 directly (single binary file)
  //   - HLS streams download as .m3u8 playlists (no server-side concat —
  //     keeps every byte of segment data off Vercel; user opens the file
  //     in VLC / mpv / yt-dlp / ffmpeg which then pulls segments directly
  //     from Cloudflare). See worker/src/index.js for the download mode.
  const ext = isM3U8 ? "m3u8" : "mp4";
  // Download endpoint: when NEXT_PUBLIC_PROXY_BASE is configured we route
  // downloads through the Cloudflare Worker (unmetered bandwidth, free).
  // Otherwise we fall back to the in-tree Vercel endpoints — these still
  // work but eat Fast Origin Transfer like before.
  const proxyConfigured = PROXY_BASE !== "/api/v2/proxy/m3u8";
  const downloadUrl = proxyConfigured
    ? `${PROXY_BASE}?url=${encodeURIComponent(innerUrl)}` +
      `&dl=1&filename=${encodeURIComponent(safeName + "." + ext)}` +
      (refererParam ? `&referer=${encodeURIComponent(refererParam)}` : "") +
      (bestStream!.voeCookie
        ? `&vcookie=${encodeURIComponent(bestStream!.voeCookie)}`
        : "")
    : isM3U8
      ? `/api/v2/download-stream?url=${encodeURIComponent(innerUrl)}` +
        `&filename=${encodeURIComponent(safeName + ".ts")}` +
        (refererParam ? `&referer=${encodeURIComponent(refererParam)}` : "")
      : `/api/v2/download?url=${encodeURIComponent(innerUrl)}` +
        `&filename=${encodeURIComponent(safeName + ".mp4")}` +
        (refererParam ? `&referer=${encodeURIComponent(refererParam)}` : "");

  // Identity-stable for the same reason as playerSrc: a fresh array each render
  // makes the <Track> children reconcile, and Vidstack tears down / re-adds text
  // tracks (the `set mode`/`add` + subtitle-blob ERR_FILE_NOT_FOUND seen in the
  // trace). Keyed by the subtitle source list so it only rebuilds when the
  // stream's subtitles actually change.
  const subsKey = JSON.stringify(
    (streamData?.subtitles || []).map((s) => [s.file || s.url, s.label, s.language, s.kind, s.default]),
  );
  if (!subsMemoRef.current || subsMemoRef.current.key !== subsKey) {
    subsMemoRef.current = {
      key: subsKey,
      value: (streamData?.subtitles || [])
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
        .filter(Boolean),
    };
  }
  const subtitleTracks = subsMemoRef.current.value as Array<{
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
    <div
      className={`relative h-full w-full${iosPseudoFs ? " moopa-ios-fs" : ""}`}
      style={{ isolation: "isolate" }}
    >
      {ambientEnabled && <LiveAmbient playerRef={playerRef} />}

      <MediaPlayer
        ref={playerRef}
        // Note: overflow-visible (not hidden) so portaled menus (subtitles
        // settings, etc.) can extend slightly past the bottom edge of the
        // player without being clipped. The bg-black still draws the player
        // box; only stray child elements can now overflow.
        className="vds-player relative z-10 h-full w-full overflow-visible bg-black"
        src={playerSrc}
        // Bigger buffers + fast-fail segment loading so seeking lands in
        // already-buffered data instead of a slow proxy→CDN round-trip.
        // Applied to the hls.js instance via provider-change (HLS only).
        onProviderChange={onProviderChange}
        onProviderSetup={onProviderSetup}
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
        // `volume` is likewise NOT passed as a controlled prop (it would reset
        // the user's level on every render). We restore the app-wide saved
        // volume and persist changes imperatively — see the effect below.
        // Skip crossorigin for streams hosted on CDNs that don't send CORS
        // headers (sibnet's cvn CDN, …). Setting crossorigin would force
        // CORS preflight on every Range request, which sibnet rejects with
        // no Access-Control-Allow-Origin — blocks playback entirely. The
        // trade-off: LiveAmbient canvas sampling tainted, falls back to
        // StaticGlow on these sources.
        {...(bestStream!.noCors ? {} : { crossorigin: "anonymous" })}
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

        <DefaultVideoLayout
          icons={defaultLayoutIcons}
          translations={i18n.language === "fr" ? (VIDSTACK_FR as any) : undefined}
        />
      </MediaPlayer>

      {/* Custom buttons portaled INTO Vidstack's bottom control group, BEFORE
          the Settings menu so the visual order is:
            [time] ...spacer... [Download] [Subs] [Cast] | [Settings] [PiP] [Fullscreen]
          The portal target is our STABLE host div (controlsHostRef), which the
          MutationObserver positions before the Settings menu inside the live
          controls group. Because the host's identity never changes across
          renders, React never tears the portal down when Vidstack rebuilds its
          bar — which is what used to throw `removeChild` and trigger a player
          remount (HLS reload to 0). On small (mobile) layout the host isn't
          attached to the bar; those actions surface in the Settings menu. */}
      {!isSmallLayout && controlsHostAttached && controlsHostRef.current && createPortal(
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
        controlsHostRef.current,
      )}

      {/* Custom toggles injected at the top of Vidstack's Settings menu, via the
          STABLE settingsHostRef the observer parks at the top of the open menu
          list. Same rationale as above: stable container → no portal teardown. */}
      {settingsHostAttached && settingsHostRef.current && createPortal(
        <>
          {isSmallLayout && (
            <>
              <SettingsActionRow
                label={
                  ext === "m3u8"
                    ? t("player.downloadM3u8")
                    : `${t("player.download")} ${ext.toUpperCase()}`
                }
                href={downloadUrl}
                downloadFilename={`${safeName}.${ext}`}
                iconPath="M12 16l-5-5h3V4h4v7h3l-5 5zm-7 2h14v2H5v-2z"
              />
              {subtitleTracks.length > 0 && (
                <SettingsActionRow
                  label={t("player.subtitles")}
                  onClick={() => setSubMenuOpen(true)}
                  iconPath="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-9 11H6v-2h5v2zm7 0h-5v-2h5v2zm0-4H6V9h12v2z"
                />
              )}
              {castAvailable && (
                <SettingsActionRow
                  label={castConnected ? t("player.casting") : t("player.cast")}
                  onClick={requestCast}
                  iconPath="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm18-7H5v1.63c3.96 1.28 7.09 4.41 8.37 8.37H19V7zM1 10v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zm20-7H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"
                />
              )}
            </>
          )}
          <SettingsToggleRow
            label={t("player.autoplay")}
            enabled={ctxAutoplay}
            onToggle={setAutoPlayCtx}
            // Material "play_arrow" icon — same family as the rest of the menu.
            iconPath="M8 5v14l11-7z"
          />
          <SettingsToggleRow
            label={t("player.ambientLights")}
            enabled={ctxAmbient}
            onToggle={setAmbientCtx}
            // Material "lightbulb_outline" icon.
            iconPath="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7zm2.85 11.1-.85.6V16h-4v-2.3l-.85-.6C7.8 12.16 7 10.63 7 9c0-2.76 2.24-5 5-5s5 2.24 5 5c0 1.63-.8 3.16-2.15 4.1z"
          />
        </>,
        settingsHostRef.current,
      )}

      {/* No exit cross: the fullscreen button itself toggles pseudo-fullscreen
          off. To make that reliable we keep the control bar from auto-hiding
          while in pseudo-fullscreen (see the controls.pause() effect), so the
          fullscreen button is always visible and a single tap exits. */}

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
        externalMenuOpen={subMenuOpen || subStyleOpen}
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
    // Cellular networks and low-end phones routinely take more than 10 s to
    // finish the first iframe handshake (extractor host + ad blockers +
    // worker scripts). 30 s gives a real stream a chance to land before we
    // mark the server failed — the previous 20 s cap was the #1 source of
    // "this server doesn't work on my phone" reports.
    const timeout = setTimeout(() => {
      setFailed(true);
      onError?.("Iframe didn't load within 30s");
    }, 30000);
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
      // `accelerometer` + `gyroscope` keep some extractors (Vidmoly) from
      // throwing permission errors on phones. `clipboard-write` is what the
      // hianime player needs for its "copy stream link" button. The extra
      // grants are harmless when the host doesn't use them.
      allow="autoplay; fullscreen; encrypted-media; picture-in-picture; accelerometer; gyroscope; clipboard-write"
      // Eager loading + high fetch priority: the iframe IS the page's main
      // content, so it should win the network race against background
      // requests (probes, analytics, ads in the loaded extractor).
      // `fetchpriority` isn't in the React iframe types yet (Next 14 / React
      // 18) but the attribute is honoured at runtime by Chromium/WebKit.
      loading="eager"
      {...({ fetchpriority: "high" } as any)}
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
const SEGMENT_NAME_KEY: Record<string, string> = {
  op: "player.chapterIntro",
  ed: "player.chapterOutro",
  recap: "player.chapterRecap",
};
// Any slack ≤ this many seconds on either end of the episode gets
// absorbed into the adjacent skip segment, so the seek bar never
// shows a sliver-thin "Episode" pill that's too small to be useful.
// Anything longer (preview / next-ep promo) gets its own dedicated
// Episode pill so the outro pill aligns with the actual on-screen
// outro and doesn't visually start ahead of the credits song.
const EDGE_SNAP_START_SECONDS = 5;
const EDGE_SNAP_END_SECONDS = 5;

function buildChaptersVtt(
  segments: Array<{ start: number; end: number; type: string }>,
  duration: number,
  t: TFunction,
): string | null {
  if (!segments.length || duration <= 0) return null;
  // Sort + clamp so we can synthesise the "Episode" cues between
  // them. We also drop overlaps (defensive: AniSkip can occasionally
  // ship overlapping op/recap on the same episode).
  const sorted = [...segments]
    .filter((s) => s.end > s.start && s.start < duration)
    .map((s) => ({ ...s, end: Math.min(s.end, duration) }))
    .sort((a, b) => a.start - b.start);
  // Snap segments to the episode edges when they sit within
  // EDGE_SNAP_SECONDS, so the seek bar doesn't render a useless
  // sliver pill at the start/end. First segment that starts close
  // to 0 gets pulled back to 0; last segment that ends close to
  // `duration` gets pushed out to `duration`.
  if (sorted.length) {
    const first = sorted[0];
    if (first.start > 0 && first.start <= EDGE_SNAP_START_SECONDS) {
      first.start = 0;
    }
    const last = sorted[sorted.length - 1];
    if (last.end < duration && duration - last.end <= EDGE_SNAP_END_SECONDS) {
      last.end = duration;
    }
  }
  const cues: Array<{ start: number; end: number; name: string }> = [];
  let cursor = 0;
  for (const s of sorted) {
    if (s.start > cursor + 0.5) {
      cues.push({ start: cursor, end: s.start, name: t("player.chapterEpisode") });
    }
    cues.push({
      start: Math.max(s.start, cursor),
      end: s.end,
      name: SEGMENT_NAME_KEY[s.type] ? t(SEGMENT_NAME_KEY[s.type]) : s.type,
    });
    cursor = s.end;
  }
  if (cursor < duration - 0.5) {
    cues.push({ start: cursor, end: duration, name: t("player.chapterEpisode") });
  }
  if (cues.length < 2) return null;
  const fmt = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = (sec % 60).toFixed(3);
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
  videoDuration: number,
): string | null {
  const { t } = useTranslation();
  // Anything past `videoDuration` is treated as if it doesn't exist:
  // segments are clamped, and the trailing Episode cue stops at
  // `videoDuration`. The trailing cue only renders if there's a real
  // post-outro gap (> 1 s of grace) — if the outro already runs to
  // the end, the outro pill itself extends to the bar's right edge.
  // Only build the VTT once we have the REAL duration. Previously we shipped
  // a fallback VTT (duration = lastSkipEnd + 60) on first render, then rebuilt
  // it when the true duration arrived. Each rebuild created a new blob URL,
  // which changed the <Track> `key` and forced Vidstack to remount + reparse
  // the chapters track — during that window `activeChapter` was empty, so the
  // "• Intro/Episode" label next to the time was missing at the start of
  // playback. Waiting for the true duration means a single blob, a single
  // mount, and the label is present from the first frame the bar shows pills.
  //
  // CRITICAL: quantize the duration to whole seconds before building the VTT.
  // hls.js refines `duration` by a few hundredths near the end (e.g. 1435.02 →
  // 1435.11), which fires `durationchange`. If the VTT text tracked that, every
  // refinement minted a NEW blob URL → new <Track> key → Vidstack remounts the
  // chapters track → its teardown threw `removeChild` → PlayerErrorBoundary →
  // player remount → HLS reload from 0. THIS was the real "video resets to the
  // start near the end" cause (the JUMP-TO-0 trace shows provider-change/load
  // fired from a ref re-mount right after a durationchange). Rounding means a
  // sub-second drift yields the SAME VTT → same blob → no track remount, no
  // reset.
  const quantizedDuration = videoDuration > 0 ? Math.round(videoDuration) : 0;
  const vtt =
    quantizedDuration > 0 ? buildChaptersVtt(segments, quantizedDuration, t) : null;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vtt]);
  return url;
}

/**
 * Returns the title of the chapter cue covering the current playback time.
 *
 * We compute this ourselves instead of using Vidstack's <ChapterTitle>: that
 * component reads a reactive `activeCue` signal which only emits on a value
 * CHANGE, so the FIRST cue (active from load) never gets emitted and its
 * title is missing until playback transitions into the second cue. Reading
 * the cue list directly against currentTime sidesteps that entirely — the
 * correct title shows from the first frame and for every pill.
 */
function useActiveChapterTitle(
  playerRef: React.RefObject<MediaPlayerInstance>,
  chaptersTrackUrl: string | null,
): string {
  const [title, setTitle] = useState("");

  useEffect(() => {
    if (!chaptersTrackUrl) {
      setTitle("");
      return;
    }
    const player = playerRef.current;
    if (!player) return;

    // The underlying <video> element — same access pattern the rest of this
    // file uses (playerRef.current.el). We listen to its native timeupdate.
    const videoEl =
      ((player as any).el as HTMLElement | undefined)?.querySelector?.(
        "video",
      ) || null;
    if (!videoEl) {
      // Provider not mounted yet — bail; the effect re-runs when the track
      // url changes, and the track only exists once the provider is up.
      setTitle("");
    }

    let cues: Array<{ startTime: number; endTime: number; text: string }> = [];
    let raf = 0;
    let disposed = false;

    const findCues = () => {
      const tracks: any = (player as any).textTracks;
      if (!tracks) return null;
      const list =
        typeof tracks.toArray === "function"
          ? tracks.toArray()
          : Array.from(tracks as Iterable<any>);
      const chapters = list.find((t: any) => t.kind === "chapters");
      if (chapters?.cues && chapters.cues.length > 0) {
        return Array.from(chapters.cues) as any[];
      }
      return null;
    };

    const update = () => {
      if (disposed || cues.length === 0) return;
      const t = player.currentTime;
      const cue = cues.find((c) => t >= c.startTime && t < c.endTime);
      setTitle(cue?.text || "");
    };

    // Poll until the track's cues are parsed, then compute once.
    const waitForCues = () => {
      if (disposed) return;
      const found = findCues();
      if (!found) {
        raf = requestAnimationFrame(waitForCues);
        return;
      }
      cues = found;
      update();
    };
    waitForCues();

    // Recompute the title on every timeupdate (continuous during playback)
    // and on seeked (so a manual seek while paused updates it immediately).
    const onTime = () => update();
    videoEl?.addEventListener("timeupdate", onTime);
    videoEl?.addEventListener("seeked", onTime);
    videoEl?.addEventListener("loadedmetadata", onTime);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      videoEl?.removeEventListener("timeupdate", onTime);
      videoEl?.removeEventListener("seeked", onTime);
      videoEl?.removeEventListener("loadedmetadata", onTime);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chaptersTrackUrl]);

  return title;
}


