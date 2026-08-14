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
 * time no matter how the request was dressed. All of it is deleted.
 *
 * What replaces it is not a better request but a different question. Nobody had
 * tried moving the PLAYER; every earlier attempt moved the FRAME around a button
 * of constant size. The chrome is sized in pixels, so it does not survive being
 * scaled down — see SCALE, which is where that measurement and its two costs
 * live. The bytes now travel from YouTube to the visitor directly, which is also
 * the one arrangement YouTube has no reason to refuse.
 *
 * `playing` is INFERRED over postMessage rather than being an event on an
 * element we own, and that inference must never be load-bearing. It was once,
 * for exactly one deploy: the frame's opacity hung on a message from the player,
 * so when the message did not come the trailer played invisibly behind the
 * banner and looked broken. Nothing waits on a message alone any more — see
 * FORCE_PLAY_MS, which starts the player if it never speaks.
 *
 * `pointer-events: none` on the iframe is load-bearing: HoverPreviewProvider
 * needs the pointer events to know the card is still hovered, so every control
 * lives in a layer above the picture.
 */

/**
 * The privacy-preserving host, and it is not only a courtesy.
 *
 * youtube.com pulls doubleclick for ad status on every embed, which any ad
 * blocker refuses — filling the console with ERR_BLOCKED_BY_CLIENT that looks
 * like our bug and is not. nocookie asks for fewer of them, so there is less to
 * block and less noise to read past. Same player, same API.
 */
const ORIGIN = "https://www.youtube-nocookie.com";

/**
 * How much bigger the player is mounted than the box it is shown in.
 *
 * THE POINT OF THE WHOLE THING. YouTube's chrome — the centre button, the title
 * bar, the logo — is sized in PIXELS, not in proportion to the player. So it
 * does not survive a reduction: mount the player enormous, scale it back down,
 * and the button shrinks with the player while the video still fills the frame.
 *
 * Measured, glyph pixels in the centre disc with the chrome still up: 360 at ×1,
 * 77 at ×2, 10 at ×4, 0 at ×8 — the count of a witness whose chrome has already
 * faded. Past ×8 the button gains nothing more; what keeps shrinking is the
 * CORNERS, which the centre counter never saw.
 *
 * THE FIRST FRAME IS THE WHOLE DIFFICULTY, and it is a TRANSIENT, not a broken
 * end state. Before the player has measured itself it paints its small-player
 * layout once; magnified ×200 that single frame is a fist-sized centre button
 * and a white block in the corner. A moment later it re-lays-out and the frame
 * is spotless. So the fix is not a smaller factor — it is never showing that
 * frame, which is what the reveal rule below exists for.
 *
 * (Written down because the obvious reading of that screenshot is "×200 is
 * broken, drop to ×8", and it was mine for one commit. The end state was never
 * broken; only the instant we chose to reveal was wrong.)
 *
 * THE COST THAT REMAINS. A dark veil survives at any factor (red channel on a
 * flat red field: 219 at ×1, 231.5 at ×8, against 249 with no chrome at all):
 * scaling recovers ~40 % of it and then plateaus, because part is a fixed-size
 * gradient and part is a layer proportional to the player.
 *
 * Expressed as a percentage below, so the factor is independent of the card's
 * real pixel size. Bench: public/embed-scale-lab.html.
 */
const SCALE = 200;

/**
 * How far the player overflows its box, so the picture COVERS instead of FITS.
 *
 * The card's video slot is not exactly 16:9 — it is 45 % of a 468 px card, so
 * 364 × ~211, an aspect of 1.73 against the video's 1.78. A player told to fill
 * that box keeps the video's own ratio and pads the difference with black: the
 * band along the top. The old <video> never showed it because `object-cover`
 * crops to fill, and an iframe has no such thing.
 *
 * So we do it by hand: render slightly larger than the box and centre it, and
 * the bands fall outside the clip. ~3 % would cover the measured mismatch; 12 %
 * is used instead so rounding, a card of another size, or material that is not
 * quite 16:9 cannot bring the bands back. The price is losing ~5 % off each
 * edge, which is exactly what `object-cover` was already doing.
 */
const OVERSCAN = 1.12;

/**
 * DELAY THE START, NOT THE PICTURE — the shape that fixes three faults at once.
 *
 * Every previous attempt let the player autoplay and then held the frame hidden
 * until the ugly boot layout had passed. That bought a clean picture and paid
 * for it twice: the reveal was late, and the SOUND ran from the real start while
 * the image waited, so a trailer opened with music over the banner and the video
 * a beat behind it.
 *
 * The mistake was choosing when to LOOK. The player boots, measures itself and
 * settles its layout whether or not it is playing — so let all of that happen
 * while it is cued, silent and hidden, and then start it. Playback and the
 * picture begin on the same instant: no boot frame to hide, nothing to wait out
 * once it starts, and no sound ahead of the image because neither begins early.
 *
 * `autoplay` is therefore deliberately ABSENT from the URL. A muted player told
 * to play by script is allowed by every autoplay policy, which is the same
 * permission the parameter was relying on.
 */

/**
 * How long to let the cued player settle before telling it to play.
 *
 * Covers the layout pass that produced the bad frame. It is spent on a player
 * that is not running, so it costs nothing but a little more of the banner —
 * which is a finished picture, not a spinner.
 */
const SETTLE_BEFORE_PLAY_MS = 350;

/**
 * Backstop: play anyway if the player never announces itself.
 *
 * The handshake is reliable now, but a preview that stays a still banner because
 * one message went missing is exactly the failure this file has already shipped
 * once.
 */
const FORCE_PLAY_MS = 1800;

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
/*
 * BUFFERING (3) is deliberately NOT a reveal, and that is a correction.
 *
 * Revealing on it looked like free speed — the player is fetching media, so
 * surely there is something to show. What it actually shows is YouTube's
 * LOADING SPINNER over a black frame. Swapping the card's own artwork for a
 * spinner is not a faster preview, it is a worse one: the banner is a finished
 * picture, and it should hold the frame until there are real moving pixels
 * behind it.
 */

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

  /** Has the frame actually navigated to YouTube yet? See `post`. */
  const loadedRef = useRef(false);
  /** The backstop timer, so a card torn down mid-wait doesn't set state after. */
  const revealRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Have we already asked the player to start? One start per mount. */
  const startedRef = useRef(false);

  /**
   * `loop` needs `playlist` set to the same id — on its own it does nothing for
   * a single video. `enablejsapi` is what makes the buttons below possible.
   *
   * `cc_load_policy=0` asks for captions off. It is a REQUEST, not a guarantee:
   * a viewer whose YouTube account forces captions on gets them anyway, and
   * auto-generated tracks ignore it more often than not — which is why the
   * captions module is also unloaded over the API once the player answers.
   */
  const src =
    `${ORIGIN}/embed/${id}` +
    `?enablejsapi=1&controls=0&mute=1&playsinline=1&rel=0` +
    `&iv_load_policy=3&disablekb=1&fs=0&loop=1&playlist=${id}&cc_load_policy=0`;

  /**
   * Fire a command at the player.
   *
   * Guarded on the frame having LOADED, not merely existing. A fresh iframe's
   * contentWindow is still about:blank on our own origin, so posting to it with
   * YouTube's origin as the target throws "The target origin provided does not
   * match the recipient window's origin" — which is exactly the warning that was
   * showing up, once per handshake tick, before the frame had navigated.
   */
  const post = useCallback((func: string, args: unknown[] = []) => {
    if (!loadedRef.current) return;
    frameRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func, args }),
      ORIGIN,
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
      if (e.origin !== ORIGIN) return;
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
      const info = data?.info as
        | { playerState?: unknown; currentTime?: unknown }
        | null
        | undefined;
      const state = data?.event === "onStateChange" ? data.info : info?.playerState;

      /*
       * The player has booted and is sitting there cued. Let it finish settling
       * its layout — the pass that produced the bad frame — and then start it.
       * Nothing is running and nothing is visible while this waits.
       */
      if (state !== undefined && !startedRef.current) {
        startedRef.current = true;
        if (revealRef.current) clearTimeout(revealRef.current);
        revealRef.current = setTimeout(() => post("playVideo"), SETTLE_BEFORE_PLAY_MS);
      }

      if (state === undefined) return;
      if (state === PLAYING) {
        setPaused(false);
        // Show it the moment it genuinely starts. There is nothing left to wait
        // out: the boot frame happened while this was cued and hidden.
        setPlaying(true);
        onPlayingChange(true);
        /*
         * Sound joins the picture, and not before — this is the desync fix.
         *
         * Unmuting used to happen on the first PLAYING while the frame was still
         * hidden behind the banner, so a trailer opened with music over a still
         * image and the video arriving a beat later. Both begin together now
         * because playback itself no longer begins early.
         */
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
      // Not before the frame has navigated: until then its contentWindow is
      // about:blank on OUR origin, and posting with YouTube's origin as the
      // target throws — once per tick, which is what filled the console.
      if (!loadedRef.current) return;
      // The API's own shape: `id` and `channel` alongside the event. A bare
      // `{event:"listening"}` is accepted by some builds and ignored by others,
      // which is not a coin worth flipping for a subscription this depends on.
      frameRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "listening", id: 1, channel: "widget" }),
        ORIGIN,
      );
    }, 150);
    const stopHandshake = setTimeout(() => clearInterval(handshake), 4000);

    /*
     * START IT ANYWAY IF NOTHING EVER ANSWERS.
     *
     * Without `autoplay`, a player that never speaks never plays — so a lost
     * message would leave the card on its banner for good. This file has
     * already shipped that failure once, in the other direction, and the
     * lesson is the same: never let the picture depend on a message arriving.
     */
    const force = setTimeout(() => {
      if (startedRef.current) return;
      startedRef.current = true;
      post("playVideo");
    }, FORCE_PLAY_MS);

    return () => {
      window.removeEventListener("message", onMessage);
      clearInterval(handshake);
      clearTimeout(stopHandshake);
      clearTimeout(force);
    };
  }, [onHide, onPlayingChange, post]);

  useEffect(
    () => () => {
      if (idleRef.current) clearTimeout(idleRef.current);
      if (volCloseRef.current) clearTimeout(volCloseRef.current);
      if (settleRef.current) clearTimeout(settleRef.current);
      if (revealRef.current) clearTimeout(revealRef.current);
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
        /*
         * `compute-pressure` is not decoration: without it the player logs
         * "Permissions policy violation: compute-pressure is not allowed in this
         * document" on every card. The feature lets it read how loaded the CPU
         * is and drop quality rather than stutter — which is exactly what a
         * preview scaled ×200 wants it to be able to do. Delegating a feature
         * the frame asks for is the fix; silencing the console is not.
         */
        allow="autoplay; encrypted-media; compute-pressure"
        // Sized in PERCENT, not pixels, so the factor holds whatever the card's
        // real width turns out to be: 20000 % of the box, scaled back by 1/200,
        // lands on the box again — times OVERSCAN, which is what makes it cover
        // rather than fit. The negative offsets re-centre that overflow, half of
        // it on each side, so the letterbox bands are clipped away.
        style={{
          position: "absolute",
          border: 0,
          width: `${SCALE * OVERSCAN * 100}%`,
          height: `${SCALE * OVERSCAN * 100}%`,
          left: `${(-(OVERSCAN - 1) / 2) * 100}%`,
          top: `${(-(OVERSCAN - 1) / 2) * 100}%`,
          transform: `scale(${1 / SCALE})`,
          // Top-left, otherwise the reduction re-centres and shifts the picture.
          transformOrigin: "0 0",
        }}
        onLoad={() => {
          // Only NOW is the frame on YouTube's origin and safe to talk to.
          loadedRef.current = true;
          /*
           * Captions off, for real this time.
           *
           * `cc_load_policy=0` in the URL is a preference the player is free to
           * override, and it does: auto-generated tracks turned up on the card
           * anyway. Unloading the module is the instruction it cannot reinterpret
           * — a preview is three seconds of moving artwork, and a line of
           * machine-transcribed dialogue over it is noise, not information.
           */
          post("unloadModule", ["captions"]);
          post("unloadModule", ["cc"]);
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

      {/* Play/pause, off to the side rather than centred.
          It was moved here when the embed still painted its own button dead
          centre, to avoid two buttons in one place. SCALE has since removed
          that one, so the centre is free again — this stays put because that is
          how it was asked for, not because it is still forced. */}
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
