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

const NEXT_EP_TAIL_SECONDS = 30;
const SKIP_PRELOAD_LEAD_MS = 250;

/* Sanity filters: ed segments that start in the first 3 s are bogus
   recap markers (real outros never do that), and any segment shorter
   than 5 s is a sub-frame marker that pollutes the chrome without
   being worth skipping. */
const MIN_SEGMENT_DURATION = 5;
const MIN_OUTRO_START = 3;

type Skip = { start: number; end: number; type: string };

type Props = {
  playerRef: React.RefObject<MediaPlayerInstance>;
  /** AniList -> MAL id (passed through from the watch page). Null
   *  when MAL has no entry for the anime. */
  malId?: number | null;
  /** 1-based episode number. */
  episode?: number;
  /** Pre-computed URL for the next episode. */
  nextEpisodeHref?: string | null;
};

/**
 * AniSkip overlay — chapter gaps in the seek bar + Skip + Next buttons.
 *
 * The component owns the AniSkip fetch (rather than the watch page)
 * so we can wait until the real video `duration` is known and pass
 * it as `episodeLength` to the API. With that hint AniSkip's server
 * already filters out submissions that were timed against a
 * different rip — no need to drop `mixed-*` or rescale by hand on
 * the client.
 *
 * Anything left over still gets a light sanity pass (MIN_OUTRO_START,
 * MIN_SEGMENT_DURATION) because individual submissions can still
 * disagree with each other on small details.
 */
export default function SkipOverlay({
  playerRef,
  malId,
  episode,
  nextEpisodeHref,
}: Props) {
  const router = useRouter();
  const currentTime = useMediaState("currentTime", playerRef);
  const duration = useMediaState("duration", playerRef);
  const watchCtx = useWatchProvider();

  /* Locally cache the AniSkip response so we can also push it into
     watchCtx.skipTimes (other components — currently none, but the
     contract from the previous iteration — may listen for it). */
  const [skips, setSkips] = useState<Skip[]>([]);

  useEffect(() => {
    setSkips([]);
    watchCtx?.setSkipTimes?.([]);
    if (!malId || !episode) return;
    if (duration <= 0) return; // wait for metadata to land
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams();
        ["op", "ed", "recap", "mixed-op", "mixed-ed"].forEach((t) =>
          params.append("types[]", t)
        );
        params.set("episodeLength", String(Math.round(duration)));
        const res = await fetch(
          `https://api.aniskip.com/v2/skip-times/${malId}/${episode}?${params.toString()}`
        );
        if (!res.ok || cancelled) return;
        const json = await res.json();
        const KEEP = new Set(["op", "ed", "recap"]);
        const parsed: Skip[] = (json?.results || [])
          .filter((r: any) => KEEP.has(r?.skipType) && r?.interval)
          .map((r: any) => ({
            start: Math.round(r.interval.startTime),
            end: Math.round(r.interval.endTime),
            type: r.skipType,
          }))
          .filter(
            (s: Skip) =>
              s.end > s.start &&
              s.end - s.start >= MIN_SEGMENT_DURATION &&
              !(s.type === "ed" && s.start < MIN_OUTRO_START) &&
              s.end <= duration
          );
        if (!cancelled) {
          setSkips(parsed);
          watchCtx?.setSkipTimes?.(parsed);
        }
      } catch {
        /* network errors silently leave the seek bar bare */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [malId, episode, duration]);

  /* Active segment = the one (if any) whose [start, end] window
     contains currentTime. */
  const active = useMemo(() => {
    if (duration <= 0) return null;
    for (const s of skips) {
      if (currentTime >= s.start && currentTime < s.end) return s;
    }
    return null;
  }, [skips, currentTime, duration]);

  const isInOutro = active?.type === "ed";
  const isNearEnd =
    duration > 0 && currentTime >= duration - NEXT_EP_TAIL_SECONDS;
  const showNext = (isInOutro || isNearEnd) && !!nextEpisodeHref;

  /* Slider portal target — Vidstack's track inside the time slider. */
  const [sliderEl, setSliderEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSliderEl(null);
    if (!skips.length) return;
    let cancelled = false;
    let raf = 0;
    const find = () => {
      if (cancelled) return;
      const el = playerRef.current?.el?.querySelector(
        ".vds-time-slider .vds-slider-track"
      ) as HTMLElement | null;
      if (el) {
        setSliderEl(el);
        return;
      }
      raf = requestAnimationFrame(find);
    };
    find();
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [skips, playerRef]);

  /* Player root portal target — for the floating buttons. Must be
     inside the element the Fullscreen API hands off, otherwise the
     buttons vanish in native fullscreen mode. */
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

  /* Track whether Vidstack's control bar is currently visible. The
     library auto-hides controls after ~2 s of pointer inactivity by
     toggling `data-user-idle` on its root element. When idle, the
     controls slide off-screen and our buttons should drop down to
     sit at the very bottom of the player frame; when controls are
     visible, the buttons need to clear the time-slider + button row
     above them. A MutationObserver on the attribute keeps us in
     sync without polling. */
  const [controlsVisible, setControlsVisible] = useState(true);
  useEffect(() => {
    if (!playerEl) return;
    const read = () => {
      // data-user-idle="true" means controls are currently HIDDEN.
      // Absent attribute or "false" = visible.
      const idle = playerEl.getAttribute("data-user-idle") === "true";
      setControlsVisible(!idle);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(playerEl, {
      attributes: true,
      attributeFilter: ["data-user-idle"],
    });
    return () => observer.disconnect();
  }, [playerEl]);

  const skipTo = (endSeconds: number) => {
    const player = playerRef.current;
    if (!player) return;
    const target = Math.max(0, endSeconds - SKIP_PRELOAD_LEAD_MS / 1000);
    player.currentTime = target;
    try {
      player.play?.();
    } catch {
      /* programmatic play rejection on browsers that block it — harmless */
    }
  };

  const goToNextEpisode = () => {
    if (!nextEpisodeHref) return;
    router.push(nextEpisodeHref);
  };

  if (!skips.length && !showNext) return null;

  /* Boundary fractions for the chapter cuts. Each segment carves two
     cuts into the bar (one at start, one at end). At most 4 cuts
     total now that mixed-* are filtered server-side. */
  const boundaries: number[] = [];
  if (duration > 0) {
    for (const s of skips) {
      const a = s.start / duration;
      const b = s.end / duration;
      if (a > 0.005 && a < 0.995) boundaries.push(a);
      if (b > 0.005 && b < 0.995) boundaries.push(b);
    }
  }

  const buttonStack = active || showNext ? (
    <div
      style={{
        position: "absolute",
        right: 24,
        /* Sit ABOVE the Vidstack control row when controls are
           visible (92 px clears the time slider + button row), drop
           to the bottom edge with a small inset when controls auto-
           hide. Transition matches Vidstack's own controls fade so
           the buttons feel locked to the chrome. */
        bottom: controlsVisible ? 92 : 24,
        zIndex: 30,
        display: "flex",
        gap: 10,
        pointerEvents: "auto",
        transition: "bottom 200ms ease",
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
                  width: 3,
                  background: "rgba(0, 0, 0, 0.85)",
                  transform: "translateX(-1.5px)",
                  pointerEvents: "none",
                  zIndex: 5,
                }}
              />
            ))}
          </>,
          sliderEl
        )}

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
