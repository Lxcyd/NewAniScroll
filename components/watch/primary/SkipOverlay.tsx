import {
  type MediaPlayerInstance,
  useMediaState,
} from "@vidstack/react";
import { useWatchProvider } from "@/lib/context/watchPageProvider";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/router";
// Skip prefetch + shared cache live in a Vidstack-free module so the watch
// page can warm the cache without pulling this (dynamic) chunk into its
// bundle. We reuse the same SKIP_MEMO here so a page-level prefetch is a
// synchronous hit on remount.
import { SKIP_MEMO, skipMemoKey, prefetchSkips } from "@/lib/skip/prefetchSkips";

const SEGMENT_LABEL: Record<string, string> = {
  op: "Skip Intro",
  ed: "Skip Outro",
};

const NEXT_EP_TAIL_SECONDS = 30;
const SKIP_PRELOAD_LEAD_MS = 250;
// Mirror the chapter-VTT edge snap so the Skip button jumps all
// the way to the real episode boundary when the segment ends
// within 5 s of it (avoids leaving a sliver of "Episode" too thin
// to be useful). Long trailing tails (preview, next-ep promo)
// get a dedicated pill instead via the chapter VTT.
const EDGE_SNAP_START_SECONDS = 5;
const EDGE_SNAP_END_SECONDS = 5;

/* Sanity filters: ed segments that start in the first 3 s are bogus
   recap markers (real outros never do that), and any segment shorter
   than 5 s is a sub-frame marker that pollutes the chrome without
   being worth skipping. */
const MIN_SEGMENT_DURATION = 5;
const MIN_OUTRO_START = 3;

type Skip = { start: number; end: number; type: string };

/* Module-level cache so changing servers (which remounts the player and
   therefore SkipOverlay) doesn't trigger a brand-new network request for
   the same skip data. The browser HTTP cache would also catch it via the
   24 h Cache-Control on /api/v2/skip, but a cache hit still costs a
   round-trip through Service Worker + fetch pipeline; the in-memory Map
   skips that entirely. Key is `${malId}:${episode}` — sub/dub doesn't
   change the underlying op/ed timestamps. */

type Props = {
  playerRef: React.RefObject<MediaPlayerInstance>;
  /** MAL id of the anime. Required for AniSkip; overlay is a no-op
   *  when this is missing. */
  malId?: number | null;
  /** AniList id — preferred source. Our proxy uses it to look up
   *  the matching Anime-Skip showId (much more accurate data when
   *  the show is covered there). Falls back to AniSkip when null
   *  or when Anime-Skip has no entry. */
  aniListId?: number | null;
  /** 1-based episode number. */
  episode?: number;
  /** Pre-computed URL for the next episode. */
  nextEpisodeHref?: string | null;
  /** Set to true when a non-Vidstack popover (subtitle picker, etc.)
   *  is open inside the player — same hide behaviour as Vidstack's
   *  native menus. */
  externalMenuOpen?: boolean;
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
  aniListId,
  episode,
  nextEpisodeHref,
  externalMenuOpen = false,
}: Props) {
  const router = useRouter();
  const currentTime = useMediaState("currentTime", playerRef);
  const duration = useMediaState("duration", playerRef);
  const watchCtx = useWatchProvider();

  /* Locally cache the AniSkip response so we can also push it into
     watchCtx.skipTimes (other components — currently none, but the
     contract from the previous iteration — may listen for it). */
  const [skips, setSkips] = useState<Skip[]>([]);
  /* Raw API response, kept separate from `skips` so we can fire the
     network request as soon as malId/episode are known (in parallel
     with the video metadata load) and only run the duration-dependent
     clamp/filter when the player reports its real duration. Previously
     the fetch waited for duration > 0, which added 2–3 s of perceived
     lag between "video starts" and "chapter pills appear". */
  const [rawSkips, setRawSkips] = useState<Skip[]>([]);

  // Fire the skip fetch the moment malId/episode are known — runs in
  // parallel with the video loading its metadata. A module-level memo
  // returns immediately on remount (server change) without any network.
  useEffect(() => {
    setSkips([]);
    setRawSkips([]);
    watchCtx?.setSkipTimes?.([]);
    if (!malId || !episode) return;
    const memoKey = skipMemoKey(malId, episode);
    const memoed = SKIP_MEMO.get(memoKey);
    if (memoed) {
      setRawSkips(memoed);
      return;
    }
    let cancelled = false;
    (async () => {
      // Shared with the watch page's eager prefetch: if it already ran (or is
      // in flight) for this episode, this resolves from the memo / the same
      // request instead of issuing a second one.
      const arr = await prefetchSkips(malId, episode, aniListId);
      if (!cancelled) setRawSkips(arr);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [malId, aniListId, episode]);

  // Clamp/filter against the real duration once the player reports it.
  // Cheap CPU work — runs in microseconds, so the chapter pills appear
  // the same tick `duration` lands.
  useEffect(() => {
    if (duration <= 0 || !rawSkips.length) {
      setSkips([]);
      watchCtx?.setSkipTimes?.([]);
      return;
    }
    // Clamp every segment to the player's real duration — any
    // timestamp past the end visually misaligns the chapter pills.
    const clamped = rawSkips
      .map((s) => ({ ...s, end: Math.min(s.end, duration) }))
      .filter(
        (s) =>
          s.end > s.start &&
          s.end - s.start >= MIN_SEGMENT_DURATION &&
          !(s.type === "ed" && s.start < MIN_OUTRO_START),
      );
    // Sanity: an outro starting BEFORE the intro is junk (mis-tagged
    // recap, swapped op/ed) — drop it rather than poison the seek bar.
    //
    // Exception for late-intro episodes: shows like Demon Slayer ep 1
    // intentionally delay the OP to the 21-minute mark, with the ED
    // following immediately after (overlap by a few seconds is common
    // in the upstream data because the points are sub-second precise).
    // When the intro lands past LATE_INTRO_THRESHOLD we treat it as an
    // atypical episode and trust the ED data instead of dropping it.
    const LATE_INTRO_THRESHOLD = 5 * 60; // 5 min
    const intro = clamped.find((s) => s.type === "op");
    const introIsLate = !!intro && intro.start >= LATE_INTRO_THRESHOLD;
    const filtered = intro && !introIsLate
      ? clamped.filter((s) => s.type !== "ed" || s.start >= intro.end)
      : clamped;
    const sorted = [...filtered].sort((a, b) => a.start - b.start);
    // Snap to episode edges so Skip jumps all the way to 0 / duration
    // when the segment sits within EDGE_SNAP_SECONDS of the boundary.
    if (sorted.length) {
      const first = sorted[0];
      if (first.start > 0 && first.start <= EDGE_SNAP_START_SECONDS) {
        first.start = 0;
      }
      const last = sorted[sorted.length - 1];
      if (
        last.end < duration &&
        duration - last.end <= EDGE_SNAP_END_SECONDS
      ) {
        last.end = duration;
      }
    }
    setSkips(sorted);
    watchCtx?.setSkipTimes?.(sorted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawSkips, duration]);

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

  /* Track whether Vidstack's control bar is currently visible.
     Vidstack exposes this as `useMediaState("controlsVisible")`
     which fires re-renders whenever the auto-hide timer flips it.
     When the bar is hidden the buttons drop to the very bottom of
     the player frame; when it's visible they sit above it. */
  const controlsVisible = useMediaState("controlsVisible", playerRef);

  /* Hide the Skip / Next buttons whenever a player menu (chapters,
     settings, captions, …) is open — they cover the bottom-right
     of the chrome and overlap the menu visually. Vidstack flips
     `aria-hidden="false"` on `.vds-menu-items` when a menu opens,
     so a MutationObserver on the player root catches all of them
     without us having to enumerate menu types. */
  const [menuOpen, setMenuOpen] = useState(false);
  /* Hide the Skip / Next buttons while the user is hovering the
     time slider — Vidstack's chapter hover-preview tooltip pops
     up right where these buttons sit and the overlap looks messy.
     Attached on the slider itself (not the bottom band of the
     player) so the buttons stay visible when the cursor is over
     the controls but NOT on the seek bar. */
  const [scrubbing, setScrubbing] = useState(false);
  useEffect(() => {
    const el = playerEl;
    if (!el) return;
    let slider: Element | null = null;
    let attached = false;
    const onEnter = () => setScrubbing(true);
    const onLeave = () => setScrubbing(false);
    const attach = () => {
      const found = el.querySelector(".vds-time-slider");
      if (!found || found === slider) return;
      if (slider && attached) {
        slider.removeEventListener("pointerenter", onEnter);
        slider.removeEventListener("pointerleave", onLeave);
      }
      slider = found;
      slider.addEventListener("pointerenter", onEnter);
      slider.addEventListener("pointerleave", onLeave);
      attached = true;
    };
    attach();
    // Vidstack may swap the slider node out (e.g. when the chapters
    // VTT loads), so keep watching the DOM and re-attach on change.
    const mo = new MutationObserver(attach);
    mo.observe(el, { subtree: true, childList: true });
    return () => {
      mo.disconnect();
      if (slider && attached) {
        slider.removeEventListener("pointerenter", onEnter);
        slider.removeEventListener("pointerleave", onLeave);
      }
    };
  }, [playerEl]);
  useEffect(() => {
    const el = playerEl;
    if (!el) return;
    const check = () => {
      const open = !!el.querySelector(
        '.vds-menu-items[aria-hidden="false"]',
      );
      setMenuOpen(open);
    };
    check();
    const mo = new MutationObserver(check);
    mo.observe(el, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-hidden"],
      childList: true,
    });
    return () => mo.disconnect();
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

  const buttonStack = active || showNext ? (
    <div
      style={{
        position: "absolute",
        right: 24,
        /* Sit ABOVE the Vidstack control row when controls are
           visible (92 px clears the time slider + button row),
           drop to the bottom edge with a small inset when
           controls auto-hide. Transition matches Vidstack's own
           controls fade so the buttons feel locked to the chrome.
           Opacity drops to 0 while the user is hovering the seek
           bar — the chapter hover-preview tooltip pops up over
           these buttons and the overlap reads as ugly. */
        bottom: controlsVisible ? 92 : 24,
        zIndex: 30,
        display: "flex",
        gap: 10,
        pointerEvents:
          menuOpen || externalMenuOpen || scrubbing ? "none" : "auto",
        opacity: menuOpen || externalMenuOpen || scrubbing ? 0 : 1,
        transition: "bottom 200ms ease, opacity 150ms ease",
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
              stroke="currentColor"
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
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  ) : null;

  /* Chapter cuts in the bar are no longer drawn here — they come
     from Vidstack's native <Track kind="chapters"> system, fed by a
     dynamically-generated WebVTT in UniversalPlayer (see
     `buildChaptersVtt` there). Vidstack splits the seek bar into
     `vds-slider-chapter` divs that globals.css rounds into
     individual pills, exactly matching the Miruro reference.

     This component now only owns the floating Skip / Next Episode
     buttons. */
  return (
    <>{buttonStack && playerEl && createPortal(buttonStack, playerEl)}</>
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
  transition:
    "color 150ms ease, background 150ms ease, transform 150ms ease, box-shadow 150ms ease",
};
