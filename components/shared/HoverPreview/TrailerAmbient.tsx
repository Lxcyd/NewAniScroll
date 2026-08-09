import { useEffect, useRef } from "react";

import { trailerSrc } from "@/lib/preview/trailerCrop";

/**
 * The ambient light behind the preview card, once the trailer is running.
 *
 * WHY A SECOND COPY OF THE VIDEO. A glow that follows the picture cannot be
 * computed from a still, so it has to be the moving picture itself, blurred out
 * of recognition. That is Hayase's trick and there is no cheaper one.
 *
 * It used to be a second YouTube iframe, for a reason that no longer holds:
 * nothing could read a frame out of a cross-origin embed. Now that the trailer
 * is an MP4 we serve, a second <video> costs almost nothing — the file is in
 * the browser's cache from the first element, so this is a cache read rather
 * than a second download — and it can be kept in step with the real player,
 * which an iframe never could.
 *
 * It stays decoration: muted for life, no controls, no state anyone reads.
 *
 * Being outside the card is what makes it an ambient light rather than a
 * background: the card clips its children and paints an opaque surface, so
 * anything inside it can neither spill past the edges nor sit behind them.
 */

/** Matches PreviewCard's still-artwork stage, so the hand-off is invisible. */
const AMBIENT_OPACITY = 0.85;
/** Past this much drift from the real player, snap back. */
const MAX_DRIFT_S = 0.35;
const SYNC_EVERY_MS = 2000;

export default function TrailerAmbient({
  id,
  playing,
  sourceRef,
  zoom,
}: {
  id: string;
  /** Faded out while the real player is stopped, so the two agree. */
  playing: boolean;
  /** The real player, whose clock this one follows. */
  sourceRef: React.RefObject<HTMLVideoElement>;
  /** The crop measured for the picture — the glow has to be framed like it. */
  zoom: number;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  /**
   * Follow the real player's clock.
   *
   * Both copies start together and read the same bytes, so they only drift by
   * their own buffering — but a glow that lags across a scene cut shows the
   * previous shot's colour, which reads as a rendering fault. Correcting on a
   * threshold rather than continuously keeps the seeks rare: a video that is
   * merely a few frames behind is not worth interrupting.
   */
  useEffect(() => {
    const timer = setInterval(() => {
      const mine = ref.current;
      const theirs = sourceRef.current;
      if (!mine || !theirs || theirs.paused || mine.seeking) return;
      if (Math.abs(mine.currentTime - theirs.currentTime) > MAX_DRIFT_S) {
        mine.currentTime = theirs.currentTime;
      }
    }, SYNC_EVERY_MS);
    return () => clearInterval(timer);
  }, [sourceRef]);

  return (
    // blur + saturate on THIS element, not in the stylesheet: overflow-hidden
    // clips the video to the box, then the filter blurs the clipped result, so
    // the glow spills past the edges. That order is what makes it a light rather
    // than a background.
    <div
      className="as-preview-ambient pointer-events-none absolute -z-10 overflow-hidden blur-2xl saturate-200 transition-opacity duration-700"
      style={{ opacity: playing ? AMBIENT_OPACITY : 0 }}
    >
      <video
        ref={ref}
        src={trailerSrc(id)}
        autoPlay
        loop
        muted
        playsInline
        aria-hidden
        tabIndex={-1}
        className="pointer-events-none absolute inset-0 h-full w-full transform-gpu object-cover"
        style={{ transform: `scale(${zoom})` }}
      />
    </div>
  );
}
