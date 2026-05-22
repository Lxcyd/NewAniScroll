import {
  type MediaPlayerInstance,
  useMediaState,
} from "@vidstack/react";
import { useWatchProvider } from "@/lib/context/watchPageProvider";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/router";

const SEGMENT_LABEL: Record<string, string> = {
  op: "Skip Intro",
  ed: "Skip Outro",
  recap: "Skip Recap",
};

/* How early before the very end of the episode we surface the
   "Next Episode" button when AniSkip has no outro marker. Matches
   the Crunchyroll / Netflix behaviour. */
const NEXT_EP_TAIL_SECONDS = 30;

/* When we skip past an outro/intro we ask the player to seek a tiny
   amount BEFORE the segment end to give the HLS source time to warm
   up the next buffer window. Without this, on slow connections the
   user sees a spinner immediately after the skip. */
const SKIP_PRELOAD_LEAD_MS = 250;

type Props = {
  playerRef: React.RefObject<MediaPlayerInstance>;
  /** Episode after this one — used to wire the "Next Episode" button.
   *  Pass null to hide that button on the last episode. */
  nextEpisodeHref?: string | null;
};

/**
 * Visual overlay for AniSkip op/ed/recap intervals.
 *
 * Responsibilities:
 *
 *   1. **Seek-bar gap separators.** Paints thin black vertical lines
 *      into Vidstack's `.vds-time-slider .vds-slider-track` at the
 *      start and end of every AniSkip segment. The bar keeps its
 *      brand-red progress colour — the gaps just split it into
 *      chapter-style segments, the same way YouTube / Crunchyroll do.
 *      No coloured overlays, no opacity tricks.
 *
 *   2. **Skip + Next Episode buttons.** Bottom-right of the player:
 *        - inside an `op` segment: "Skip Intro"
 *        - inside an `ed` segment: "Skip Outro" AND "Next Episode"
 *        - inside a `recap` segment: "Skip Recap"
 *        - in the last 30s of the episode (no outro detected): "Next
 *          Episode"
 *      Skip seeks to `segment.end - 0.5s`; we then deliberately call
 *      `player.startLoading()` (no-op if not paused) and bump the
 *      buffered range by triggering a play() so the HLS engine starts
 *      fetching the post-skip segment immediately.
 */
export default function SkipOverlay({ playerRef, nextEpisodeHref }: Props) {
  const { skipTimes } = useWatchProvider();
  const currentTime = useMediaState("currentTime", playerRef);
  const duration = useMediaState("duration", playerRef);
  const router = useRouter();

  /* Active segment = the one (if any) whose [start, end] window contains
     currentTime. Recomputed on every tick — cheap (≤3 entries). */
  const active = useMemo(() => {
    if (!Array.isArray(skipTimes) || skipTimes.length === 0) return null;
    for (const s of skipTimes) {
      if (currentTime >= s.start && currentTime < s.end) return s;
    }
    return null;
  }, [skipTimes, currentTime]);

  /* "Next Episode" pill should appear:
       - whenever we're in an `ed` segment (the outro is the natural
         signal that the credits are rolling)
       - OR in the last NEXT_EP_TAIL_SECONDS of the episode, regardless
         of AniSkip coverage. Many fillers / non-standard episodes have
         no `ed` entry; without this safety we'd never surface the
         button on those. */
  const isInOutro = active?.type === "ed";
  const isNearEnd =
    duration > 0 && currentTime >= duration - NEXT_EP_TAIL_SECONDS;
  const showNext = (isInOutro || isNearEnd) && !!nextEpisodeHref;

  /* Portal target = Vidstack's time-slider track element. Vidstack mounts
     it lazily after the player is ready; we poll with rAF until found,
     then keep the reference in state so the portal re-runs against it.
     Reset on episode change (new skip data) in case Vidstack remounts
     the slider — happens e.g. when the source `src` changes. */
  const [sliderEl, setSliderEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSliderEl(null);
    if (!skipTimes?.length) return;
    let cancelled = false;
    let raf = 0;
    const findSlider = () => {
      if (cancelled) return;
      const el = playerRef.current?.el?.querySelector(
        ".vds-time-slider .vds-slider-track"
      ) as HTMLElement | null;
      if (el) {
        setSliderEl(el);
        return;
      }
      raf = requestAnimationFrame(findSlider);
    };
    findSlider();
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [skipTimes, playerRef]);

  /* Skip handler. Seeks slightly before the segment end so the HLS
     engine has time to fetch the chunk that contains the post-skip
     range before playback reaches it. Then ensures playback is
     active — paused users still want to scrub past the credits. */
  const skipTo = (endSeconds: number) => {
    const player = playerRef.current;
    if (!player) return;
    const target = Math.max(0, endSeconds - SKIP_PRELOAD_LEAD_MS / 1000);
    player.currentTime = target;
    // Best-effort buffer warm-up. `play()` returns a promise; we don't
    // care about the result (autoplay rejection only matters for muted-
    // unmuted dance, which is handled elsewhere).
    try {
      player.play?.();
    } catch {
      /* paused-state navigations may throw on browsers that block
         programmatic play; ignore. */
    }
  };

  const goToNextEpisode = () => {
    if (!nextEpisodeHref) return;
    router.push(nextEpisodeHref);
  };

  if (!skipTimes?.length && !showNext) return null;

  /* Pre-compute the segment boundary fractions (0..1) used by the gap
     markers. We render TWO 2px-wide black bars per segment — one at
     start, one at end — to carve the slider track into chapter-like
     pieces. Bars at fraction 0 or 1 are skipped (they'd overlap the
     track edges and look like rendering bugs). */
  const boundaries: number[] = [];
  if (duration > 0 && skipTimes?.length) {
    for (const s of skipTimes) {
      const a = s.start / duration;
      const b = s.end / duration;
      if (a > 0.005 && a < 0.995) boundaries.push(a);
      if (b > 0.005 && b < 0.995) boundaries.push(b);
    }
  }

  return (
    <>
      {/* Gap separators portaled into the slider track. pointer-events:
          none so the user can still drag through them. z-index above
          fill (Vidstack's track-fill uses default stacking) so the
          gap is visible whether the segment is played or not. */}
      {sliderEl && duration > 0 &&
        createPortal(
          <>
            {boundaries.map((frac, i) => (
              <div
                key={`bound-${i}`}
                className="aniscroll-skip-gap"
                style={{
                  position: "absolute",
                  left: `${frac * 100}%`,
                  top: 0,
                  bottom: 0,
                  width: 2,
                  background: "rgba(0,0,0,0.95)",
                  transform: "translateX(-1px)",
                  pointerEvents: "none",
                  /* Sit above Vidstack's fill so the gap reads as
                     a true cut, not a tint over the progress. */
                  zIndex: 5,
                }}
              />
            ))}
          </>,
          sliderEl
        )}

      {/* Right-aligned action stack. Two buttons can be visible at
          once (Skip Outro + Next Episode) so we use a flex row with
          a small gap and let them grow naturally. */}
      {(active || showNext) && (
        <div
          style={{
            position: "absolute",
            right: 24,
            bottom: 92,
            zIndex: 30,
            display: "flex",
            gap: 10,
          }}
        >
          {active && (
            <button
              type="button"
              onClick={() => skipTo(active.end)}
              className="aniscroll-skip-btn"
              style={btnStyle}
            >
              {SEGMENT_LABEL[active.type] || "Skip"}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path
                  d="M5 4l10 8-10 8V4zM19 5v14"
                  stroke="white"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
          {showNext && (
            <button
              type="button"
              onClick={goToNextEpisode}
              className="aniscroll-next-btn"
              style={{
                ...btnStyle,
                background: "linear-gradient(135deg, #ff3b5c 0%, #e8294b 100%)",
                border: "1px solid rgba(255,255,255,0.18)",
              }}
            >
              Next Episode
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path
                  d="M5 4l10 8-10 8V4zM19 5v14"
                  stroke="white"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>
      )}
    </>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "10px 18px",
  borderRadius: 8,
  background: "rgba(20, 22, 30, 0.85)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  border: "1px solid rgba(255,255,255,0.18)",
  color: "white",
  fontWeight: 600,
  fontSize: 14,
  letterSpacing: "0.02em",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 8,
  boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
};
