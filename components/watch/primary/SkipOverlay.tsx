import {
  type MediaPlayerInstance,
  useMediaState,
} from "@vidstack/react";
import { useWatchProvider } from "@/lib/context/watchPageProvider";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePlayerPrefs } from "@/lib/prefs/playerPrefs";
import { createPortal } from "react-dom";
import { useRouter } from "next/router";
// Skip prefetch + shared cache live in a Vidstack-free module so the watch
// page can warm the cache without pulling this (dynamic) chunk into its
// bundle. We reuse the same SKIP_MEMO here so a page-level prefetch is a
// synchronous hit on remount.
import { SKIP_MEMO, skipMemoKey, prefetchSkips } from "@/lib/skip/prefetchSkips";
import { useTranslation } from "react-i18next";

const SEGMENT_LABEL_KEY: Record<string, string> = {
  op: "player.skipIntro",
  ed: "player.skipOutro",
};

const NEXT_EP_TAIL_SECONDS = 30;
// Rate-popup trigger on the final episode. We want it ~88% through a normal
// ~24min episode (the last ~12% is almost always ED + next-ep preview), but a
// flat fraction misfires on long runtimes: 88% of a 2h film is 14min early.
// So we take the LATER of {88%, duration - RATE_PROMPT_MAX_LEAD} — capping how
// far before the end it can ever appear. For a 24min ep both land ~88%; for a
// film the cap wins (~3min before the end instead of 14).
const RATE_PROMPT_FRACTION = 0.88;
const RATE_PROMPT_MAX_LEAD_SECONDS = 180;
// Single-episode works (films / OVAs): prompt only at the very end (95%).
const RATE_PROMPT_SINGLE_FRACTION = 0.95;
// Preload the next episode's route a short lead BEFORE the Next button appears,
// so the route + player chunk are already cached by the time the button shows
// and the user clicks. Relative to the button's own appearance window
// (NEXT_EP_TAIL_SECONDS), not an absolute time from the end — so it scales to
// short episodes too. Route-level prefetch only (no source extraction), so it
// costs no worker calls.
const NEXT_EP_PRELOAD_LEAD_SECONDS = 10;
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
  /** True when this is the final episode of the anime. */
  isFinalEpisode?: boolean;
  /** True when the anime is a single-episode work (film / OVA). The rate popup
   *  waits until the very end (95%) for these — no ED/preview tail to skip. */
  isSingleEpisode?: boolean;
  /** Fired once a few seconds before the final episode ends (rate popup). */
  onFinalEpisodeNearEnd?: () => void;
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
  isFinalEpisode = false,
  isSingleEpisode = false,
  onFinalEpisodeNearEnd,
}: Props) {
  const { t } = useTranslation();
  const router = useRouter();
  const currentTime = useMediaState("currentTime", playerRef);
  const duration = useMediaState("duration", playerRef);
  const watchCtx = useWatchProvider();
  const playerPrefs = usePlayerPrefs();

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

  // Preload the next episode's route a short lead BEFORE the Next button
  // appears, so clicking it paints the next page instantly (no cold
  // route/chunk fetch). The button shows at the outro or within
  // NEXT_EP_TAIL_SECONDS of the end; we start the preload
  // NEXT_EP_PRELOAD_LEAD_SECONDS earlier than that. Route prefetch only —
  // deliberately no source pre-extraction, so it spends zero worker calls on
  // an episode the user might not advance to.
  const shouldPreloadNext =
    !!nextEpisodeHref &&
    (isInOutro ||
      (duration > 0 &&
        currentTime >=
          duration - (NEXT_EP_TAIL_SECONDS + NEXT_EP_PRELOAD_LEAD_SECONDS)));
  useEffect(() => {
    if (!shouldPreloadNext || !nextEpisodeHref) return;
    try {
      router.prefetch(nextEpisodeHref);
    } catch {
      /* prefetch unsupported — the click still works, just not warmed */
    }
    // Warm the player chunk too (idempotent dynamic import).
    void import("@/components/watch/primary/UniversalPlayer").catch(() => {});
  }, [shouldPreloadNext, nextEpisodeHref, router]);

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
    let target = Math.max(0, endSeconds - SKIP_PRELOAD_LEAD_MS / 1000);
    // Clamp so we never seek to or past the very end. AniSkip's outro `end` can
    // exceed the actual video length (especially on megaplay, whose encode is a
    // few seconds shorter than the source AniSkip was timed against) — seeking
    // to >= duration makes the browser fire `ended`, which on some servers
    // wraps the playhead back to 0 ("skip outro sent me to the start"). Staying
    // ~1s inside the video avoids that entirely.
    if (duration > 0) {
      target = Math.min(target, duration - 1);
      if (target < 0) target = 0;
    }
    player.currentTime = target;
    try {
      player.play?.();
    } catch {
      /* programmatic play rejection on browsers that block it — harmless */
    }
  };

  const goToNextEpisode = () => {
    if (!nextEpisodeHref) return;
    // Leave fullscreen FIRST. Otherwise the new page loads underneath the
    // fullscreen video element and the user just sees the current frame frozen
    // — it looks like the button did nothing. Exiting fullscreen makes the
    // navigation (and its loading state) visible. Best-effort on every API:
    // Vidstack's player, then the raw DOM Fullscreen API.
    try {
      const p: any = playerRef?.current;
      if (p?.exitFullscreen) {
        // Vidstack returns a promise; navigate regardless of its outcome.
        Promise.resolve(p.exitFullscreen()).catch(() => {});
      } else if (typeof document !== "undefined" && document.fullscreenElement) {
        document.exitFullscreen?.();
      }
    } catch {
      /* fullscreen exit unsupported / rejected — navigate anyway */
    }
    router.push(nextEpisodeHref);
  };

  /* ── Auto-skip intro/outro ───────────────────────────────────────
     When the matching pref is on we jump past a segment the moment it
     becomes active — same destination as clicking its Skip button.

     Crucially we record each segment we auto-skipped (by a stable
     start-end-type key) so that if the user manually seeks BACK into
     it we don't fight them by skipping again — they clearly wanted to
     watch it. The record is per-episode: it resets whenever the skips
     array changes (new episode / server). */
  const autoSkippedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // New episode / refreshed segments → forget what we auto-skipped.
    autoSkippedRef.current = new Set();
  }, [skips]);
  useEffect(() => {
    if (!active) return;
    const wantSkip =
      (active.type === "op" && playerPrefs.autoSkipIntro) ||
      (active.type === "ed" && playerPrefs.autoSkipOutro);
    if (!wantSkip) return;
    const key = `${active.type}:${active.start}-${active.end}`;
    if (autoSkippedRef.current.has(key)) return; // already auto-skipped once
    autoSkippedRef.current.add(key);
    skipTo(active.end);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, playerPrefs.autoSkipIntro, playerPrefs.autoSkipOutro]);

  /* ── Auto next episode ───────────────────────────────────────────
     When enabled, advance as soon as the "Next Episode" button would
     appear (the outro starts, or we're within NEXT_EP_TAIL_SECONDS of the
     end) — i.e. exactly when `showNext` flips true. Guard with a ref so it
     fires once. Reset per-episode via nextEpisodeHref. */
  const autoAdvancedRef = useRef(false);
  useEffect(() => {
    autoAdvancedRef.current = false;
  }, [nextEpisodeHref]);
  useEffect(() => {
    if (!playerPrefs.autoNextEpisode || !nextEpisodeHref) return;
    if (autoAdvancedRef.current) return;
    if (showNext) {
      autoAdvancedRef.current = true;
      goToNextEpisode();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showNext, playerPrefs.autoNextEpisode, nextEpisodeHref]);

  /* ── Rate popup on the final episode ─────────────────────────────
     Surface the rate popup once the viewer is ~88% through the last episode
     — late enough that they've effectively finished the story (the tail is
     almost always the ED + next-episode preview), early enough to still be
     watching when it pops. A % threshold (not a fixed lead) adapts to both
     ~24min TV episodes and longer specials/films. Fires once per episode. */
  const ratePromptedRef = useRef(false);
  useEffect(() => {
    ratePromptedRef.current = false;
  }, [episode]);
  useEffect(() => {
    if (!isFinalEpisode || !onFinalEpisodeNearEnd) return;
    if (ratePromptedRef.current) return;
    if (duration <= 0) return;
    // Single-episode works (films / OVAs) have no ED + next-ep tail to skip, so
    // we wait until the very end (95%) to avoid prompting mid-climax. Series
    // get the earlier-but-capped trigger: later of {88%, duration - 3min}.
    const threshold = isSingleEpisode
      ? duration * RATE_PROMPT_SINGLE_FRACTION
      : Math.max(
          duration * RATE_PROMPT_FRACTION,
          duration - RATE_PROMPT_MAX_LEAD_SECONDS,
        );
    if (currentTime >= threshold) {
      ratePromptedRef.current = true;
      onFinalEpisodeNearEnd();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime, duration, isFinalEpisode, isSingleEpisode, onFinalEpisodeNearEnd]);

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
      {active && SEGMENT_LABEL_KEY[active.type] && (
        <button
          type="button"
          onClick={() => skipTo(active.end)}
          className="aniscroll-skip-btn"
          style={btnStyle}
        >
          {t(SEGMENT_LABEL_KEY[active.type])}
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
          {t("player.nextEpisodeBtn")}
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
