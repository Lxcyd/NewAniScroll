import { useCallback, useEffect, useRef, useState } from "react";

import {
  PREVIEW_DEFAULT_VOLUME,
  readMuted,
  readVolume,
  writeMuted,
  writeVolume,
} from "@/lib/prefs/playerVolume";

/**
 * The trailer frame of the hover preview — descended from Hayase's
 * `ui/cards/YoutubeIframe.svelte`, with our own transport controls.
 *
 * Everything here is driven by the YouTube iframe API's postMessage protocol,
 * with no SDK script loaded. The undocumented part is the handshake: you must
 * post `{"event":"listening",...}` INTO the frame before it sends anything back,
 * and the frame isn't listening the moment `load` fires — hence the 100 ms
 * interval that keeps asking until the first message arrives.
 *
 * The messages we act on:
 *   - `onReady`         → set the volume.
 *   - `initialDelivery` → if `videoData.isPlayable` is false the video is
 *                         region-locked or embed-disabled; tell the parent to
 *                         drop us and keep the banner.
 *   - `infoDelivery`    → the running state feed. `playerState` 1 (playing)
 *                         reveals the frame so we never cut from the banner to a
 *                         black loading square, 2 is paused, 0 (ended) loops.
 *                         `muted` / `volume` are echoed back here, which is what
 *                         keeps our icon honest even when YouTube overrules us.
 *
 * The loop is manual — `loop=1` needs `playlist=<id>`, and YouTube renders extra
 * chrome as soon as a playlist is set — so on ENDED we remount the iframe by
 * blanking the src for one tick.
 *
 * `pointer-events: none` on the frame is load-bearing: a cross-origin iframe
 * swallows the pointer events HoverPreviewProvider needs to know the card is
 * still hovered, so the card would close the moment the pointer entered the
 * trailer. Every control is therefore ours, in a layer above the frame.
 */

const ORIGIN = "https://www.youtube-nocookie.com";

/** Sound is ON by default; a trailer at full blast on hover is not. */
const FALLBACK_VOLUME = PREVIEW_DEFAULT_VOLUME;
/** Controls fade this long after the pointer stops moving over the video. */
const IDLE_MS = 1600;
/** Travel, in px, before a pointermove counts as the user reaching for a control. */
const MOVE_SLOP = 8;
/** No controls at all for this long after the card opens, movement or not. */
const OPEN_GRACE_MS = 350;

export default function YoutubeTrailer({
  id,
  onHide,
}: {
  id: string;
  /** true = unplayable, drop the frame; false = playing, the banner can go. */
  onHide: (hidden: boolean) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Where the pointer was when it first met the video — see `wake`. */
  const originRef = useRef<{ x: number; y: number } | null>(null);
  /** The user's standing choice; the live `muted` state can lag behind it. */
  const wantMutedRef = useRef(true);
  /** Guards the one-shot unmute, which must not re-fire on every state ping. */
  const unmutedRef = useRef(false);
  /** Read in the postMessage handler, which is bound once and would go stale. */
  const volumeRef = useRef(FALLBACK_VOLUME);
  const mountedAtRef = useRef(Date.now());
  const trackRef = useRef<HTMLDivElement>(null);
  const volCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(FALLBACK_VOLUME);
  const [volOpen, setVolOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [hidden, setHidden] = useState(true);
  const [showControls, setShowControls] = useState(false);
  // Blanked for one tick to force a remount when the video ends (manual loop).
  const [src, setSrc] = useState(id);

  const call = useCallback((func: string, args: string | null = null) => {
    frameRef.current?.contentWindow?.postMessage(
      `{"event":"command", "func":"${func}", "args":${args}}`,
      "*",
    );
  }, []);

  // Seed from the app-wide setting, not from a preview-only one: turning the
  // volume down here turns it down in the watch player too, and vice versa.
  useEffect(() => {
    const pref = readMuted();
    wantMutedRef.current = pref;
    setMuted(pref);
    const stored = readVolume();
    if (stored != null) {
      volumeRef.current = stored;
      setVolume(stored);
    }
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== ORIGIN) return;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      let json: any;
      try {
        json = JSON.parse(e.data as string);
      } catch {
        return;
      }

      if (json.event === "onReady") call("setVolume", `[${Math.round(volumeRef.current * 100)}]`);

      if (json.event === "initialDelivery" && json.info?.videoData?.isPlayable === false) {
        onHide(true);
      }

      if (json.event === "infoDelivery") {
        const info = json.info ?? {};

        if (info.playerState === 1) {
          setHidden(false);
          setPlaying(true);
          onHide(false);
          // The frame always LOADS muted — that is the only way Chrome lets it
          // autoplay at all. Sound is restored here instead, once playback is
          // under way, because unmuting a video that is already running is
          // allowed where starting an audible one is not.
          if (!wantMutedRef.current && !unmutedRef.current) {
            unmutedRef.current = true;
            call("unMute");
            call("setVolume", `[${Math.round(volumeRef.current * 100)}]`);
          }
        } else if (info.playerState === 2) {
          setPlaying(false);
        } else if (info.playerState === 0) {
          setPlaying(false);
          setSrc("");
          setTimeout(() => setSrc(id), 0);
        }

        // YouTube echoes the real mute state back; trust it over our intent, so
        // a browser that refuses the unmute doesn't leave a lying icon.
        if (typeof info.muted === "boolean") setMuted(info.muted);
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      if (pollRef.current) clearInterval(pollRef.current);
      if (idleRef.current) clearTimeout(idleRef.current);
      if (volCloseRef.current) clearTimeout(volCloseRef.current);
    };
  }, [id, onHide, call]);

  const initFrame = () => {
    const ping = () =>
      frameRef.current?.contentWindow?.postMessage(
        '{"event":"listening","id":1,"channel":"widget"}',
        "*",
      );
    ping();
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(ping, 100);
  };

  const stop = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const applyMuted = (next: boolean) => {
    wantMutedRef.current = next;
    unmutedRef.current = true;
    writeMuted(next);
    setMuted(next);
    call(next ? "mute" : "unMute");
  };

  const toggleMute = (e: React.MouseEvent) => {
    stop(e);
    const next = !muted;
    applyMuted(next);
    // Un-muting a slider that sits at zero would look broken: give it something
    // to be un-muted TO.
    if (!next && volumeRef.current <= 0) applyVolume(FALLBACK_VOLUME);
    else if (!next) call("setVolume", `[${Math.round(volumeRef.current * 100)}]`);
  };

  /**
   * The volume is the app's, not the preview's: same localStorage keys as the
   * watch player (lib/prefs/playerVolume), so a level set on a trailer is the
   * level the next episode starts at.
   */
  const applyVolume = (raw: number) => {
    const v = Math.min(1, Math.max(0, raw));
    volumeRef.current = v;
    setVolume(v);
    writeVolume(v);
    call("setVolume", `[${Math.round(v * 100)}]`);
    // Dragging to the bottom IS muting, and dragging back up IS unmuting —
    // a slider at zero next to an unmuted icon is a lie.
    if (v === 0 && !muted) applyMuted(true);
    if (v > 0 && muted) applyMuted(false);
  };

  const volumeFromEvent = (e: React.PointerEvent) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    // The bar fills upward, so the TOP of the track is 100 %.
    applyVolume(1 - (e.clientY - rect.top) / rect.height);
  };

  const onTrackDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    volumeFromEvent(e);
  };

  const onTrackMove = (e: React.PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
    volumeFromEvent(e);
  };

  const openVolume = () => {
    if (volCloseRef.current) clearTimeout(volCloseRef.current);
    setVolOpen(true);
  };

  // A small grace on the way out: the pointer crosses a gap between the button
  // and the track, and a slider that vanishes mid-reach is unusable.
  const closeVolume = () => {
    if (volCloseRef.current) clearTimeout(volCloseRef.current);
    volCloseRef.current = setTimeout(() => setVolOpen(false), 260);
  };

  const togglePlay = (e: React.MouseEvent) => {
    stop(e);
    call(playing ? "pauseVideo" : "playVideo");
    setPlaying(!playing);
  };

  // Controls are invisible until the pointer actually moves over the video, and
  // fade again once it settles — the trailer is the content, not the chrome.
  //
  // "Actually moves" is the whole difficulty. The card opens UNDER the pointer,
  // so the browser fires a pointermove against it immediately even though the
  // hand never moved: the card came to the cursor, not the reverse. Taking that
  // first event at face value is what put the pause button on screen the moment
  // the trailer started. So the first move only records a baseline, and nothing
  // shows until the pointer has travelled past MOVE_SLOP from it.
  const wake = (e: React.PointerEvent) => {
    // Belt and braces on top of the baseline: nothing at all during the opening
    // moments, whatever the browser claims about the pointer.
    if (Date.now() - mountedAtRef.current < OPEN_GRACE_MS) return;
    const origin = originRef.current;
    if (!origin) {
      originRef.current = { x: e.clientX, y: e.clientY };
      return;
    }
    if (Math.abs(e.clientX - origin.x) < MOVE_SLOP && Math.abs(e.clientY - origin.y) < MOVE_SLOP) {
      return;
    }
    setShowControls(true);
    if (idleRef.current) clearTimeout(idleRef.current);
    idleRef.current = setTimeout(() => setShowControls(false), IDLE_MS);
  };

  const sleep = () => {
    if (idleRef.current) clearTimeout(idleRef.current);
    originRef.current = null;
    setShowControls(false);
  };

  // Pause and volume share ONE rule, deliberately: two controls in the same
  // corner of the same surface that appear under different conditions read as a
  // glitch. (An earlier version kept the pause button up whenever the video was
  // paused, on the theory that it is the only way to resume. It isn't — moving
  // the pointer brings it straight back, which is the gesture that got you
  // there in the first place.)
  // `volOpen` is the one exception, and it is not really one: the slider can
  // only be open because the pointer is already on the volume button.
  const controlsVisible = !hidden && (showControls || volOpen);
  const chrome = `transition-opacity duration-200 ${
    controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
  }`;

  return (
    <div
      // No z-index on purpose: the banner's ::after gradient is a positioned
      // pseudo-element that must keep painting over the video's bottom edge, and
      // it only can while this layer stays at `z-index: auto`.
      className="absolute inset-0 overflow-hidden rounded-t-card"
      onPointerMove={wake}
      onPointerLeave={sleep}
    >
      {src && (
        <iframe
          ref={frameRef}
          // Cookie-less embed: the frame gets an opaque origin, so a trailer
          // on a poster never joins the visitor to their YouTube identity.
          {...({ credentialless: "true" } as Record<string, string>)}
          title="trailer"
          allow="autoplay"
          // h-full w-full, not `size-full`: Tailwind 3.3 here, `size-*` is 3.4+.
          className={`pointer-events-none absolute left-0 top-1/2 h-[calc(100%+200px)] w-full -translate-y-1/2 transform-gpu border-0 transition-opacity duration-300 ${
            hidden ? "opacity-0" : "opacity-100"
          }`}
          onLoad={initFrame}
          // Always mute=1 at load: an audible autoplay is refused outright, a
          // muted one is not. The unmute happens once playback is live.
          src={`${ORIGIN}/embed/${src}?autoplay=1&mute=1&controls=0&disablekb=1&cc_lang_pref=ja&rel=0&playsinline=1&fs=0&enablejsapi=1`}
        />
      )}

      {/* Scrim so the icons stay legible over a bright frame. */}
      <div
        aria-hidden
        className={`absolute inset-0 bg-gradient-to-b from-black/45 via-transparent to-transparent ${chrome}`}
      />

      <button
        type="button"
        onClick={togglePlay}
        aria-label={playing ? "Pause" : "Play"}
        className={`absolute left-1/2 top-1/2 grid h-11 w-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70 ${chrome}`}
      >
        {playing ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>

      {/* Volume: the button, and the track that drops out of it on hover. Both
          live in one wrapper so the pointer can travel from one to the other
          without the group ever being "left". */}
      <div
        className={`absolute right-1.5 top-1.5 flex flex-col items-center ${chrome}`}
        onPointerEnter={openVolume}
        onPointerLeave={closeVolume}
      >
      <button
        type="button"
        onClick={toggleMute}
        aria-label={muted ? "Unmute" : "Mute"}
        className="grid h-8 w-8 place-items-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70"
      >
        {muted ? (
          // lucide volume-x
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="pointer-events-none"
          >
            <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />
            <line x1="22" x2="16" y1="9" y2="15" fill="none" />
            <line x1="16" x2="22" y1="9" y2="15" fill="none" />
          </svg>
        ) : (
          // lucide volume-2
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="pointer-events-none"
          >
            <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />
            <path d="M16 9a5 5 0 0 1 0 6" fill="none" />
            <path d="M19.364 18.364a9 9 0 0 0 0-12.728" fill="none" />
          </svg>
        )}
      </button>

        <div
          className={`mt-1 flex justify-center rounded-full bg-black/50 px-1.5 py-2 transition-opacity duration-150 ${
            volOpen ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          <div
            ref={trackRef}
            role="slider"
            aria-label="Volume"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((muted ? 0 : volume) * 100)}
            tabIndex={0}
            onPointerDown={onTrackDown}
            onPointerMove={onTrackMove}
            // A 5 px bar is a 5 px target: the padding above widens the hit area
            // without widening the bar.
            className="relative h-20 w-[5px] cursor-pointer rounded-full bg-white/25"
          >
            <div
              className="absolute bottom-0 left-0 w-full rounded-full bg-white"
              style={{ height: `${(muted ? 0 : volume) * 100}%` }}
            />
            <div
              className="pointer-events-none absolute left-1/2 h-2.5 w-2.5 -translate-x-1/2 translate-y-1/2 rounded-full bg-white shadow"
              style={{ bottom: `${(muted ? 0 : volume) * 100}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
