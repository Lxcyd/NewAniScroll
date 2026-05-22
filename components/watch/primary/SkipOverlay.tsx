import {
  type MediaPlayerInstance,
  useMediaState,
} from "@vidstack/react";
import { useWatchProvider } from "@/lib/context/watchPageProvider";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

/* Skip type → colour. Picked to be distinct from Vidstack's red brand
   accent so the segments don't melt into the played-progress fill. */
const SEGMENT_COLOR: Record<string, string> = {
  op: "rgba(74, 143, 255, 0.85)",     // blue
  ed: "rgba(45, 212, 122, 0.85)",     // green
  recap: "rgba(176, 124, 255, 0.85)", // purple
};
const SEGMENT_LABEL: Record<string, string> = {
  op: "Skip Intro",
  ed: "Skip Outro",
  recap: "Skip Recap",
};

type Props = {
  playerRef: React.RefObject<MediaPlayerInstance>;
};

/**
 * Visual overlay for AniSkip op/ed/recap intervals.
 *
 * Two responsibilities:
 *
 *   1. **Seek-bar segments.** Vidstack's DefaultVideoLayout doesn't expose
 *      a slot for chapter markers, so we paint absolute-positioned coloured
 *      divs directly inside Vidstack's `.vds-time-slider` element via a
 *      DOM portal. They sit BEHIND the played-fill so the user still sees
 *      progress on top.
 *
 *   2. **Skip button.** When `currentTime` is inside a segment we surface
 *      a button bottom-right of the player. Clicking it jumps the player
 *      to the segment's end (-0.5s safety margin so we don't immediately
 *      re-enter the segment).
 *
 * The component returns null when no skip data exists for the current
 * episode — keeps the player chrome unchanged for series AniSkip
 * doesn't cover.
 */
export default function SkipOverlay({ playerRef }: Props) {
  const { skipTimes } = useWatchProvider();
  const currentTime = useMediaState("currentTime", playerRef);
  const duration = useMediaState("duration", playerRef);

  /* Active segment = the one (if any) whose [start, end] window contains
     currentTime. Recomputed on every tick — cheap (≤3 entries). */
  const active = useMemo(() => {
    if (!Array.isArray(skipTimes) || skipTimes.length === 0) return null;
    for (const s of skipTimes) {
      if (currentTime >= s.start && currentTime < s.end) return s;
    }
    return null;
  }, [skipTimes, currentTime]);

  /* Portal target = Vidstack's time-slider track element. Vidstack mounts
     it lazily after the player is ready, so we poll with rAF until found,
     then keep the reference in state so the portal re-runs against it.
     Reset on episode change (new skip data) in case Vidstack remounts the
     slider — happens e.g. when the source `src` changes. */
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

  if (!skipTimes?.length) return null;

  return (
    <>
      {/* Segment overlay portal — only renders once we've found the slider
          element. Each segment is a coloured stripe positioned by % of
          duration. pointer-events: none so the user can still drag the
          slider through them. */}
      {sliderEl && duration > 0 &&
        createPortal(
          <>
            {skipTimes.map((s, i) => {
              const left = Math.max(0, (s.start / duration) * 100);
              const width = Math.max(
                0,
                ((s.end - s.start) / duration) * 100
              );
              return (
                <div
                  key={`${s.type}-${i}`}
                  className="aniscroll-skip-seg"
                  style={{
                    position: "absolute",
                    left: `${left}%`,
                    width: `${width}%`,
                    top: 0,
                    bottom: 0,
                    background: SEGMENT_COLOR[s.type] || "rgba(255,255,255,0.4)",
                    pointerEvents: "none",
                    /* Sit BEHIND the played-progress fill (which Vidstack
                       renders at z-index >= 1 inside the same track). */
                    zIndex: 0,
                    borderRadius: 1,
                  }}
                  title={SEGMENT_LABEL[s.type] || s.type}
                />
              );
            })}
          </>,
          sliderEl
        )}

      {/* Skip button — bottom-right of the player frame. Visible only when
          currentTime falls in a segment. Positioned slightly above the
          control bar so it doesn't collide with Vidstack's bottom chrome. */}
      {active && (
        <button
          type="button"
          onClick={() => {
            const player = playerRef.current;
            if (!player) return;
            // -0.5s safety: jumping exactly to `end` can land us back in
            // the segment due to rounding + the next AniSkip entry
            // sometimes starting one frame earlier.
            player.currentTime = Math.max(0, active.end - 0.5);
          }}
          className="aniscroll-skip-btn"
          style={{
            position: "absolute",
            right: 24,
            bottom: 92,
            zIndex: 30,
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
          }}
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
    </>
  );
}
