import { useEffect, useRef } from "react";
import { registerTransitionHost } from "@/lib/player/episodeTransition";

/**
 * The element that holds fullscreen WHILE we navigate to another episode.
 *
 * Mounted once in `_app` (outside the page tree) so it survives every
 * navigation — that's the whole point: the player is remounted per episode and
 * takes fullscreen down with it, this host doesn't.
 *
 * Visibility is driven by a `data-active` attribute set imperatively from
 * `lib/player/episodeTransition` (not React state) so it's painted in the same
 * tick as the `requestFullscreen()` call. Content is deliberately minimal: a
 * black screen with the site's pink loading bar on top, i.e. the same signal
 * the user gets from `<NextNProgress>` on a normal page change — which is
 * invisible while another element owns the screen.
 */
export default function EpisodeTransitionOverlay() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    registerTransitionHost(ref.current);
    return () => registerTransitionHost(null);
  }, []);

  return (
    <div ref={ref} className="aniscroll-ep-transition" aria-hidden="true">
      <div className="aniscroll-ep-transition__bar" />
    </div>
  );
}
