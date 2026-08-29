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
  direct = false,
}: {
  playerRef: React.RefObject<MediaPlayerInstance>;
  src: string;
  isM3U8: boolean;
  /** When true, DON'T eagerly walk the whole episode capturing thumbnails
   *  (that stalls + wastes bandwidth on throttled CDNs like sendvid's 250k).
   *  Instead capture the frame at the hovered position on demand. */
  lazy?: boolean;
  /** Playback goes straight to a fragile third-party CDN (vidmoly & co) with
   *  no proxy in front. Those cut the connection when hit concurrently — the
   *  same reason the hover pre-warm in UniversalPlayer skips them — so they
   *  stay on a single decoder no matter what. */
  direct?: boolean;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const videosRef = useRef<(HTMLVideoElement | null)[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const hlsListRef = useRef<Hls[]>([]);
  const seekRafRef = useRef<number>(0);

  // How many hidden decoders walk the episode at once. A capture is almost
  // entirely WAITING — request latency for the segment, then decode — so one
  // element left the pipeline idle between every seek and needed ~1 min to
  // cover an episode. Several elements overlap those waits, without changing
  // the number of segments fetched.
  //
  // Three, not six. Six decoders plus the player's own loader is a burst the
  // upstream CDN answers with 429 — measured on Mobile Suit Gundam: 253 segment
  // requests in ten seconds, 42 of them refused, each refusal then retried by
  // hls.js (tools/browser-check/proxy-429.mjs). The walk is background work; it
  // must never be the reason playback gets rate-limited. Three still overlaps
  // the seek latencies, which is where nearly all of the gain was.
  const PARALLEL_DECODERS = 3;
  const workerCount = lazy || direct ? 1 : PARALLEL_DECODERS;
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

  // Refus de segment tolerés avant d'abandonner la marche de fond. Trois, parce
  // qu'un seul peut etre un hoquet isole alors que trois disent que la source
  // nous repousse — et la lecture passe avant les vignettes.
  const REFUS_MAX = 3;

  // A hover must never queue behind the background walk: whichever decoder
  // finishes its current capture first picks the hovered bucket up next.
  //   hoverBucket    — bucket the cursor is over right now (null = not hovering)
  //   priorityBucket — bucket a hover is waiting for; overwritten, never queued,
  //                    so sweeping the bar asks for the LAST spot, not all of them
  //   workersActive  — decoders still walking; when 0, a hover pumps one itself
  const hoverBucketRef = useRef<number | null>(null);
  const priorityBucketRef = useRef<number | null>(null);
  const workersActiveRef = useRef(0);
  const pumpBusyRef = useRef(false);
  const runIdRef = useRef(0);
  /** Refus de segment (429 / erreur reseau) subis par les decodeurs d'apercu.
   *  Passe le seuil, la marche de fond s'arrete : voir REFUS_MAX. */
  const refusRef = useRef(0);
  // How far apart the captured frames currently are, in seconds. Starts at the
  // coarsest pass and tightens to THUMB_INTERVAL_S as the walk refines. The
  // tooltip is allowed to stand in a neighbour up to this distance — that is
  // what makes the whole bar show SOMETHING within the first second instead of
  // an empty box everywhere the walk hasn't reached.
  const coverageStepRef = useRef(THUMB_INTERVAL_S);
  // Has the tooltip canvas ever held a real frame? Drives "keep the last image
  // instead of blanking" — see drawFrame.
  const paintedRef = useRef(false);
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

  /** Serve pending hover requests when NO walker is running (walk finished, or
   *  lazy mode where there is no walk at all). While walkers are alive they
   *  drain the priority slot themselves, one seek of latency at worst. */
  const pumpPriority = async (timeoutMs: number) => {
    if (pumpBusyRef.current || workersActiveRef.current > 0) return;
    const video = videosRef.current[0];
    if (!video) return;
    pumpBusyRef.current = true;
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
      pumpBusyRef.current = false;
    }
  };

  // Subscribe to slider state so we know when the user is hovering
  const duration = useMediaState("duration", playerRef);

  // Set up the hidden video element with the same source.
  // crossOrigin must be set BEFORE src so the browser uses CORS mode and
  // the resulting canvas isn't security-tainted (drawImage would throw).
  useEffect(() => {
    const videos = videosRef.current.slice(0, workerCount).filter(Boolean) as
      HTMLVideoElement[];
    if (!videos.length || !src) return;

    // Reset thumbnail cache on src change
    thumbCacheRef.current.clear();
    cachingActiveRef.current = false;
    refusRef.current = 0;
    // Don't let the previous episode's density claim apply to an empty cache,
    // and don't keep showing the previous episode's frame either.
    coverageStepRef.current = THUMB_INTERVAL_S;
    paintedRef.current = false;

    const instances: Hls[] = [];
    for (const video of videos) {
      video.crossOrigin = "anonymous";

      if (isM3U8 && Hls.isSupported()) {
        const hls = new Hls({
          // Small buffer — we only seek-and-grab single frames, never play.
          maxBufferLength: 6,
          maxMaxBufferLength: 12,
          backBufferLength: 0,
          // Start on the CHEAPEST rung (index 0 = lowest bitrate) instead of
          // letting ABR probe. With -1, hls.js measured bandwidth and often
          // pulled the first fragment in high quality — pure latency on the
          // one fragment that decides how fast the first thumbnail appears.
          startLevel: 0,
          // Skip the startup bandwidth test for the same reason: we never
          // stream, we grab single frames, so ABR has nothing to earn here.
          testBandwidth: false,
          capLevelToPlayerSize: false,
          // Une vignette ratee est une vignette de moins, pas une coupure : elle
          // ne vaut pas cinq tentatives. Par defaut hls.js reessaie quatre fois
          // chaque segment refuse, ce qui transformait 8 refus en 42 requetes
          // (mesure sur Mobile Suit Gundam). On laisse UNE reprise, pour le
          // hoquet isole, et rien de plus — le lecteur, lui, garde sa patience.
          fragLoadingMaxRetry: 1,
          fragLoadingRetryDelay: 1500,
          fragLoadingMaxRetryTimeout: 4000,
          xhrSetup: (xhr) => {
            xhr.withCredentials = false;
          },
        });
        /* Quand la source refuse, on ARRETE de marcher. Le CDN qui repond 429
           le fait parce qu'on lui demande trop a la fois, et insister prend la
           bande passante de la lecture elle-meme. En s'arretant, les vignettes
           deja capturees restent affichables et le survol continue d'en
           produire a la demande (pumpPriority, exactement le mode `lazy`) :
           on perd la densite, jamais la fonction. */
        hls.on(Hls.Events.ERROR, (_e, data: any) => {
          const reseau =
            data?.type === Hls.ErrorTypes.NETWORK_ERROR ||
            data?.response?.code === 429;
          if (!reseau) return;
          refusRef.current++;
          if (refusRef.current >= REFUS_MAX) cachingActiveRef.current = false;
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          // Take the SMALLEST rung at or above 240p. The tooltip renders at
          // 192×108, so anything beyond that is download and decode time spent
          // on detail nobody can see — and that time is the whole reason the
          // walk used to take a minute. (This used to pick the MIDDLE rung,
          // i.e. often 720p.)
          const levels = hls.levels || [];
          if (levels.length <= 1) return;
          let pick = -1;
          let pickH = Infinity;
          levels.forEach((l, i) => {
            const h = l.height || 0;
            if (h >= 240 && h < pickH) {
              pickH = h;
              pick = i;
            }
          });
          if (pick < 0) {
            // No usable height metadata — fall back to the cheapest rung.
            pick = levels.reduce(
              (best, l, i) => (l.bitrate < levels[best].bitrate ? i : best),
              0,
            );
          }
          hls.currentLevel = pick;
        });
        hls.loadSource(src);
        hls.attachMedia(video);
        instances.push(hls);
      } else {
        // For lazy (throttled) MP4 sources, let the element fetch media data on
        // seek — preload="metadata" alone often refuses to load past the header,
        // so a seek to mid-episode never decodes a frame (black thumbnail). Force
        // eager-ish loading and kick a load() so the first hover seek has data.
        if (lazy) video.preload = "auto";
        video.src = src;
        video.load();
      }
    }
    hlsListRef.current = instances;

    return () => {
      for (const h of instances) h.destroy();
      hlsListRef.current = [];
    };
  }, [src, isM3U8, lazy, workerCount]);

  // Background thumbnail pre-caching: walk the episode every THUMB_INTERVAL_S
  // seconds, seeking a hidden video and capturing each frame to a canvas.
  // Hovers then look up the cached thumbnail = INSTANT display.
  //
  // The walk is shared by `workerCount` decoders pulling from ONE cursor, so
  // they never duplicate a bucket and a slow segment stalls only its own
  // decoder instead of the whole episode.
  useEffect(() => {
    const videos = videosRef.current.slice(0, workerCount).filter(Boolean) as
      HTMLVideoElement[];
    if (!videos.length) return;
    // Lazy mode: skip the eager full-episode walk entirely. Thumbnails are
    // captured on demand from the hover handler (see pumpPriority).
    if (lazy) return;

    // A plain "is the walk active" flag is not enough: on a src change the
    // effect re-runs and sets it back to true, and the PREVIOUS run's workers
    // — which are parked inside an await, on the very same <video> elements —
    // would wake up and resume, doubling the decoders. Each run gets a token
    // instead, and a worker exits as soon as it is no longer the current one.
    const myRun = ++runIdRef.current;

    // COARSE TO FINE. Walking 0,10,20,… left to right means the right half of
    // the bar has nothing to show until the walk gets there — which is what
    // "l'image est vide" actually was, even after the walk got faster. Instead
    // we sweep the WHOLE episode at 160s first (~9 frames, about a second),
    // then halve the stride pass after pass. Coverage everywhere immediately,
    // detail shortly after; and a hover always jumps the queue for its exact
    // frame anyway.
    const STRIDE_PASSES = [16, 8, 4, 2, 1]; // in buckets, i.e. 160s → 10s
    let order: { bucket: number; stride: number }[] | null = null;
    let orderIdx = 0;

    const buildOrder = (dur: number) => {
      const last = Math.floor(dur / THUMB_INTERVAL_S);
      const seen = new Set<number>();
      const out: { bucket: number; stride: number }[] = [];
      for (const step of STRIDE_PASSES) {
        for (let i = 0; i <= last; i += step) {
          if (seen.has(i)) continue;
          seen.add(i);
          out.push({ bucket: i * THUMB_INTERVAL_S, stride: step * THUMB_INTERVAL_S });
        }
      }
      return out;
    };

    const nextBucket = (dur: number): number | null => {
      if (!order) {
        order = buildOrder(dur);
        coverageStepRef.current = STRIDE_PASSES[0] * THUMB_INTERVAL_S;
      }
      while (orderIdx < order.length) {
        const { bucket, stride } = order[orderIdx++];
        // Claim the density of the pass we're currently in. It runs a few
        // buckets ahead of what's actually stored (workers are in flight), but
        // the slop is a handful of frames and a hover corrects it in one seek.
        coverageStepRef.current = stride;
        if (!thumbCacheRef.current.has(bucket)) return bucket;
      }
      return null;
    };

    const runWorker = async (video: HTMLVideoElement) => {
      await whenMetadata(video);
      const dur = video.duration;
      if (!isFinite(dur) || dur === 0 || runIdRef.current !== myRun) return;
      workersActiveRef.current++;
      try {
        while (cachingActiveRef.current && runIdRef.current === myRun) {
          // Whatever the cursor is pointing at wins over the next step of a
          // walk nobody is looking at. Worst-case wait for a hover is the tail
          // of one seek, not the rest of the episode.
          let bucket = priorityBucketRef.current;
          if (bucket != null) priorityBucketRef.current = null;
          else bucket = nextBucket(dur);
          if (bucket == null) break;
          if (thumbCacheRef.current.has(bucket)) continue;
          try {
            await captureBucket(video, bucket, 3000);
          } catch {
            // Skip failed seeks
          }
        }
      } finally {
        workersActiveRef.current--;
        // Last one out: if a hover asked for a frame just as the walk was
        // ending, nobody is left to serve it and it would sit there until the
        // next pointermove. Hand it to the pump instead.
        if (workersActiveRef.current === 0 && priorityBucketRef.current != null) {
          void pumpPriority(3000);
        }
      }
    };

    cachingActiveRef.current = true;
    for (const v of videos) void runWorker(v);

    return () => {
      cachingActiveRef.current = false;
    };
  }, [src, lazy, workerCount]);

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
      const label = labelRef.current;
      if (!wrap || !canvas || !videosRef.current[0] || !label) return () => {};

      const ctx = canvas.getContext("2d");
      if (!ctx) return () => {};

    /** Render the pre-cached thumbnail (instant) for the given time. */
    const drawCachedAt = (timeSec: number): boolean => {
      const cache = thumbCacheRef.current;
      if (cache.size === 0) return false;
      const want = bucketOf(timeSec);
      // Stand in with the nearest frame WITHIN THE CURRENT DENSITY, never the
      // globally nearest — that was the original bug: while the walk sat near
      // the start, hovering at 15:00 drew the 3:00 frame, and drew that same
      // frame for every position further right, so moving changed nothing on
      // screen. Bounding the search by the coverage the walk actually claims
      // keeps the stand-in honest: coarse early, exact within a second.
      const reach = Math.max(THUMB_INTERVAL_S, coverageStepRef.current);
      let best = -1;
      for (let d = 0; d <= reach; d += THUMB_INTERVAL_S) {
        if (cache.has(want - d)) {
          best = want - d;
          break;
        }
        if (cache.has(want + d)) {
          best = want + d;
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
      // STATIC thumbnail only. We do NOT draw the hidden video's live frame
      // here — it keeps moving (it's mid-seek for the background pre-cache),
      // so the preview would "play" instead of staying on the hovered frame.
      if (drawCachedAt(timeSec)) {
        paintedRef.current = true;
        return;
      }
      // Nothing usable yet: KEEP whatever is already on the canvas rather than
      // blanking it. An out-of-date frame reads far better than an empty box,
      // and the exact one is already being fetched at priority — it lands in a
      // fraction of a second. The placeholder is only for the very first hover,
      // when there is genuinely nothing to keep.
      if (!paintedRef.current) drawPlaceholder();
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
      if (!thumbCacheRef.current.has(bucket)) {
        priorityBucketRef.current = bucket;
        // Only acts once the walk is done; while it runs, a walker takes it.
        void pumpPriority(captureTimeoutMs);
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
      {/* Hidden source videos — never shown, only sampled. Several of them so
          the thumbnail walk overlaps its seek latencies instead of paying
          them one after another (see PARALLEL_DECODERS). */}
      {Array.from({ length: workerCount }).map((_, i) => (
        <video
          key={i}
          ref={(el) => {
            videosRef.current[i] = el;
          }}
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
      ))}

      {/* Portal the tooltip into the player root so it stays visible when the
          player enters native fullscreen (the browser hides everything outside
          the fullscreen element). Falls back to inline render until playerEl
          resolves — same visual outcome, just not fullscreen-safe yet. */}
      {playerEl ? createPortal(tooltip, playerEl) : tooltip}
    </>
  );
}

/** Resolve once the element knows its duration (or after a generous bail-out,
 *  so a decoder that never reports metadata can't wedge the walk forever). */
function whenMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener("loadedmetadata", done);
      resolve();
    };
    video.addEventListener("loadedmetadata", done);
    setTimeout(done, 20000);
  });
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
        // resolve on the next macrotask as a floor. When rVFC DOES work it
        // wins the race in ~one frame, so this only costs anything on the
        // browsers that need it; 60ms rather than 120 because it is paid on
        // every single capture and there are >100 of them per episode.
        setTimeout(() => done(resolve), 60);
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
