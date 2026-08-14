import { useEffect, useRef } from "react";

/**
 * The ambient light behind the preview card — the watch player's projector
 * stack, scaled down to a card.
 *
 * The technique is LiveAmbient's, in components/watch/primary/UniversalPlayer:
 * several concentric copies of the picture, each one enlarged a little more and
 * faded a lot more, all heavily blurred. Nothing masks them. The falloff is a
 * property of the STACK — only the widest copies reach far from the card, and
 * those are the faintest — so the light is dense against the picture and dies
 * with distance, which is what light does.
 *
 * That is worth spelling out because the previous attempt here tried to get the
 * same result with a single layer and a radial mask, and could not: a mask that
 * fades early makes the glow evenly hazy right up against the picture, and one
 * that fades late meets its own edge with enough alpha to draw a visible
 * rectangle. There is no setting between those two that behaves like light. The
 * stack has no such dilemma.
 *
 * It also draws from the player's OWN element rather than from a second copy of
 * the video. A second <video> brought its own decoder, buffer and clock, and so
 * its own drift — it would show a dark shot while the card showed fire. There is
 * one decoder now, read twice.
 *
 * Being outside the card is what makes it an ambient light rather than a
 * background: the card clips its children and paints an opaque surface, so
 * anything inside it can neither spill past the edges nor sit behind them.
 */

/** Concentric copies. Same shape of stack as the player, fewer layers. */
const LAYERS = 5;
/** Each layer is this much larger than the one before. */
const SCALE_STEP = 0.08;
/** Opacity of the innermost layer, and the decay applied to each one after. */
const BASE_OPACITY = 0.9;
const OPACITY_DECAY = 0.62;
/**
 * Blur radius. The player uses 72 px across ~1200 px of video; this is the same
 * proportion of a 364 px card. Enough that no layer's edge is ever a line.
 */
const BLUR_PX = 34;
/** Sampling canvas. Small — the result is blurred beyond any detail it holds. */
const SRC_W = 160;
const SRC_H = 90;
/** A glow is read as light, not as motion. 30 fps is already generous. */
const SAMPLE_INTERVAL_MS = 1000 / 30;
/**
 * Length of the extinction ramp, in canvas heights.
 *
 * Where it ENDS is computed per layer rather than fixed — see publish. A single
 * shared value cannot work: the ramp lives in canvas coordinates and every
 * layer is then scaled about its centre, so the same stop lands further down
 * the screen the wider the layer is. With a fixed ramp ending at the canvas
 * bottom, the outermost layer still carried ~27 % alpha where the card clips —
 * and that remainder is precisely the horizontal line at the foot of the glow.
 */
const FADE_LENGTH = 0.34;

/**
 * How often the storyboard blend is recomposed, in ms.
 *
 * The glow drifts between two stills; there is nothing here that needs a frame
 * rate. Slower than the video loop above on purpose — this costs three image
 * draws and a publish, and it is buying a colour, not motion.
 */
const BLEND_INTERVAL_MS = 120;

export default function TrailerAmbient({
  banner,
  sourceRef,
  playing,
  zoom,
  frames,
  progress,
}: {
  /** Painted before the trailer runs, so the card is lit from its first frame. */
  banner: string | null;
  /** The player whose frames this paints once it is running. */
  /**
   * The playing trailer, when there is an element we can read.
   *
   * Optional since the preview went back to a YouTube embed: a cross-origin
   * frame cannot be sampled, so there is nothing to hand over and the glow
   * falls back to the blurred banner below.
   */
  sourceRef?: React.RefObject<HTMLVideoElement>;
  playing: boolean;
  /** The crop measured for the picture — the glow has to be framed like it. */
  zoom: number;
  /**
   * The video's own published stills, in order, when there is no readable
   * element. See the storyboard effect below for what is and is not possible.
   */
  frames?: string[] | null;
  /** How far through the trailer the player says it is, 0 to 1. */
  progress?: number | null;
}) {
  const layerRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const prevRef = useRef<HTMLCanvasElement | null>(null);
  /**
   * The crop, readable from inside the sampling loop.
   *
   * The loop is started once and must not be torn down and rebuilt when the
   * crop lands a second or two in — restarting it would drop the temporal blend
   * and blink the glow. A ref lets the running loop see the new value.
   */
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  /** Same reason as zoomRef: the blend loop must survive a new position. */
  const progressRef = useRef<number | null | undefined>(progress);
  progressRef.current = progress;
  /**
   * Has the trailer ever put a frame on these canvases.
   *
   * The artwork stage is a one-way door. `playing` goes false on every pause,
   * and without this the artwork stage simply ran again and repainted the
   * poster over the frames — so pausing threw the glow back to the card's still
   * image instead of holding the colour that was on screen. A pause should
   * freeze the light, not rewind it.
   */
  const everDrewFrameRef = useRef(false);

  /**
   * Push whatever has just been composed onto every visible layer, erasing the
   * bottom of each as it goes.
   *
   * The erase is why this is done per layer rather than once on the source. The
   * card's clip box ends the glow at the bottom of the picture — light off a
   * screen doesn't wrap around to backlight the text below it — and a clip is a
   * straight cut, so the spill running down either side of the card ended on a
   * visible horizontal line.
   *
   * Two CSS masks were tried to soften that and both deleted the glow outright:
   * a mask is sized to its element's box and TILES over everything outside it,
   * and the tile landing above the box is the transparent end of the gradient —
   * which is precisely where the visible glow lives. Doing it in the canvas has
   * no such rules. `destination-out` with a vertical ramp takes the alpha down
   * to nothing before the clip is ever reached, so there is nothing left at the
   * cut to draw a line with.
   */
  const publish = (source: HTMLCanvasElement) => {
    layerRefs.current.forEach((layer, i) => {
      const ctx = layer?.getContext("2d");
      if (!ctx || !layer) return;
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, SRC_W, SRC_H);
      ctx.drawImage(source, 0, 0);

      /*
       * Find, in this layer's own canvas coordinates, the point that lands on
       * the card's clip line — then finish the ramp exactly there.
       *
       * Two transforms sit between the canvas and the screen. `object-fit:
       * cover` crops it to the box's aspect, so the box bottom is already short
       * of the canvas bottom; then `scale()` about the centre pushes that point
       * further up the canvas the larger the layer. Both are undone here rather
       * than approximated, because being a few percent short is not a subtle
       * error — it is the visible line this exists to remove.
       */
      const boxW = layer.clientWidth || SRC_W;
      const boxH = layer.clientHeight || SRC_H;
      const cover = Math.max(boxW / SRC_W, boxH / SRC_H);
      const visibleHalf = boxH / cover / SRC_H / 2;
      const scale = (1 + i * SCALE_STEP) * (zoomRef.current || 1);
      // Ends at the foot of the picture, not at the card's clip line — the two
      // used to be the same place, and the clip has since been moved down to
      // leave the blur room to die (see .as-preview-ambient-clip). What matters
      // here is that the LIGHT stops where the picture stops; the blur's tail
      // below that is the soft ending, not a defect.
      const end = Math.min(1, 0.5 + visibleHalf / scale);
      const start = Math.max(0.15, end - FADE_LENGTH);

      const ramp = ctx.createLinearGradient(0, SRC_H * start, 0, SRC_H * end);
      ramp.addColorStop(0, "rgba(0,0,0,0)");
      ramp.addColorStop(1, "rgba(0,0,0,1)");
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = ramp;
      // Past the ramp's end the gradient keeps its last stop, so everything
      // below the clip line is erased outright rather than merely faded.
      ctx.fillRect(0, 0, SRC_W, SRC_H);
      ctx.globalCompositeOperation = "source-over";
    });
  };

  const ensureCanvases = () => {
    if (!sourceCanvasRef.current) {
      const c = document.createElement("canvas");
      c.width = SRC_W;
      c.height = SRC_H;
      sourceCanvasRef.current = c;
    }
    if (!prevRef.current) {
      const c = document.createElement("canvas");
      c.width = SRC_W;
      c.height = SRC_H;
      prevRef.current = c;
    }
    return { source: sourceCanvasRef.current, prev: prevRef.current };
  };

  /**
   * Before playback: light the card from the artwork it is already showing.
   *
   * Drawn once, on load — a still has nothing to animate. This is what used to
   * be a blurred <img> copy of the banner, and moving it into the same stack is
   * what makes the hand-off to the video invisible: the two stages are now the
   * same pixels going through the same layers.
   */
  useEffect(() => {
    if (!banner || playing || everDrewFrameRef.current) return;
    const { source } = ensureCanvases();
    const ctx = source.getContext("2d");
    if (!ctx) return;
    const img = new Image();
    // AniList's CDN doesn't need it, and a taint costs nothing here: these
    // canvases are only ever drawn from, never read back.
    img.decoding = "async";
    img.src = banner;
    let cancelled = false;
    const paint = () => {
      if (cancelled) return;
      try {
        ctx.drawImage(img, 0, 0, SRC_W, SRC_H);
        publish(source);
      } catch {
        /* nothing to light the card with — the card is still perfectly usable */
      }
    };
    if (img.complete) paint();
    else img.addEventListener("load", paint);
    return () => {
      cancelled = true;
      img.removeEventListener("load", paint);
    };
  }, [banner, playing]);

  /**
   * The glow from a video we are not allowed to look at.
   *
   * WHY THIS IS NOT THE LOOP BELOW. That one reads the playing element 30 times
   * a second, which is only possible when we own the element. The preview is a
   * cross-origin YouTube embed: its pixels are unreachable, and the glow was
   * therefore frozen on the banner from the first frame to the last — lit, but
   * dead.
   *
   * WHAT IS REACHABLE. Exactly three stills, at ~25/50/75 % through the video
   * (see storyboardFrames — the real per-second storyboard sheets are signed and
   * answer 403 to anyone but the player). Three colours would be three jumps, so
   * they are not switched between: the light sits CONTINUOUSLY between the two
   * stills the playhead is currently between, weighted by how far along it is.
   * The colour then drifts the whole way through the trailer instead of stepping.
   *
   * Honest about what this is: the glow follows the video's broad colour arc, not
   * its cuts. A flash of fire between two samples never reaches the card. That is
   * the ceiling of what a cross-origin embed allows, and it is a great deal
   * better than a still that never changes at all.
   */
  useEffect(() => {
    if (!playing || !frames?.length || progress == null || sourceRef?.current) return;
    const { source } = ensureCanvases();
    const ctx = source.getContext("2d");
    if (!ctx) return;

    let cancelled = false;
    const images: (HTMLImageElement | null)[] = frames.map(() => null);
    frames.forEach((url, i) => {
      const img = new Image();
      // Never read back — only drawn — so a taint would cost nothing. Asked for
      // anyway because these are the same URLs the bar detector already fetched
      // WITH it, and a second request under different rules would miss that
      // cache entirely.
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.src = url;
      img
        .decode()
        .then(() => {
          if (!cancelled) images[i] = img;
        })
        .catch(() => {});
    });

    const timer = setInterval(() => {
      if (cancelled || document.hidden) return;
      const p = progressRef.current;
      if (p == null) return;
      // Where the stills actually sit: 1/6, 3/6, 5/6 of the video — the middle
      // of each third, not its edges. Placing them at 0, 0.5 and 1 would make
      // the light lead the picture at the start and lag it at the end.
      const pos = Math.min(images.length - 1, Math.max(0, p * images.length - 0.5));
      const i = Math.min(images.length - 2, Math.floor(pos));
      const w = Math.min(1, Math.max(0, pos - i));
      const a = images[i];
      const b = images[i + 1] ?? a;
      if (!a && !b) return;
      try {
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, SRC_W, SRC_H);
        if (a) ctx.drawImage(a, 0, 0, SRC_W, SRC_H);
        if (b && w > 0) {
          ctx.globalAlpha = a ? w : 1;
          ctx.drawImage(b, 0, 0, SRC_W, SRC_H);
          ctx.globalAlpha = 1;
        }
        publish(source);
        everDrewFrameRef.current = true;
      } catch {
        /* a still that will not draw is skipped; the next tick is 120 ms away */
      }
    }, BLEND_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // `progress` is read through a ref inside the interval — see progressRef —
    // so that a new value does not tear down and rebuild the whole blend.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, frames, sourceRef]);

  /** Once the trailer runs, the glow is its frames. */
  useEffect(() => {
    // No element to read means no loop to run: the embed path is handled above.
    if (!playing || !sourceRef) return;
    const { source, prev } = ensureCanvases();
    const sctx = source.getContext("2d");
    const pctx = prev.getContext("2d");
    if (!sctx || !pctx) return;
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = "high";

    let raf = 0;
    let lastSampleAt = 0;
    let lastFrameTime = -1;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (document.hidden) return;
      if (now - lastSampleAt < SAMPLE_INTERVAL_MS) return;
      lastSampleAt = now;

      const video = sourceRef?.current;
      // readyState 2 = HAVE_CURRENT_DATA: there is a frame to copy. Drawing
      // before that paints black, and a black glow reads as a smear beside the
      // card rather than as "nothing yet".
      if (!video || video.readyState < 2 || video.videoWidth === 0) return;
      if (video.currentTime === lastFrameTime) return;
      lastFrameTime = video.currentTime;

      try {
        sctx.drawImage(video, 0, 0, SRC_W, SRC_H);
        // Pairwise blend with the previous sample. Softens scene cuts — and,
        // at the very start, blends out of the banner still that was already on
        // these canvases, so the hand-off is a dissolve rather than a jump.
        sctx.globalAlpha = 0.5;
        sctx.drawImage(prev, 0, 0);
        sctx.globalAlpha = 1;
        pctx.clearRect(0, 0, SRC_W, SRC_H);
        pctx.drawImage(source, 0, 0);
        publish(source);
        everDrewFrameRef.current = true;
      } catch {
        /* a frame that can't be drawn is skipped; the next is 33 ms away */
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, sourceRef]);

  return (
    /*
     * The blur is ONE pass over the whole stack, not one per layer.
     *
     * A Gaussian blur is linear and so is an opacity multiply, so
     * `blur(Σ opacityᵢ·layerᵢ)` and `Σ opacityᵢ·blur(layerᵢ)` are the same
     * picture — the falloff still comes from the stack, exactly as described
     * above. What changes is the cost: five blurred surfaces meant the
     * compositor ran a 34 px blur five times for every sampled frame, thirty
     * times a second, which is what made a hovered card crawl on an integrated
     * GPU. The scales stay per layer (they are what the stack IS); only the
     * filter moves up, so the GPU work drops to a fifth.
     */
    <div
      className="pointer-events-none absolute inset-0"
      aria-hidden
      style={{ filter: `blur(${BLUR_PX}px) saturate(1.8)` }}
    >
      {Array.from({ length: LAYERS }).map((_, i) => (
        <div
          key={i}
          className="absolute inset-0"
          style={{
            transform: `scale(${(1 + i * SCALE_STEP) * zoom})`,
            transformOrigin: "center",
            opacity: BASE_OPACITY * Math.pow(OPACITY_DECAY, i),
            willChange: "transform",
          }}
        >
          <canvas
            ref={(el) => {
              layerRefs.current[i] = el;
            }}
            width={SRC_W}
            height={SRC_H}
            // Stretched by CSS, not by the canvas: browsers resample an
            // upscaled canvas with nearest-neighbour and leave a visible pixel
            // grid, while a CSS-sized replaced element gets bilinear filtering
            // on the GPU. The player learned this the hard way — see LiveAmbient.
            style={{ width: "100%", height: "100%", display: "block", objectFit: "cover" }}
          />
        </div>
      ))}
    </div>
  );
}
