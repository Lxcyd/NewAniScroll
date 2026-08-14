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
 * The premise was true and the conclusion was wrong, because we only ever tried
 * to move the FRAME around a button of constant size. The chrome is fixed in
 * PIXELS — measured on 09/08 as "at 120 px the chrome eats the image", an
 * observation nobody followed up. So it does not survive being scaled: mount the
 * player enormous, scale it back down, and the button shrinks with the player
 * while the video still fills the frame.
 *
 * MEASURED, glyph pixels in the centre disc with the chrome still up: 360 at
 * ×1, 77 at ×2, 10 at ×4, 0 at ×8 — the same count as a witness whose chrome
 * has already faded. At ×200 the frame is visually spotless: no title bar, no
 * avatar, no share icon, no thumbnail, no logo. Verified by photograph on a real
 * trailer and not only by the counter, and playback confirmed by frame
 * differencing (a still frame would have looked identical on the flat-red test
 * video that first suggested this, which is why it was re-tested on moving
 * material).
 *
 * WHAT THIS BUYS. The proxy exists only to be rid of that button. Without it
 * there is no proxy, no InnerTube call, no bot block, no breaker, no warm-up
 * ladder — and the bytes travel from YouTube to the visitor directly, which is
 * also the only arrangement YouTube has no reason to refuse.
 *
 * WHAT IT COSTS, stated plainly:
 *   - a dark veil survives. Measured on a flat red field, red channel at the
 *     centre: 219 with chrome at ×1, 231.5 at ×8, 231.5 at ×16, against 249 with
 *     no chrome at all. Scaling recovers ~40 % of the veil and then plateaus,
 *     because part of it is a fixed-size gradient (which shrinks) and part is a
 *     layer proportional to the player (which does not). ~7 % dimming remains
 *     for the first four seconds;
 *   - the composited surface is huge and its cost is quadratic. ×200 of a 364 px
 *     box is 72800 px wide. Chrome evidently clamps rather than allocating it,
 *     which is why this works at all — but that is a browser implementation
 *     detail we do not control, and it is the first thing to check on Safari,
 *     Firefox and on a phone;
 *   - `playing` goes back to being INFERRED over postMessage rather than being
 *     an event on an element we own. The difference from the 655-line version
 *     NativeTrailer replaced is that none of it is load-bearing any more: that
 *     machine existed to keep the frame HIDDEN until the button had gone. Here
 *     there is no button to wait out, so a late or missing message costs a
 *     slightly late fade-in, not a visible intrusion.
 *
 * `pointer-events: none` on the iframe is load-bearing for the same reason as in
 * NativeTrailer: HoverPreviewProvider needs the pointer events to know the card
 * is still hovered, so every control lives in a layer above the picture.
 */

/**
 * How much bigger the player is mounted than the box it is shown in.
 *
 * ×8 already zeroes the centre glyph; what keeps improving past it is the
 * CORNERS — the title top-left and the logo bottom-right, which the centre
 * counter never saw. ×200 is where the frame reads as completely clean to the
 * eye. It is deliberately expressed as a percentage below so the factor is
 * independent of the card's actual pixel size.
 */
const SCALE = 200;

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
      if (data?.event !== "onStateChange") return;
      const state = data.info;
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
      frameRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "listening" }),
        "https://www.youtube.com",
      );
    }, 250);
    const stopHandshake = setTimeout(() => clearInterval(handshake), 4000);

    return () => {
      window.removeEventListener("message", onMessage);
      clearInterval(handshake);
      clearTimeout(stopHandshake);
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
        // Sized in PERCENT, not pixels, so the factor holds whatever the card's
        // real width turns out to be: 20000 % of the box, scaled back by 1/200,
        // lands exactly on the box again.
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          border: 0,
          width: `${SCALE * 100}%`,
          height: `${SCALE * 100}%`,
          transform: `scale(${1 / SCALE})`,
          // Top-left, otherwise the reduction re-centres and shifts the picture.
          transformOrigin: "0 0",
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

      {/* Play/pause, centred. Same place as the button this whole approach
          removes — but this one appears only while the pointer is moving over
          the video, which is the entire difference between a control and an
          intrusion. */}
      <div className={`pointer-events-none absolute inset-0 grid place-items-center ${chrome}`}>
        <button
          type="button"
          onClick={togglePlay}
          aria-label={paused ? "Play" : "Pause"}
          className="as-preview-videobtn pointer-events-auto h-14 w-14"
        >
          {paused ? <MdPlayArrow size={52} /> : <MdPause size={52} />}
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
