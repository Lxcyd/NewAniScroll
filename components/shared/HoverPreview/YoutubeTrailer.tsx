import { useCallback, useEffect, useRef, useState } from "react";

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

/** Remembered across hovers, so muting once mutes for the whole session. */
const MUTE_KEY = "aniscroll.preview.muted";
/** Sound is ON by default; a trailer at full blast on hover is not. */
const DEFAULT_VOLUME = 40;
/** Controls fade this long after the pointer stops moving over the video. */
const IDLE_MS = 1600;
/** Travel, in px, before a pointermove counts as the user reaching for a control. */
const MOVE_SLOP = 6;

function readMutedPref(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeMutedPref(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    /* private mode — the in-memory state still holds for this page */
  }
}

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

  const [muted, setMuted] = useState(true);
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

  useEffect(() => {
    const pref = readMutedPref();
    wantMutedRef.current = pref;
    setMuted(pref);
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

      if (json.event === "onReady") call("setVolume", `[${DEFAULT_VOLUME}]`);

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
            call("setVolume", `[${DEFAULT_VOLUME}]`);
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

  const toggleMute = (e: React.MouseEvent) => {
    stop(e);
    const next = !muted;
    wantMutedRef.current = next;
    unmutedRef.current = true;
    writeMutedPref(next);
    setMuted(next);
    call(next ? "mute" : "unMute");
    if (!next) call("setVolume", `[${DEFAULT_VOLUME}]`);
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
  const controlsVisible = !hidden && showControls;
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
        className={`absolute left-1/2 top-1/2 grid h-11 w-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-colors hover:bg-black/65 ${chrome}`}
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

      <button
        type="button"
        onClick={toggleMute}
        aria-label={muted ? "Unmute" : "Mute"}
        className={`absolute right-1.5 top-1.5 grid h-8 w-8 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-colors hover:bg-black/65 ${chrome}`}
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
    </div>
  );
}
