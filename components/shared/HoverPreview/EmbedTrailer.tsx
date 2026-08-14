import { useCallback, useEffect, useRef, useState } from "react";
import { MdPause, MdPlayArrow, MdVolumeOff, MdVolumeUp } from "react-icons/md";

import {
  PREVIEW_DEFAULT_VOLUME,
  readMuted,
  readVolume,
  writeMuted,
  writeVolume,
} from "@/lib/prefs/previewVolume";

/**
 * The trailer frame, played by a YouTube embed instead of our proxy.
 *
 * WHY THIS EXISTS AT ALL, given that NativeTrailer's header argues the exact
 * opposite. That argument had one premise: an embed paints a big centre button
 * on start-up and nothing removes it — not `controls=0`, not CSS (cross-origin),
 * not any message. Every consequence followed from it: hide the frame, watch it
 * from outside, and eventually proxy the bytes ourselves so there would be no
 * embed at all.
 *
 * The premise was true, and the whole apparatus built on it — resolving through
 * InnerTube, proxying the bytes, a circuit breaker, a warm-up ladder — cost more
 * than it was worth: it bought a clean first frame at the price of being
 * rationed by YouTube, which refused a datacentre caller roughly a third of the
 * time no matter how the request was dressed. All of it is now deleted, and this
 * is deliberately the PLAIN embed: autoplay, muted, our own controls over it.
 *
 * So YouTube's centre button is back for the first ~4 s. That is a known,
 * accepted state and not an oversight — the point of starting from the plain
 * embed is to have a base that is simple and correct before optimising it away.
 *
 * THE LEAD WORTH FOLLOWING, recorded here so it is not rediscovered from
 * scratch: the chrome is fixed in PIXELS (measured 09/08 as "at 120 px the
 * chrome eats the image"), so it does not survive being scaled. Mounting the
 * player far larger than its box and scaling it back down shrinks the button
 * while the video still fills the frame. Glyph pixels in the centre disc with
 * the chrome up: 360 at ×1, 77 at ×2, 10 at ×4, 0 at ×8; at ×200 the frame is
 * visually spotless. Two caveats came with it — a ~7 % dark veil survives at any
 * factor (red channel on a flat red field: 219 at ×1, 231.5 at ×8, 249 with no
 * chrome at all), and the composited surface grows quadratically, so it depends
 * on the browser clamping rather than allocating it. There is a bench at
 * public/embed-scale-lab.html.
 *
 * `playing` is INFERRED over postMessage rather than being an event on an
 * element we own, and that inference must never be load-bearing. It was once,
 * for exactly one deploy: the frame's opacity hung on a message from the player,
 * so when the message did not come the trailer played invisibly behind the
 * banner and looked broken. The fade-in is on a timer now and a real message
 * only beats it — see the reveal timeout below.
 *
 * `pointer-events: none` on the iframe is load-bearing: HoverPreviewProvider
 * needs the pointer events to know the card is still hovered, so every control
 * lives in a layer above the picture.
 */

/** Sound is ON by default; a trailer at full blast on hover is not. */
const FALLBACK_VOLUME = PREVIEW_DEFAULT_VOLUME;
/** Controls fade this long after the pointer stops moving over the video. */
const IDLE_MS = 1600;
/** Travel, in px, before a pointermove counts as the user reaching for a control. */
const MOVE_SLOP = 8;
/** No controls at all for this long after the card opens, movement or not. */
const OPEN_GRACE_MS = 350;
/** How still the pointer must be before movement is read as intent — see NativeTrailer. */
const SETTLE_MS = 400;

/** YouTube's player states, the only two this cares about. */
const PLAYING = 1;
const PAUSED = 2;

export default function EmbedTrailer({
  id,
  onHide,
  onPlayingChange,
}: {
  id: string;
  /** true = unplayable, drop the frame for good. */
  onHide: (hidden: boolean) => void;
  /** Live transport state. The card paints its artwork whenever this is false. */
  onPlayingChange: (playing: boolean) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const volCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const armedRef = useRef(false);
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wantMutedRef = useRef(true);
  /** Guards the one-shot unmute, which must not re-fire on every state change. */
  const unmutedRef = useRef(false);
  const mountedAtRef = useRef(Date.now());
  const volumeRef = useRef(FALLBACK_VOLUME);

  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(FALLBACK_VOLUME);
  const [volOpen, setVolOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [showControls, setShowControls] = useState(false);

  /**
   * `loop` needs `playlist` set to the same id — on its own it does nothing for
   * a single video. `enablejsapi` is what makes the buttons below possible at
   * all; everything else is the same parameter set the measurements were taken
   * with, so what ships is what was photographed.
   */
  const src =
    `https://www.youtube.com/embed/${id}` +
    `?enablejsapi=1&controls=0&autoplay=1&mute=1&playsinline=1&rel=0` +
    `&iv_load_policy=3&disablekb=1&fs=0&loop=1&playlist=${id}`;

  /** Fire a command at the player. No-op until the frame exists. */
  const post = useCallback((func: string, args: unknown[] = []) => {
    frameRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func, args }),
      "https://www.youtube.com",
    );
  }, []);

  // Seed from the PREVIEW's own setting, exactly as NativeTrailer does — these
  // controls must not touch the watch player's volume.
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

  /**
   * Subscribe to the player's events, then listen.
   *
   * The embed only starts posting once it has received a `listening` message, and
   * it can miss one sent before the frame has finished booting — so it is
   * repeated briefly rather than sent once and hoped for. This is the entire
   * remnant of the old handshake: no heartbeat, no watchdog, no retries against
   * unrequested pauses, because nothing here depends on knowing the state in
   * time. Worst case the picture fades in a beat late.
   */
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== "https://www.youtube.com") return;
      let data: { event?: string; info?: unknown };
      try {
        data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      if (data?.event === "onError") {
        onHide(true);
        return;
      }
      /*
       * TWO shapes carry the same fact, and only listening for one of them is
       * what made the picture invisible the first time this shipped.
       *
       * `onStateChange` arrives with the state as `info` directly. But the
       * player also volunteers `infoDelivery`, whose `info` is an object with a
       * `playerState` inside — and in practice that is the one that turns up.
       * Subscribing to the first alone meant `playing` never became true, and
       * since the frame's opacity was tied to it, a trailer that was loaded,
       * running and audible-if-unmuted sat at opacity 0 behind the banner.
       */
      const state =
        data?.event === "onStateChange"
          ? data.info
          : data?.event === "infoDelivery"
            ? (data.info as { playerState?: unknown } | null)?.playerState
            : undefined;
      if (state === undefined) return;
      if (state === PLAYING) {
        setPlaying(true);
        setPaused(false);
        onPlayingChange(true);
        // Unmute only once playback is under way: policy refuses an audible
        // START, not an audible continuation.
        if (!unmutedRef.current) {
          unmutedRef.current = true;
          post("setVolume", [Math.round(volumeRef.current * 100)]);
          if (!wantMutedRef.current) {
            post("unMute");
            setMuted(false);
          }
        }
      } else if (state === PAUSED) {
        setPaused(true);
        onPlayingChange(false);
      }
    };

    window.addEventListener("message", onMessage);
    const handshake = setInterval(() => {
      // The API's own shape: `id` and `channel` alongside the event. A bare
      // `{event:"listening"}` is accepted by some builds and ignored by others,
      // which is not a coin worth flipping for a subscription this depends on.
      frameRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "listening", id: 1, channel: "widget" }),
        "https://www.youtube.com",
      );
    }, 250);
    const stopHandshake = setTimeout(() => clearInterval(handshake), 4000);

    /*
     * SHOW THE PICTURE EVEN IF NOTHING EVER ANSWERS.
     *
     * The header of this file claims a late message costs "a slightly late
     * fade-in". That was wrong as written: a MISSING message cost the whole
     * frame, because opacity was gated on a state only the player could grant.
     * A silent player and a broken one were indistinguishable, and both looked
     * like "the trailer doesn't work".
     *
     * So the fade-in now happens on a timer regardless, and any real message
     * simply beats it. Autoplaying muted video is allowed by every browser we
     * support, so "assume it is playing" is the safe assumption rather than the
     * optimistic one — and if it truly is not, the viewer sees YouTube's own
     * poster frame, which is a perfectly good picture.
     */
    const reveal = setTimeout(() => {
      setPlaying(true);
      onPlayingChange(true);
    }, 1500);

    return () => {
      window.removeEventListener("message", onMessage);
      clearInterval(handshake);
      clearTimeout(stopHandshake);
      clearTimeout(reveal);
    };
  }, [onHide, onPlayingChange, post]);

  useEffect(
    () => () => {
      if (idleRef.current) clearTimeout(idleRef.current);
      if (volCloseRef.current) clearTimeout(volCloseRef.current);
      if (settleRef.current) clearTimeout(settleRef.current);
    },
    [],
  );

  const applyMuted = (next: boolean) => {
    wantMutedRef.current = next;
    unmutedRef.current = true;
    writeMuted(next);
    setMuted(next);
    post(next ? "mute" : "unMute");
  };

  const applyVolume = (raw: number) => {
    const v = Math.min(1, Math.max(0, raw));
    volumeRef.current = v;
    setVolume(v);
    writeVolume(v);
    post("setVolume", [Math.round(v * 100)]);
    // Dragging to the bottom IS muting, and back up IS unmuting.
    if (v === 0 && !muted) applyMuted(true);
    if (v > 0 && muted) applyMuted(false);
  };

  const stop = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const toggleMute = (e: React.MouseEvent) => {
    stop(e);
    const next = !muted;
    applyMuted(next);
    if (!next && volumeRef.current <= 0) applyVolume(FALLBACK_VOLUME);
  };

  const togglePlay = (e: React.MouseEvent) => {
    stop(e);
    // Optimistic: the embed confirms via onStateChange, but the button must not
    // wait a round trip to look pressed.
    if (paused) {
      post("playVideo");
      setPaused(false);
    } else {
      post("pauseVideo");
      setPaused(true);
    }
  };

  const volumeFromEvent = (e: React.PointerEvent) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
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

  const closeVolume = () => {
    if (volCloseRef.current) clearTimeout(volCloseRef.current);
    volCloseRef.current = setTimeout(() => setVolOpen(false), 260);
  };

  // Identical arming logic to NativeTrailer: the card opens UNDER the pointer,
  // so movement only means intent once the hand has come to rest.
  const wake = (e: React.PointerEvent) => {
    if (Date.now() - mountedAtRef.current < OPEN_GRACE_MS) return;
    if (!armedRef.current) {
      if (settleRef.current) clearTimeout(settleRef.current);
      settleRef.current = setTimeout(() => {
        armedRef.current = true;
        originRef.current = null;
      }, SETTLE_MS);
      return;
    }
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
    if (settleRef.current) clearTimeout(settleRef.current);
    armedRef.current = false;
    originRef.current = null;
    setShowControls(false);
  };

  const controlsVisible = playing && (showControls || volOpen);
  const chrome = `transition-opacity duration-200 ${
    controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
  }`;

  return (
    <div
      className="absolute inset-0 overflow-hidden"
      onPointerMove={wake}
      onPointerLeave={sleep}
    >
      <iframe
        ref={frameRef}
        src={src}
        title=""
        allow="autoplay; encrypted-media"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          border: 0,
          width: "100%",
          height: "100%",
        }}
        className={`pointer-events-none transition-opacity duration-300 ${
          playing ? "opacity-100" : "opacity-0"
        }`}
      />

      {/* Scrim so the icons stay legible over a bright frame. */}
      <div
        aria-hidden
        className={`absolute inset-0 bg-gradient-to-b from-black/45 via-transparent to-transparent ${chrome}`}
      />

      {/* Play/pause, OFF TO THE SIDE rather than centred.
          Centred is where it belonged when we owned the picture — but the embed
          paints its own button dead centre for the first seconds, and stacking
          ours on top of it gives two buttons in one place. Top-left keeps them
          apart while the question of removing YouTube's is still open. */}
      <div className={`absolute left-2 top-2 ${chrome}`}>
        <button
          type="button"
          onClick={togglePlay}
          aria-label={paused ? "Play" : "Pause"}
          className="as-preview-videobtn h-7 w-7"
        >
          {paused ? <MdPlayArrow size={21} /> : <MdPause size={21} />}
        </button>
      </div>

      <div
        className={`absolute right-2 top-2 flex flex-col items-center ${chrome}`}
        onPointerEnter={openVolume}
        onPointerLeave={closeVolume}
      >
        <button
          type="button"
          onClick={toggleMute}
          aria-label={muted ? "Unmute" : "Mute"}
          className="as-preview-videobtn h-7 w-7"
        >
          {muted ? <MdVolumeOff size={21} /> : <MdVolumeUp size={21} />}
        </button>

        <div
          className={`as-preview-voltrack mt-1.5 flex justify-center px-1.5 py-2 transition-opacity duration-150 ${
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
            className="relative h-20 w-[5px] cursor-pointer rounded-full bg-white/25"
          >
            <div
              className="absolute bottom-0 left-0 w-full rounded-full"
              style={{
                height: `${(muted ? 0 : volume) * 100}%`,
                background: "var(--brand-primary, #ff3b5c)",
              }}
            />
            <div
              className="pointer-events-none absolute left-1/2 h-3 w-3 -translate-x-1/2 translate-y-1/2 rounded-full bg-white"
              style={{
                bottom: `${(muted ? 0 : volume) * 100}%`,
                boxShadow: "0 1px 4px rgba(0,0,0,.6)",
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
