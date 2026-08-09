import { useEffect, useRef } from "react";

/**
 * The ambient light behind the preview card, once the trailer is running.
 *
 * IT IS THE PLAYER'S OWN PICTURE, not a copy of it. Each frame is drawn from
 * the <video> the visitor is watching into a tiny canvas, which CSS then scales
 * up and blurs out of recognition.
 *
 * Two earlier versions were a SECOND copy of the video, because there was no
 * other option: nothing can read a frame out of a cross-origin YouTube embed,
 * so a glow that follows the picture had to be a whole second playback of it.
 * That copy brought its own decoder, its own buffering and its own clock — and
 * therefore its own drift. It showed a dark shot while the card showed fire,
 * and no amount of resynchronising two independent decoders fixes that
 * category of problem; it only narrows the window.
 *
 * Drawing from the real element removes the category. There is one decoder, one
 * clock, and the glow cannot disagree with the picture because it IS the
 * picture. It also costs nothing to speak of: the canvas is 64x36, and the
 * bytes were already decoded for the player.
 *
 * Being outside the card is what makes it an ambient light rather than a
 * background: the card clips its children and paints an opaque surface, so
 * anything inside it can neither spill past the edges nor sit behind them.
 */

/** Matches PreviewCard's still-artwork stage, so the hand-off is invisible. */
const AMBIENT_OPACITY = 0.85;
/**
 * Sampling resolution. Absurdly small on purpose — the result is blurred by
 * 24 px and stretched across the whole card, so detail is not merely wasted,
 * it is unreachable. What survives is colour and rough layout, which is all a
 * glow is.
 */
const W = 64;
const H = 36;
/**
 * Frames per second. A glow does not need 60: the eye reads it as light, not as
 * motion, and every draw is work on the same thread as the page's scrolling.
 */
const FPS = 12;

export default function TrailerAmbient({
  playing,
  sourceRef,
  zoom,
}: {
  /** Faded out while the real player is stopped, so the two agree. */
  playing: boolean;
  /** The player whose frames this paints. */
  sourceRef: React.RefObject<HTMLVideoElement>;
  /** The crop measured for the picture — the glow has to be framed like it. */
  zoom: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!playing) return;
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    let raf = 0;
    let last = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < 1000 / FPS) return;
      last = now;
      const video = sourceRef.current;
      // readyState 2 = HAVE_CURRENT_DATA: there is a frame to copy. Drawing
      // before that paints black, which is the artefact this rewrite exists to
      // remove.
      if (!video || video.readyState < 2) return;
      try {
        ctx.drawImage(video, 0, 0, W, H);
      } catch {
        // A frame that cannot be drawn is skipped, not retried — the next one
        // is 80 ms away.
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [playing, sourceRef]);

  return (
    // blur + saturate on THIS element, not in the stylesheet: overflow-hidden
    // clips the content to the box, then the filter blurs the clipped result, so
    // the glow spills past the edges. That order is what makes it a light rather
    // than a background.
    <div
      className="as-preview-ambient pointer-events-none absolute -z-10 overflow-hidden blur-2xl saturate-200 transition-opacity duration-700"
      style={{ opacity: playing ? AMBIENT_OPACITY : 0 }}
    >
      <canvas
        ref={ref}
        width={W}
        height={H}
        aria-hidden
        className="absolute inset-0 h-full w-full transform-gpu object-cover"
        style={{ transform: `scale(${zoom})` }}
      />
    </div>
  );
}
