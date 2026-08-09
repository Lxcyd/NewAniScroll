import { useCallback, useEffect, useRef, useState } from "react";
import { MdPause, MdPlayArrow, MdVolumeOff, MdVolumeUp } from "react-icons/md";

import {
  PREVIEW_DEFAULT_VOLUME,
  readMuted,
  readVolume,
  writeMuted,
  writeVolume,
} from "@/lib/prefs/playerVolume";
import {
  makeProbeCanvas,
  probeCrop,
  readCrop,
  sampleLive,
  trailerSrc,
  writeCrop,
} from "@/lib/preview/trailerCrop";

/**
 * The trailer frame of the hover preview.
 *
 * This replaced a 655-line YouTube iframe driven over postMessage. Almost all
 * of that file was surveillance — a `listening` handshake, a 600 ms heartbeat,
 * a playback-clock watchdog, three bounded retries against unrequested pauses,
 * and a 4.2 s delay before the picture could be shown at all. None of it was
 * incidental: an embed paints its own big centre button whenever it is
 * starting, paused, unstarted or cued, `controls=0` does not remove it, no CSS
 * reaches into a cross-origin frame, and no message announces it. Hiding the
 * frame was the only guarantee, so the entire machine existed to know, from the
 * outside, whether a video we could not see was really running.
 *
 * Feeding a <video> ourselves deletes the problem rather than managing it.
 * There is no chrome because there is no player but ours; `playing` is an event,
 * not an inference; the picture appears when there are pixels. What is left
 * here is the volume control, a play/pause button that was previously
 * unbuildable (pausing an embed was precisely what summoned the button), and
 * the crop that hides bars baked into old material.
 *
 * `pointer-events: none` on the video is still load-bearing: HoverPreviewProvider
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

export default function NativeTrailer({
  id,
  videoRef,
  onHide,
  onPlayingChange,
  onCrop,
}: {
  id: string;
  /** Shared with TrailerAmbient, which follows this element's clock. */
  videoRef: React.RefObject<HTMLVideoElement>;
  /** true = unplayable, drop the frame for good. */
  onHide: (hidden: boolean) => void;
  /** Live transport state. The card paints its artwork whenever this is false. */
  onPlayingChange: (playing: boolean) => void;
  /** The measured crop, so the ambient copy is framed like the picture. */
  onCrop: (zoom: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const volCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  /** Where the pointer was when it first met the video — see `wake`. */
  const originRef = useRef<{ x: number; y: number } | null>(null);
  /** The user's standing choice; the live `muted` state can lag behind it. */
  const wantMutedRef = useRef(true);
  /** Guards the one-shot unmute, which must not re-fire on every play event. */
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
   * Seeded from the store during the FIRST render, not in an effect.
   *
   * An effect runs after the browser has painted, so setting the crop there
   * left the element at scale 1 for a frame and then moved it — a zoom the
   * viewer could watch happen. A trailer whose framing is already known must be
   * correct in the very first frame it paints, which means the value has to
   * exist before React builds the element. Safe to read storage here: the card
   * is client-only.
   */
  const [zoom, setZoom] = useState(() => readCrop(id) ?? 1);

  const src = trailerSrc(id);

  // Seed from the app-wide setting, not a preview-only one: turning the volume
  // down here turns it down in the watch player too, and vice versa.
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
    onCrop(zoom);
  }, [zoom, onCrop]);

  /**
   * Decide the crop before the picture is shown, and remember it.
   *
   * Skipped entirely when the answer is already known — which is the common
   * case in production, since the same cards are hovered repeatedly.
   */
  useEffect(() => {
    if (readCrop(id) != null) return;
    if (!canvasRef.current) canvasRef.current = makeProbeCanvas();
    const canvas = canvasRef.current;
    let cancelled = false;
    let stopLive: (() => void) | null = null;

    probeCrop(src, canvas).then((value) => {
      if (cancelled) return;
      if (value != null) {
        setZoom(value);
        writeCrop(id, value);
        return;
      }
      // The probe came back empty. Learn from the frames the viewer is being
      // shown instead.
      const video = videoRef.current;
      if (!video) return;
      stopLive = sampleLive(video, canvas, (z) => {
        setZoom(z);
        writeCrop(id, z);
      });
    });

    return () => {
      cancelled = true;
      if (stopLive) stopLive();
    };
  }, [id, src, videoRef]);

  useEffect(
    () => () => {
      if (idleRef.current) clearTimeout(idleRef.current);
      if (volCloseRef.current) clearTimeout(volCloseRef.current);
    },
    [],
  );

  /**
   * Turn the sound on once playback is under way.
   *
   * The element always LOADS muted, because that is the only kind of autoplay a
   * browser allows. Unmuting afterwards is legal for the same reason it was
   * legal in the old embed: policy refuses an audible START, not an audible
   * continuation. If the browser disagrees anyway it pauses us, and `onPause`
   * below concedes rather than fights.
   */
  const applyPreferredSound = useCallback(() => {
    const video = videoRef.current;
    if (!video || unmutedRef.current) return;
    unmutedRef.current = true;
    video.volume = volumeRef.current;
    if (!wantMutedRef.current) {
      video.muted = false;
      setMuted(false);
    }
  }, [videoRef]);

  const applyMuted = (next: boolean) => {
    const video = videoRef.current;
    wantMutedRef.current = next;
    unmutedRef.current = true;
    writeMuted(next);
    setMuted(next);
    if (video) video.muted = next;
  };

  /**
   * The volume is the app's, not the preview's: same localStorage keys as the
   * watch player, so a level set on a trailer is the level the next episode
   * starts at.
   */
  const applyVolume = (raw: number) => {
    const v = Math.min(1, Math.max(0, raw));
    volumeRef.current = v;
    setVolume(v);
    writeVolume(v);
    if (videoRef.current) videoRef.current.volume = v;
    // Dragging to the bottom IS muting, and dragging back up IS unmuting — a
    // slider at zero next to an unmuted icon is a lie.
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
    // Un-muting a slider sitting at zero would look broken: give it something
    // to be un-muted TO.
    if (!next && volumeRef.current <= 0) applyVolume(FALLBACK_VOLUME);
  };

  const togglePlay = (e: React.MouseEvent) => {
    stop(e);
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => undefined);
    else video.pause();
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

  // Controls are invisible until the pointer actually moves over the video, and
  // fade again once it settles — the trailer is the content, not the chrome.
  //
  // "Actually moves" is the whole difficulty. The card opens UNDER the pointer,
  // so the browser fires a pointermove against it immediately even though the
  // hand never moved: the card came to the cursor, not the reverse. So the
  // first move only records a baseline, and nothing shows until the pointer has
  // travelled past MOVE_SLOP from it.
  const wake = (e: React.PointerEvent) => {
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

  // `volOpen` keeps the chrome up while the slider is out: it can only be open
  // because the pointer is already on the volume button.
  const controlsVisible = playing && (showControls || volOpen);
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
      <video
        ref={videoRef}
        src={src}
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        // Without this the probe canvas is tainted and the crop cannot be
        // measured. The Worker answers with `Access-Control-Allow-Origin: *`.
        crossOrigin="anonymous"
        // No transition on the transform: on a remembered trailer the crop is
        // already right at the first painted frame, and on a fresh one it lands
        // while the studio card is still black — there is never anything to ease
        // between, and animating it only drew the eye to a correction the viewer
        // had no reason to notice.
        className={`pointer-events-none absolute inset-0 h-full w-full transform-gpu object-cover transition-opacity duration-300 ${
          playing ? "opacity-100" : "opacity-0"
        }`}
        style={{ transform: `scale(${zoom})` }}
        onPlaying={() => {
          setPlaying(true);
          setPaused(false);
          onPlayingChange(true);
          applyPreferredSound();
        }}
        onPause={() => {
          setPaused(true);
          onPlayingChange(false);
        }}
        onWaiting={() => onPlayingChange(false)}
        // Nothing to salvage: no source, no picture. The card falls back to its
        // artwork, which is what the visitor was already looking at.
        onError={() => onHide(true)}
      />

      {/* Scrim so the icons stay legible over a bright frame. */}
      <div
        aria-hidden
        className={`absolute inset-0 bg-gradient-to-b from-black/45 via-transparent to-transparent ${chrome}`}
      />

      {/* Play/pause. Impossible until now — pausing a YouTube embed is exactly
          what made it paint its own button over the picture. */}
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

      {/* Volume: the button, and the track that drops out of it on hover. Both
          live in one wrapper so the pointer can travel from one to the other
          without the group ever being "left". */}
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
            // A 5 px bar is a 5 px target: the padding above widens the hit area
            // without widening the bar.
            className="relative h-20 w-[5px] cursor-pointer rounded-full bg-white/25"
          >
            {/* Filled part in the brand colour, like every other slider in the
                app; the knob stays white so it reads against it. */}
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
