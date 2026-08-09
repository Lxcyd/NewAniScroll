/**
 * The ambient light behind the preview card, once the trailer is running.
 *
 * WHY A SECOND IFRAME. There is no way to read a frame out of a cross-origin
 * YouTube embed — no canvas, no pixels, nothing. So a glow that follows the
 * video cannot be computed; it has to be a second copy of the video, blurred out
 * of recognition. That is Hayase's trick and there is no cheaper one.
 *
 * It is not free, so it is kept as small as the effect allows:
 *   - it mounts only once the real trailer reports that it is PLAYING, so it
 *     never competes for bandwidth during the startup that the user is actually
 *     waiting on. Until then PreviewCard's blurred banner holds the glow;
 *   - it is muted for life and carries no API handshake — it is decoration, it
 *     has no state anyone reads;
 *   - it loops with `loop=1&playlist=<id>` instead of the manual remount the
 *     real player needs. That makes YouTube draw extra chrome, which does not
 *     survive a 38 px blur.
 *
 * Being outside the card is what makes it an ambient light rather than a
 * background: the card clips its children and paints an opaque surface, so
 * anything inside it can neither spill past the edges nor sit behind them.
 */

const ORIGIN = "https://www.youtube-nocookie.com";

/** Matches PreviewCard's still-artwork stage, so the hand-off is invisible. */
const AMBIENT_OPACITY = 0.85;

export default function TrailerAmbient({ id }: { id: string }) {
  return (
    // blur + saturate on THIS element, not in the stylesheet: overflow-hidden
    // clips the video to the box, then the filter blurs the clipped result, so
    // the glow spills past the edges. That order is what makes it a light rather
    // than a background.
    <div
      className="as-preview-ambient pointer-events-none absolute -z-10 overflow-hidden blur-2xl saturate-200"
      style={{ opacity: AMBIENT_OPACITY }}
    >
      <iframe
        {...({ credentialless: "true" } as Record<string, string>)}
        title=""
        aria-hidden
        tabIndex={-1}
        allow="autoplay"
        // Overscanned vertically so the player's own letterboxing never shows up
        // as two dark bands in the glow.
        className="pointer-events-none absolute left-0 top-1/2 h-[calc(100%+160px)] w-full -translate-y-1/2 transform-gpu border-0"
        src={`${ORIGIN}/embed/${id}?autoplay=1&mute=1&controls=0&disablekb=1&rel=0&playsinline=1&fs=0&loop=1&playlist=${id}`}
      />
    </div>
  );
}
