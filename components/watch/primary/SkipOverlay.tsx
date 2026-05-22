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

/* Buffer warm-up offset: skip lands `SKIP_PRELOAD_LEAD_MS` before the
   segment end so the HLS engine has time to fetch the post-skip
   chunk before playback hits it. */
const SKIP_PRELOAD_LEAD_MS = 250;

/* Ignore AniSkip entries that:
   - have no duration (start == end)
   - are shorter than 5 s (single-frame markers that pollute the bar
     with extra cuts but aren't worth showing)
   - start within the first 3 s — AniSkip occasionally has bogus
     "ed" entries at t=0 for sub-episodes (recaps, OVAs) that fire
     the Skip Outro button at episode start, which is the bug shown
     in the user's screenshot. A real outro never starts in the
     first 3 s. */
const MIN_SEGMENT_DURATION = 5;
const MIN_OUTRO_START = 3;

type Props = {
  playerRef: React.RefObject<MediaPlayerInstance>;
  /** Episode after this one — used to wire the "Next Episode" button.
   *  Pass null to hide that button on the last episode. */
  nextEpisodeHref?: string | null;
};

/**
 * Visual overlay for AniSkip op/ed/recap intervals.
 *
 *   1. **Seek-bar gap separators.** Thin black vertical lines at the
 *      start and end of every kept segment, portaled into Vidstack's
 *      `.vds-time-slider .vds-slider-track`. Segments shorter than
 *      MIN_SEGMENT_DURATION are dropped so the bar shows at most 4
 *      cuts (op start + op end + ed start + ed end). Recaps are kept
 *      visually but no longer surface a button.
 *
 *   2. **Skip + Next Episode buttons.** Bottom-right of the player:
 *        - inside an `op` segment: "Skip Intro"
 *        - inside an `ed` segment: "Skip Outro" + "Next Episode"
 *        - in the last 30 s of the episode: "Next Episode"
 *      Buttons are portaled INTO Vidstack's player element so the
 *      Fullscreen API picks them up (otherwise sibling elements
 *      disappear when the user enters fullscreen).
 */
export default function SkipOverlay({ playerRef, nextEpisodeHref }: Props) {
  const { skipTimes } = useWatchProvider();
  const currentTime = useMediaState("currentTime", playerRef);
  const duration = useMediaState("duration", playerRef);
  const router = useRouter();

  /* Sanitised segments: drop bogus zero-duration markers and dubious
     entries that would fire the Skip Outro at t=0. We do this *after*
     the raw data is fetched so the watch-page reducer stays simple. */
  const cleanSegments = useMemo(() => {
    if (!Array.isArray(skipTimes)) return [];
    return skipTimes.filter((s) => {
      if (s.end - s.start < MIN_SEGMENT_DURATION) return false;
      if (s.type === "ed" && s.start < MIN_OUTRO_START) return false;
      return true;
    });
  }, [skipTimes]);

  /* Active segment = the one (if any) whose [start, end] window
     contains currentTime. We require duration > 0 so we don't fire
     at the very first frames before metadata loads (Vidstack reports
     duration: 0 briefly at mount). */
  const active = useMemo(() => {
    if (duration <= 0) return null;
    if (cleanSegments.length === 0) return null;
    for (const s of cleanSegments) {
      if (currentTime >= s.start && currentTime < s.end) return s;
    }
    return null;
  }, [cleanSegments, currentTime, duration]);

  /* "Next Episode" pill should appear:
       - whenever we're inside a *valid* `ed` segment (filtered above)
       - OR in the last NEXT_EP_TAIL_SECONDS of the episode
     We also require duration > 0 so the button doesn't appear before
     metadata loads — that was the second half of the "skip outro at
     0:50" bug, since `currentTime >= 0 - 30` is true. */
  const isInOutro = active?.type === "ed";
  const isNearEnd =
    duration > 0 && currentTime >= duration - NEXT_EP_TAIL_SECONDS;
  const showNext = (isInOutro || isNearEnd) && !!nextEpisodeHref;

  /* Slider portal target — Vidstack mounts it lazily so we poll. */
  const [sliderEl, setSliderEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSliderEl(null);
    if (!cleanSegments.length) return;
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
  }, [cleanSegments, playerRef]);

  /* Player root portal target — used so buttons stay visible when
     the user enters native fullscreen (the Fullscreen API only
     keeps DOM descendants of the requested element). */
  const [playerEl, setPlayerEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let raf = 0;
    const find = () => {
      const el = (playerRef.current?.el as HTMLElement | undefined) || null;
      if (el) {
        setPlayerEl(el);
        return;
      }
      raf = requestAnimationFrame(find);
    };
    find();
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [playerRef]);

  const skipTo = (endSeconds: number) => {
    const player = playerRef.current;
    if (!player) return;
    const target = Math.max(0, endSeconds - SKIP_PRELOAD_LEAD_MS / 1000);
    player.currentTime = target;
    try {
      player.play?.();
    } catch {
      /* paused-state autoplay rejection — harmless */
    }
  };

  const goToNextEpisode = () => {
    if (!nextEpisodeHref) return;
    router.push(nextEpisodeHref);
  };

  if (!cleanSegments.length && !showNext) return null;

  /* Boundary fractions (0..1) for the seek-bar gaps. We only draw
     gaps for KEPT segments (cleanSegments), so the bar has at most
     2 segments × 2 boundaries = 4 cuts. */
  const boundaries: number[] = [];
  if (duration > 0) {
    for (const s of cleanSegments) {
      const a = s.start / duration;
      const b = s.end / duration;
      if (a > 0.005 && a < 0.995) boundaries.push(a);
      if (b > 0.005 && b < 0.995) boundaries.push(b);
    }
  }

  const buttonStack = (active || showNext) ? (
    <div
      style={{
        position: "absolute",
        right: 24,
        bottom: 92,
        zIndex: 30,
        display: "flex",
        gap: 10,
        pointerEvents: "auto",
      }}
    >
      {active && SEGMENT_LABEL[active.type] && (
        <button
          type="button"
          onClick={() => skipTo(active.end)}
          className="aniscroll-skip-btn"
          style={btnStyle}
        >
          {SEGMENT_LABEL[active.type]}
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
  ) : null;

  return (
    <>
      {/* Gap separators inside the slider track. Rounded ends carve the
          bar into pill-shaped chapters, matching the reference design. */}
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
                  top: -2,
                  bottom: -2,
                  /* 6 px gap reads as a true chapter cut against the
                     8 px track height; smaller values disappear into
                     the pill's rounded ends. Negative top/bottom +
                     transform centres the gap on the boundary. */
                  width: 6,
                  background: "rgb(12, 13, 16)",
                  transform: "translateX(-3px)",
                  pointerEvents: "none",
                  zIndex: 5,
                }}
              />
            ))}
          </>,
          sliderEl
        )}

      {/* Buttons portaled into the player root so the Fullscreen API
          keeps them visible when the user toggles fullscreen. */}
      {buttonStack && playerEl && createPortal(buttonStack, playerEl)}
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
