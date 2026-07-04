import { useEffect, useRef, useState } from "react";
// @ts-ignore — react-dom types not installed but createPortal is exported
import { createPortal } from "react-dom";
import { useMediaState, type MediaPlayerInstance } from "@vidstack/react";
import Hls from "hls.js";

/**
 * Hover preview tooltip — when the user hovers the Vidstack scrubber, a hidden
 * second <video> element is seeked to that timestamp and its frame is drawn
 * to a canvas tooltip positioned above the scrubber.
 *
 * Works for direct streams (HLS/MP4) only — iframes are cross-origin and we
 * can't access their video element.
 */
export default function HoverPreview({
  playerRef,
  src,
  isM3U8,
  lazy = false,
}: {
  playerRef: React.RefObject<MediaPlayerInstance>;
  src: string;
  isM3U8: boolean;
  /** When true, DON'T eagerly walk the whole episode capturing thumbnails
   *  (that stalls + wastes bandwidth on throttled CDNs like sendvid's 250k).
   *  Instead capture the frame at the hovered position on demand. */
  lazy?: boolean;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const seekRafRef = useRef<number>(0);
  // Pre-cached thumbnails keyed by their timestamp BUCKET (integer seconds,
  // snapped to THUMB_INTERVAL_S). Storing by time — not by percent — lets us
  // pack a thumbnail every few seconds regardless of episode length, instead
  // of a fixed 21 frames spread thin across a 24-minute episode.
  const thumbCacheRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const cachingActiveRef = useRef(false);

  // YouTube-style density at a CRISP resolution. We capture at 320×180 (16:9)
  // which is sharp at the ~192px-wide preview the tooltip shows, while still
  // being cheap enough to cache one every 10s (~144 frames for a 24-min ep).
  const THUMB_INTERVAL_S = 10;
  const THUMB_W = 320;
  const THUMB_H = 180;

  // Subscribe to slider state so we know when the user is hovering
  const duration = useMediaState("duration", playerRef);

  // Set up the hidden video element with the same source.
  // crossOrigin must be set BEFORE src so the browser uses CORS mode and
  // the resulting canvas isn't security-tainted (drawImage would throw).
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    video.crossOrigin = "anonymous";

    // Reset thumbnail cache on src change
    thumbCacheRef.current.clear();
    cachingActiveRef.current = false;

    if (isM3U8 && Hls.isSupported()) {
      const hls = new Hls({
        // Small buffer — we only seek-and-grab single frames, never play.
        maxBufferLength: 6,
        maxMaxBufferLength: 12,
        backBufferLength: 0,
        // Pick a MID quality level (not the lowest) so the thumbnails are
        // crisp. startLevel:-1 lets hls.js auto-pick based on bandwidth; we
        // then cap it to a mid rung below so previews aren't full-HD-heavy.
        startLevel: -1,
        capLevelToPlayerSize: false,
        xhrSetup: (xhr) => {
          xhr.withCredentials = false;
        },
      });
      // Cap the preview decoder to a middle quality rung once levels are known:
      // sharp enough for a 192px tooltip, far lighter than the top rung, so the
      // background thumbnail walk doesn't compete hard with the main player.
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        const n = hls.levels?.length || 0;
        if (n > 1) {
          // middle rung (round down), but never the very lowest
          hls.currentLevel = Math.max(1, Math.floor((n - 1) / 2));
        }
      });
      hls.loadSource(src);
      hls.attachMedia(video);
      hlsRef.current = hls;
      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    } else {
      // For lazy (throttled) MP4 sources, let the element fetch media data on
      // seek — preload="metadata" alone often refuses to load past the header,
      // so a seek to mid-episode never decodes a frame (black thumbnail). Force
      // eager-ish loading and kick a load() so the first hover seek has data.
      if (lazy) video.preload = "auto";
      video.src = src;
      video.load();
    }
  }, [src, isM3U8, lazy]);

  // Background thumbnail pre-caching: once metadata is loaded, walk through
  // the video at fixed percentage intervals (every 5%) seeking the hidden
  // video, capturing each frame to a small canvas, and storing it. Hovers
  // then look up the closest cached thumbnail = INSTANT display.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    // Lazy mode: skip the eager full-episode walk entirely. Thumbnails are
    // captured on demand from the hover handler (see captureAt below).
    if (lazy) return;

    const start = async () => {
      if (cachingActiveRef.current) return;
      if (!isFinite(video.duration) || video.duration === 0) return;
      cachingActiveRef.current = true;

      const dur = video.duration;
      // Walk the episode every THUMB_INTERVAL_S seconds. Keyed by the integer
      // second bucket so hovers can snap to the nearest captured frame.
      for (let t = 0; t <= dur; t += THUMB_INTERVAL_S) {
        if (!cachingActiveRef.current) return; // src changed
        const bucket = Math.round(t);
        if (thumbCacheRef.current.has(bucket)) continue;

        try {
          await seekAndWait(video, t);
          const c = document.createElement("canvas");
          c.width = THUMB_W;
          c.height = THUMB_H;
          const cx = c.getContext("2d");
          if (cx && video.videoWidth > 0) {
            cx.imageSmoothingEnabled = true;
            cx.imageSmoothingQuality = "high";
            cx.drawImage(video, 0, 0, c.width, c.height);
            thumbCacheRef.current.set(bucket, c);
          }
        } catch {
          // Skip failed seeks
        }
      }
    };

    const onLoaded = () => start();
    video.addEventListener("loadedmetadata", onLoaded);
    if (video.readyState >= 1) start();
    return () => {
      video.removeEventListener("loadedmetadata", onLoaded);
      cachingActiveRef.current = false;
    };
  }, [src, lazy]);

  // Track scrubber hover. We poll for the slider since Vidstack mounts it
  // asynchronously inside the DefaultVideoLayout.
  useEffect(() => {
    let cleanup = () => {};
    let cancelled = false;

    const tryAttach = () => {
      if (cancelled) return;
      const playerEl = playerRef.current?.el as HTMLElement | undefined;
      if (!playerEl) {
        setTimeout(tryAttach, 200);
        return;
      }
      const slider = playerEl.querySelector(
        'media-time-slider, [data-media-time-slider], .vds-time-slider, .vds-slider'
      ) as HTMLElement | null;
      if (!slider) {
        setTimeout(tryAttach, 200);
        return;
      }
      cleanup = attach(playerEl, slider);
    };

    function attach(playerEl: HTMLElement, slider: HTMLElement): () => void {
      const wrap = wrapperRef.current;
      const canvas = canvasRef.current;
      const video = videoRef.current;
      const label = labelRef.current;
      if (!wrap || !canvas || !video || !label) return () => {};

      const ctx = canvas.getContext("2d");
      if (!ctx) return () => {};

    /** Render the pre-cached thumbnail (instant) closest to the given time. */
    const drawCachedAt = (timeSec: number): boolean => {
      const cache = thumbCacheRef.current;
      if (cache.size === 0) return false;
      // Snap to the nearest captured bucket; if it's missing (caching still
      // walking the episode), search outward for the closest one we do have.
      const want = Math.round(timeSec / THUMB_INTERVAL_S) * THUMB_INTERVAL_S;
      let best = -1;
      let bestDiff = Infinity;
      cache.forEach((_, k) => {
        const d = Math.abs(k - want);
        if (d < bestDiff) {
          bestDiff = d;
          best = k;
        }
      });
      if (best < 0) return false;
      const c = cache.get(best);
      if (!c) return false;
      try {
        ctx.drawImage(c, 0, 0, canvas.width, canvas.height);
        return true;
      } catch {
        return false;
      }
    };

    const drawPlaceholder = () => {
      ctx.fillStyle = "#1a1a24";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#666";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("…", canvas.width / 2, canvas.height / 2);
    };

    const drawFrame = (timeSec: number) => {
      // STATIC thumbnail only: show the closest pre-cached frame, or a
      // placeholder until the background walk reaches this point. We do NOT
      // draw the hidden video's live frame here — that was the bug: the hidden
      // video keeps moving (it's mid-seek for the background pre-cache), so the
      // preview kept "playing" instead of staying on the hovered frame.
      if (drawCachedAt(timeSec)) return;
      drawPlaceholder();
    };

    // LAZY capture: in lazy mode there's no background walk, so capture the
    // frame at the hovered bucket ON DEMAND. Debounced (only after the cursor
    // rests) and single-flight (one seek at a time) so a drag across the bar
    // doesn't queue dozens of seeks on the throttled CDN. Once captured, the
    // thumbnail is cached like any other and drawn.
    let lazyTimer = 0;
    let lazyBusy = false;
    const captureAt = (timeSec: number) => {
      const video = videoRef.current;
      if (!video) return;
      const bucket = Math.round(timeSec / THUMB_INTERVAL_S) * THUMB_INTERVAL_S;
      if (thumbCacheRef.current.has(bucket) || lazyBusy) return;
      lazyBusy = true;
      // Longer timeout: a seek on the throttled (250k) proxied MP4 must fetch
      // the bytes at the target offset before it can decode a frame.
      seekAndWait(video, bucket, 8000)
        .then(() => {
          if (video.videoWidth > 0) {
            const c = document.createElement("canvas");
            c.width = THUMB_W;
            c.height = THUMB_H;
            const cx = c.getContext("2d");
            if (cx) {
              cx.imageSmoothingEnabled = true;
              cx.imageSmoothingQuality = "high";
              cx.drawImage(video, 0, 0, c.width, c.height);
              thumbCacheRef.current.set(bucket, c);
              // Redraw immediately if the cursor is still near this bucket.
              drawCachedAt(bucket);
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          lazyBusy = false;
        });
    };

    const handleMove = (e: PointerEvent) => {
      if (!duration || duration === 0) return;
      const rect = (slider as HTMLElement).getBoundingClientRect();
      const x = e.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, x / rect.width));
      const time = ratio * duration;

      // In lazy mode, kick a debounced on-demand capture for this spot.
      if (lazy) {
        window.clearTimeout(lazyTimer);
        lazyTimer = window.setTimeout(() => captureAt(time), 140);
      }

      // Position tooltip above the slider, follow the cursor
      const playerRect = playerEl.getBoundingClientRect();
      const tipWidth = wrap.offsetWidth || 192;
      const left = Math.min(
        Math.max(8, e.clientX - playerRect.left - tipWidth / 2),
        playerRect.width - tipWidth - 8
      );
      const sliderTop = rect.top - playerRect.top;
      wrap.style.left = `${left}px`;
      wrap.style.top = `${sliderTop - 128}px`;
      wrap.style.opacity = "1";

      // Update label (hidden) and draw the closest cached (static) thumbnail.
      label.textContent = formatTime(time);
      drawFrame(time);
    };

    const handleLeave = () => {
      wrap.style.opacity = "0";
    };

    slider.addEventListener("pointermove", handleMove as EventListener);
    slider.addEventListener("pointerleave", handleLeave as EventListener);

      return () => {
        slider.removeEventListener("pointermove", handleMove as EventListener);
        slider.removeEventListener("pointerleave", handleLeave as EventListener);
        window.clearTimeout(lazyTimer);
        cancelAnimationFrame(seekRafRef.current);
      };
    }

    tryAttach();
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [duration, playerRef, lazy]);

  // Cache the player root so we can portal the tooltip inside it — keeps
  // the preview visible when the player goes fullscreen (where any element
  // outside the fullscreen target is hidden by the browser).
  const [playerEl, setPlayerEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const find = () => {
      const el = playerRef.current?.el as HTMLElement | undefined;
      if (el) setPlayerEl(el);
      else setTimeout(find, 100);
    };
    find();
  }, [playerRef]);

  const tooltip = (
    <div
      ref={wrapperRef}
      className="pointer-events-none absolute z-30 transition-opacity duration-150"
      style={{
        opacity: 0,
        left: 0,
        top: 0,
      }}
    >
      <canvas
        ref={canvasRef}
        width={320}
        height={180}
        className="rounded-md bg-black ring-1 ring-white/20 shadow-xl"
        style={{ width: "192px", height: "108px" }}
      />
      {/* Hidden label — kept in DOM so existing code can update it without crashing */}
      <span ref={labelRef} className="sr-only">0:00</span>
    </div>
  );

  return (
    <>
      {/* Hidden source video — never shown, only sampled */}
      <video
        ref={videoRef}
        muted
        playsInline
        crossOrigin="anonymous"
        preload="metadata"
        style={{
          position: "absolute",
          width: "1px",
          height: "1px",
          opacity: 0,
          pointerEvents: "none",
          top: "-9999px",
          left: "-9999px",
        }}
      />

      {/* Portal the tooltip into the player root so it stays visible when the
          player enters native fullscreen (the browser hides everything outside
          the fullscreen element). Falls back to inline render until playerEl
          resolves — same visual outcome, just not fullscreen-safe yet. */}
      {playerEl ? createPortal(tooltip, playerEl) : tooltip}
    </>
  );
}

function formatTime(t: number): string {
  if (!isFinite(t) || t < 0) return "0:00";
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Seek the hidden video and resolve when a real frame is DECODED at that spot.
 * `timeoutMs` is longer for throttled sources (a seek on a 250k CDN must fetch
 * the bytes at the target offset before it can decode). We also wait for the
 * frame to actually be painted before resolving: `seeked` fires when the seek
 * completes but the frame may not be decoded yet, so drawImage right after can
 * grab a black frame. requestVideoFrameCallback (when available) resolves only
 * once a frame is presented; otherwise we fall back to a short rAF delay.
 */
function seekAndWait(
  video: HTMLVideoElement,
  time: number,
  timeoutMs = 3000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const done = (fn: () => void) => {
      if (resolved) return;
      resolved = true;
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      fn();
    };
    const onSeeked = () => {
      // Wait for a decoded frame before resolving.
      const anyVid = video as any;
      if (typeof anyVid.requestVideoFrameCallback === "function") {
        anyVid.requestVideoFrameCallback(() => done(resolve));
        // Guard: rVFC never fires if the video is paused on some browsers —
        // resolve on the next macrotask as a floor.
        setTimeout(() => done(resolve), 120);
      } else {
        requestAnimationFrame(() => requestAnimationFrame(() => done(resolve)));
      }
    };
    const onError = () => done(() => reject(new Error("seek error")));
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    try {
      video.currentTime = time;
    } catch (e) {
      done(() => reject(e));
    }
    setTimeout(() => done(() => reject(new Error("seek timeout"))), timeoutMs);
  });
}
