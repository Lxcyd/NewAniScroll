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

  // There is exactly ONE hidden <video>, so every capture has to be
  // serialised. These refs are what let a hover jump the queue: without them
  // a hover at 15:00 waited for the background walk to crawl there one
  // 10-second step at a time (~144 sequential seeks for an episode), which is
  // why the preview sat on a stale frame while the cursor moved.
  //   hoverBucket    — bucket the cursor is over right now (null = not hovering)
  //   priorityBucket — bucket a hover is waiting for; overwritten, never queued,
  //                    so sweeping the bar asks for the LAST spot, not all of them
  //   seekBusy       — a seek is in flight; whoever holds it serves the priority
  const hoverBucketRef = useRef<number | null>(null);
  const priorityBucketRef = useRef<number | null>(null);
  const seekBusyRef = useRef(false);
  const redrawRef = useRef<(() => void) | null>(null);

  const bucketOf = (t: number) =>
    Math.round(t / THUMB_INTERVAL_S) * THUMB_INTERVAL_S;

  /** Seek the hidden video to `bucket` and cache the decoded frame. */
  const captureBucket = async (
    video: HTMLVideoElement,
    bucket: number,
    timeoutMs: number,
  ): Promise<boolean> => {
    if (thumbCacheRef.current.has(bucket)) return true;
    // The last bucket can round PAST the end; the browser clamps the seek, so
    // without this the position check below would reject the frame forever and
    // we'd re-request it on every single pointermove.
    const target = isFinite(video.duration)
      ? Math.min(bucket, Math.max(0, video.duration - 0.1))
      : bucket;
    await seekAndWait(video, target, timeoutMs);
    // A hover and the walk share this element. If something re-seeked us
    // mid-flight the decoded frame belongs to a DIFFERENT timestamp, and
    // storing it here would poison the cache with a silently wrong thumbnail.
    if (video.videoWidth === 0 || Math.abs(video.currentTime - target) > 1) {
      return false;
    }
    const c = document.createElement("canvas");
    c.width = THUMB_W;
    c.height = THUMB_H;
    const cx = c.getContext("2d");
    if (!cx) return false;
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = "high";
    cx.drawImage(video, 0, 0, c.width, c.height);
    thumbCacheRef.current.set(bucket, c);
    // Paint it the moment it lands, if the cursor is still on that spot.
    if (hoverBucketRef.current === bucket) redrawRef.current?.();
    return true;
  };

  /** Serve pending hover requests. No-op while a seek is already running —
   *  its owner drains the queue when it finishes. */
  const pumpPriority = async (video: HTMLVideoElement, timeoutMs: number) => {
    if (seekBusyRef.current) return;
    seekBusyRef.current = true;
    try {
      while (priorityBucketRef.current != null) {
        const b = priorityBucketRef.current;
        priorityBucketRef.current = null;
        try {
          await captureBucket(video, b, timeoutMs);
        } catch {
          /* seek failed — drop it, the next hover will ask again */
        }
      }
    } finally {
      seekBusyRef.current = false;
    }
  };

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
        // Whatever the cursor is pointing at wins over the next step of a walk
        // nobody is looking at. Worst-case wait for a hover is the tail of the
        // seek already in flight, not the whole remaining walk.
        await pumpPriority(video, 3000);
        if (!cachingActiveRef.current) return;
        const bucket = bucketOf(t);
        if (thumbCacheRef.current.has(bucket)) continue;

        seekBusyRef.current = true;
        try {
          await captureBucket(video, bucket, 3000);
        } catch {
          // Skip failed seeks
        } finally {
          seekBusyRef.current = false;
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

    /** Render the pre-cached thumbnail (instant) for the given time. */
    const drawCachedAt = (timeSec: number): boolean => {
      const cache = thumbCacheRef.current;
      if (cache.size === 0) return false;
      const want = bucketOf(timeSec);
      // Only this NEIGHBOURHOOD may stand in. The old code took the globally
      // nearest cached bucket, so while the walk was still near the start,
      // hovering at 15:00 drew the 3:00 frame — and drew that same frame for
      // every position past the walk's front. Moving along the bar changed
      // nothing on screen; that was the stuck preview. One bucket either side
      // is allowed so the tooltip shows a near-miss instead of flashing a
      // placeholder while the exact frame is being captured.
      let best = -1;
      for (const k of [want, want - THUMB_INTERVAL_S, want + THUMB_INTERVAL_S]) {
        if (cache.has(k)) {
          best = k;
          break;
        }
      }
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

    // Let a capture finished elsewhere (background walk or priority seek)
    // repaint the tooltip without waiting for the next pointermove.
    redrawRef.current = () => {
      const b = hoverBucketRef.current;
      if (b != null) drawFrame(b);
    };

    // A seek on a throttled (250k) proxied MP4 must fetch the bytes at the
    // target offset before it can decode, so lazy sources get a longer rope.
    const captureTimeoutMs = lazy ? 8000 : 3000;

    const handleMove = (e: PointerEvent) => {
      if (!duration || duration === 0) return;
      const rect = (slider as HTMLElement).getBoundingClientRect();
      const x = e.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, x / rect.width));
      const time = ratio * duration;

      // Ask for the exact frame under the cursor whenever we don't have it,
      // eager mode included. Previously only `lazy` sources captured on
      // demand; everything else just waited for the sequential walk to arrive,
      // which is what made the preview lag behind the cursor. Requests
      // overwrite each other, so sweeping the bar costs ONE seek, at the spot
      // the cursor actually stopped on.
      const bucket = bucketOf(time);
      hoverBucketRef.current = bucket;
      const video = videoRef.current;
      if (video && !thumbCacheRef.current.has(bucket)) {
        priorityBucketRef.current = bucket;
        void pumpPriority(video, captureTimeoutMs);
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
      // Nothing is on screen any more: stop asking for frames and let the
      // background walk have the video back.
      hoverBucketRef.current = null;
      priorityBucketRef.current = null;
    };

    slider.addEventListener("pointermove", handleMove as EventListener);
    slider.addEventListener("pointerleave", handleLeave as EventListener);

      return () => {
        slider.removeEventListener("pointermove", handleMove as EventListener);
        slider.removeEventListener("pointerleave", handleLeave as EventListener);
        redrawRef.current = null;
        hoverBucketRef.current = null;
        priorityBucketRef.current = null;
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
