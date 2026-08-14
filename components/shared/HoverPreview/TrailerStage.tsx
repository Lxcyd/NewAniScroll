import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { MdPause, MdPlayArrow, MdVolumeOff, MdVolumeUp } from "react-icons/md";

import {
  PREVIEW_DEFAULT_VOLUME,
  readMuted,
  readVolume,
  writeMuted,
  writeVolume,
} from "@/lib/prefs/previewVolume";
import { onFirstTrailer } from "@/lib/preview/previewStore";
import { getStage, subscribeStage } from "./stageStore";

/**
 * ONE trailer player for the whole session, drawn over whichever card is open.
 *
 * WHY THIS IS NOT INSIDE THE CARD ANY MORE — measured, not assumed. A preview
 * that mounts its own embed pays, on every single poster:
 *
 *     ~450 ms   the iframe is born and YouTube's player boots
 *     ~350 ms   a settle delay, so the player's first ugly layout stays hidden
 *     ~800 ms   playVideo -> a picture that actually advances
 *
 * The last line is YouTube's and we cannot touch it. The first two are ours, and
 * they are paid again for every card because every card threw the player away.
 * A player that is already alive skips both: reuse costs the video load and
 * nothing else, and — photographed to be sure — a `loadVideoById` on a warm
 * player goes black straight to picture, with none of the giant-button frame
 * that a cold boot paints. So the player stops being part of the card.
 *
 * WHAT WAS TRIED AND DOES NOT WORK. `cueVideoById` well in advance, to overlap
 * that 800 ms with the 200 ms the pointer must hold still: cueing 200, 400, 800
 * or 1500 ms ahead gives the same median start (~600-1000 ms, no trend). The
 * player does not pre-buffer a cued video, so there is nothing to gain by asking
 * earlier, and the idea is written down here so it is not rebuilt.
 *
 * HOW IT DRAWS IN THE RIGHT PLACE. It cannot be moved into the card — reparenting
 * an iframe reloads it, which would throw away the very boot this exists to
 * keep. So it stays put and positions itself over the card's video slot, which
 * it measures every frame while a card is open. See stageStore.ts.
 *
 * `playing` is INFERRED over postMessage rather than being an event on an element
 * we own, and that inference must never be load-bearing. It was once, for exactly
 * one deploy: the frame's opacity hung on a message from the player, so when the
 * message did not come the trailer played invisibly behind the banner and looked
 * broken. See FORCE_PLAY_MS and REVEAL_ANYWAY_MS.
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

/** The card's own top corners, which a layer drawn above it has to repeat. */
const RADIUS = "12px 12px 0 0";

/**
 * REVEAL ON PROOF, NOT ON A CLOCK — the rule that finally kills the boot frame.
 *
 * Every earlier attempt hid the picture for a fixed number of milliseconds and
 * hoped the player's first, small-player layout had passed by then. On a slower
 * machine it had not, and the giant button showed through; raising the number
 * to be safe is the same thing as being slow on purpose. A constant cannot win a
 * race whose length belongs to someone else's computer.
 *
 * `currentTime` moving is not a timer, it is the player reporting that real
 * frames are going past — which cannot be true while it is still laying itself
 * out. So that is what the frame waits for, and nothing else.
 */
const ADVANCED = 0.15;
/** Below this, the clock belongs to the video we just asked for, not the last one. */
const REWOUND = 0.5;

/**
 * Backstops. Neither should ever fire; both exist because this file has already
 * shipped a preview that sat on its banner for ever waiting for a message.
 */
const FORCE_PLAY_MS = 1800;
const REVEAL_ANYWAY_MS = 4000;

/** Sound is ON by default; a trailer at full blast on hover is not. */
const FALLBACK_VOLUME = PREVIEW_DEFAULT_VOLUME;
/** Controls fade this long after the pointer stops moving over the video. */
const IDLE_MS = 1600;
/** Travel, in px, before a pointermove counts as the user reaching for a control. */
const MOVE_SLOP = 8;
/** No controls at all for this long after the card opens, movement or not. */
const OPEN_GRACE_MS = 350;
/** How still the pointer must be before movement is read as intent. */
const SETTLE_MS = 400;

/** YouTube's player states, the only two this cares about. */
const PLAYING = 1;
const PAUSED = 2;

export default function TrailerStage() {
  const attachment = useSyncExternalStore(subscribeStage, getStage, () => null);

  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const volCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const armedRef = useRef(false);
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wantMutedRef = useRef(true);
  const volumeRef = useRef(FALLBACK_VOLUME);
  const openedAtRef = useRef(0);

  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(FALLBACK_VOLUME);
  const [volOpen, setVolOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const [paused, setPaused] = useState(false);
  const [showControls, setShowControls] = useState(false);

  /**
   * The id the iframe was BORN with — set once, never again.
   *
   * Changing it would re-navigate the frame, which is the boot we are avoiding.
   * Every later video arrives through `loadVideoById` instead.
   *
   * WHICH id barely matters: the point is to have YouTube's player alive and
   * measured before anybody hovers, and the video it happens to be cued on is
   * replaced by the first card anyway. So the first trailer the page hears about
   * is used, and the boot is spent at idle rather than on the first card's back.
   */
  const [bootId, setBootId] = useState<string | null>(null);

  /** Has the frame navigated to YouTube yet? See `post`. */
  const loadedRef = useRef(false);
  /** The video the player is actually on, or was last told to load. */
  const loadedIdRef = useRef<string | null>(null);
  /** Asked for while the frame was still booting; sent as soon as it can be. */
  const pendingIdRef = useRef<string | null>(null);
  /**
   * A card is waiting on the video the frame was BORN with — play it as soon as
   * the player speaks.
   *
   * Only the boot video needs this. Everything after it arrives through
   * `loadVideoById`, which starts playing on its own. The play is deferred to
   * the first message rather than sent from `onLoad` because a command aimed at
   * a player that has not finished waking is simply dropped.
   */
  const wantPlayRef = useRef(false);
  /** Has the boot video ever been started? It is cued, not playing, until asked. */
  const playedRef = useRef(false);
  /** Seen the clock at the start of the CURRENT video — see ADVANCED. */
  const rewoundRef = useRef(false);
  /** Already revealed for the current attachment. */
  const shownRef = useRef(false);
  /** Handlers of the live attachment, read from inside the message listener. */
  const handlersRef = useRef(attachment?.handlers ?? null);
  handlersRef.current = attachment?.handlers ?? null;
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Fire a command at the player.
   *
   * Guarded on the frame having LOADED, not merely existing. A fresh iframe's
   * contentWindow is still about:blank on our own origin, so posting to it with
   * YouTube's origin as the target throws "The target origin provided does not
   * match the recipient window's origin".
   */
  const post = useCallback((func: string, args: unknown[] = []) => {
    if (!loadedRef.current) return;
    frameRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func, args }),
      ORIGIN,
    );
  }, []);

  const reveal = useCallback(() => {
    if (shownRef.current) return;
    shownRef.current = true;
    setVisible(true);
    setPaused(false);
    handlersRef.current?.onPlaying(true);
    /*
     * Sound joins the picture, and not before.
     *
     * Unmuting on the first PLAYING, while the frame was still hidden behind the
     * banner, opened a trailer with music over a still image and the video a beat
     * later. The volume is also re-applied here rather than once per session:
     * this player survives the card, so it carries the last card's settings into
     * the next one unless they are asserted again.
     */
    post("setVolume", [Math.round(volumeRef.current * 100)]);
    post(wantMutedRef.current ? "mute" : "unMute");
    setMuted(wantMutedRef.current);
  }, [post]);

  // Seed from the PREVIEW's own setting — these controls must not touch the
  // watch player's volume.
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
   * WARM THE PLAYER WHILE NOTHING IS HAPPENING.
   *
   * The boot is ~450 ms and it is ours, not YouTube's. Reusing one player
   * already removed it from every card but the first; this removes it from the
   * first one too, by spending it before anybody hovers.
   *
   * AT IDLE, and not at page load: the boot pulls YouTube's player script, which
   * is not small, and a preview nobody has asked for yet has no business
   * competing with the page the visitor is actually reading. `requestIdleCallback`
   * with a timeout means "when there is room, but do not put it off for ever".
   *
   * It waits for a trailer id from the payloads the page is already prefetching,
   * so nothing is fetched on this account and a visitor who never hovers still
   * pays only for a cued player — no video plays until a card asks (see
   * wantPlayRef).
   */
  useEffect(() => {
    if (bootId !== null) return;
    let release: (() => void) | null = null;
    const claim = () => {
      release = onFirstTrailer((id) => setBootId((cur) => cur ?? id));
    };
    const idle = window.requestIdleCallback;
    if (typeof idle === "function") {
      const handle = idle(claim, { timeout: 3000 });
      return () => {
        window.cancelIdleCallback?.(handle);
        release?.();
      };
    }
    // Safari has no idle callback; a plain delay is the same intent, coarser.
    const timer = setTimeout(claim, 1500);
    return () => {
      clearTimeout(timer);
      release?.();
    };
  }, [bootId]);

  /**
   * Point the player at the newly opened card — or park it when none is open.
   */
  useEffect(() => {
    if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    if (forceTimerRef.current) clearTimeout(forceTimerRef.current);
    shownRef.current = false;
    rewoundRef.current = false;
    setVisible(false);
    setShowControls(false);
    armedRef.current = false;
    originRef.current = null;

    if (!attachment) {
      // Parked: paused rather than left running behind a card nobody is looking
      // at. The next card replaces the video outright, so nothing is lost.
      post("pauseVideo");
      return;
    }

    openedAtRef.current = Date.now();

    if (bootId === null) {
      // Nobody warmed us in time — this card pays the boot, as every card used
      // to. See onFirstTrailer below for the path that normally gets here first.
      loadedIdRef.current = attachment.id;
      setBootId(attachment.id);
      return;
    }

    if (!loadedRef.current) {
      pendingIdRef.current = attachment.id;
    } else if (attachment.id === loadedIdRef.current && !playedRef.current) {
      // The warm boot happens to be cued on exactly this video and has never
      // run: start it rather than reloading it, which would throw away the one
      // video that is already fetched.
      post("mute");
      wantPlayRef.current = true;
    } else {
      loadedIdRef.current = attachment.id;
      /*
       * MUTE FIRST — this is the sound-before-image fix, and it is a fault this
       * design introduced by itself.
       *
       * A player that dies with its card cannot leak anything into the next one.
       * A player that SURVIVES carries the last card's volume, and
       * `loadVideoById` starts playing at once: the new trailer was therefore
       * audible from its first frame while the picture was still hidden waiting
       * for the clock to move. Silence is asserted before every load and lifted
       * again in `reveal`, on the same instant as the picture.
       */
      post("mute");
      // `loadVideoById` starts playing on its own — measured, and the reason
      // there is no play call here. Sending one immediately after would be
      // dropped anyway: the player ignores commands aimed at a video it has not
      // finished loading.
      post("loadVideoById", [attachment.id]);
    }

    /*
     * The two backstops, armed PER CARD rather than once at boot.
     *
     * Armed once, they would only ever have protected the first card — and the
     * failure they exist for (a message that never arrives) is not one that only
     * happens once. Without `autoplay` in the URL a player that is never told to
     * play never plays, so a lost message would leave a card on its banner for
     * good; this file has shipped that failure once already.
     */
    if (wantPlayRef.current) {
      forceTimerRef.current = setTimeout(() => {
        if (playedRef.current) return;
        wantPlayRef.current = false;
        playedRef.current = true;
        post("playVideo");
      }, FORCE_PLAY_MS);
    }
    revealTimerRef.current = setTimeout(reveal, REVEAL_ANYWAY_MS);
  }, [attachment, bootId, post, reveal]);

  /**
   * Draw over the card's video slot, and keep doing so.
   *
   * Measured every frame rather than told once: the card follows the page as it
   * scrolls, and a rectangle sent at open time would need a second update path
   * that could fall out of step with the first. Styles are only written when the
   * numbers actually change, so a still card costs one rect read per frame.
   *
   * BEFORE PAINT, not after — and on the very first card that is not a detail.
   * The iframe is created in the same commit that first gives this box a size;
   * a passive effect would leave it 0 × 0 for a frame, which is exactly when the
   * player measures itself and decides how big to draw its chrome. Sizing it
   * late would hand it the small-player layout we scale ×200 to escape.
   */
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!attachment || !box) return;
    // `bootId` is in the deps and it is NOT decoration. On the very first card
    // this component still returns null when the attachment arrives — the box
    // does not exist yet — so the run that matters is the one AFTER the iframe
    // is born. Without it the first card of the session was measured against
    // nothing, kept a zero-sized player, and showed a black rectangle for ever.
    const el = attachment.el;
    let raf = 0;
    let last = "";
    const tick = () => {
      const r = el.getBoundingClientRect();
      const key = `${r.left}|${r.top}|${r.width}|${r.height}`;
      if (key !== last) {
        last = key;
        box.style.left = `${r.left}px`;
        box.style.top = `${r.top}px`;
        box.style.width = `${r.width}px`;
        box.style.height = `${r.height}px`;
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [attachment, bootId]);

  /**
   * Subscribe to the player's events, then listen.
   *
   * The embed only starts posting once it has received a `listening` message,
   * and it can miss one sent before the frame has finished booting — so it is
   * repeated briefly rather than sent once and hoped for.
   */
  useEffect(() => {
    if (bootId === null) return;

    const onMessage = (e: MessageEvent) => {
      if (e.origin !== ORIGIN) return;
      let data: { event?: string; info?: unknown };
      try {
        data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      if (data?.event === "onError") {
        handlersRef.current?.onHide(true);
        return;
      }
      /*
       * TWO shapes carry the same fact, and only listening for one of them is
       * what made the picture invisible the first time this shipped.
       *
       * `onStateChange` arrives with the state as `info` directly. But the
       * player also volunteers `infoDelivery`, whose `info` is an object with a
       * `playerState` inside — and in practice that is the one that turns up.
       */
      const info = data?.info as
        | { playerState?: unknown; currentTime?: unknown }
        | null
        | undefined;
      const state = data?.event === "onStateChange" ? data.info : info?.playerState;
      const at = info?.currentTime;

      // The boot video is cued, not playing — `autoplay` is deliberately absent
      // from the URL, since a muted player told to play by script is allowed by
      // every autoplay policy and this way a player warmed at idle sits silent
      // and still until a card actually asks for it.
      if (state !== undefined && wantPlayRef.current) {
        wantPlayRef.current = false;
        playedRef.current = true;
        post("playVideo");
      }

      /*
       * THE REVEAL. Wait for the clock to have been at the start of THIS video
       * and then to have moved. Without the rewind half, the previous trailer's
       * clock — still being reported while the new one loads — answers for the
       * new one instantly, and the banner lifts on a video that has not arrived.
       * That is not a hypothetical: it is what made the first measurement of
       * this behaviour read 2 ms.
       */
      if (typeof at === "number") {
        if (at < REWOUND) rewoundRef.current = true;
        else if (rewoundRef.current && at > ADVANCED) reveal();
      }

      if (state === undefined) return;
      if (state === PLAYING) setPaused(false);
      else if (state === PAUSED) {
        setPaused(true);
        if (shownRef.current) handlersRef.current?.onPlaying(false);
      }
    };

    window.addEventListener("message", onMessage);
    const handshake = setInterval(() => {
      if (!loadedRef.current) return;
      // The API's own shape: `id` and `channel` alongside the event. A bare
      // `{event:"listening"}` is accepted by some builds and ignored by others.
      frameRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "listening", id: 1, channel: "widget" }),
        ORIGIN,
      );
    }, 150);
    const stopHandshake = setTimeout(() => clearInterval(handshake), 4000);

    return () => {
      window.removeEventListener("message", onMessage);
      clearInterval(handshake);
      clearTimeout(stopHandshake);
    };
  }, [bootId, post, reveal]);

  useEffect(
    () => () => {
      if (idleRef.current) clearTimeout(idleRef.current);
      if (volCloseRef.current) clearTimeout(volCloseRef.current);
      if (settleRef.current) clearTimeout(settleRef.current);
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
      if (forceTimerRef.current) clearTimeout(forceTimerRef.current);
    },
    [],
  );

  const applyMuted = (next: boolean) => {
    wantMutedRef.current = next;
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

  /*
   * The card opens UNDER the pointer, so movement only means intent once the
   * hand has come to rest. The events arrive on the CARD, not here — this layer
   * is pointer-transparent so that hovering the picture is still hovering the
   * card — and PreviewCard forwards them.
   */
  const wake = useCallback((e: { clientX: number; clientY: number }) => {
    if (Date.now() - openedAtRef.current < OPEN_GRACE_MS) return;
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
  }, []);

  const sleep = useCallback(() => {
    if (idleRef.current) clearTimeout(idleRef.current);
    if (settleRef.current) clearTimeout(settleRef.current);
    armedRef.current = false;
    originRef.current = null;
    setShowControls(false);
  }, []);

  // The card drives the controls' visibility, since the pointer is over IT.
  useEffect(() => {
    stageWake = wake;
    stageSleep = sleep;
  }, [wake, sleep]);

  /**
   * `loop` needs `playlist` set to the same id — but a preview is a few seconds
   * of moving artwork that nobody watches to the end, and a playlist costs the
   * player an extra load. Neither is asked for. `enablejsapi` is what makes the
   * buttons below possible.
   *
   * `cc_load_policy=0` asks for captions off. It is a REQUEST, not a guarantee:
   * a viewer whose YouTube account forces captions on gets them anyway, which is
   * why the captions module is also unloaded over the API once the player
   * answers.
   */
  const src =
    bootId === null
      ? undefined
      : `${ORIGIN}/embed/${bootId}` +
        `?enablejsapi=1&controls=0&mute=1&playsinline=1&rel=0` +
        `&iv_load_policy=3&disablekb=1&fs=0&cc_load_policy=0`;

  const controlsVisible = visible && (showControls || volOpen);
  const chrome = `transition-opacity duration-200 ${
    controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
  }`;
  /*
   * `pointer-events` is INHERITED, so a control inside this pointer-transparent
   * layer is dead until it takes the pointer back — which is why the buttons
   * need this and the scrim deliberately does not. A scrim that took the pointer
   * would cover the whole picture and cut the card off from the movement that
   * wakes the controls in the first place.
   */
  const chromeUI = `${chrome} ${controlsVisible ? "pointer-events-auto" : ""}`;

  if (src === undefined) return null;

  return (
    <div
      ref={boxRef}
      // Marked as part of the preview so that reaching for a control is not read
      // as leaving the card — the provider closes on any pointerover outside.
      data-preview-popup=""
      /*
       * Pointer-TRANSPARENT, deliberately. The card underneath must keep
       * receiving the hover, or the provider would think the pointer had left
       * and close it. Only the controls take the pointer back, and only while
       * they are shown.
       */
      className="pointer-events-none fixed z-[81] overflow-hidden"
      style={{
        borderRadius: RADIUS,
        /*
         * Position and size are written by the layout effect, NOT here — React
         * would otherwise reassert them on every render and undo the follow.
         *
         * Parked, this keeps the size of the last card it drew rather than
         * collapsing to nothing: a player resized to 0 × 0 re-measures itself,
         * and the layout it would pick is the small-player one that SCALE exists
         * to escape. Invisible and pointer-transparent is enough. `display:none`
         * for the same reason is worse still — a detached iframe can be dropped
         * by the browser, and this one staying alive IS the feature.
         */
        opacity: visible && attachment ? 1 : 0,
        /*
         * Short, because this fade is the last of the sound-before-image gap.
         * Sound and picture are released on the same instant, but a 300 ms
         * dissolve means the ear gets a finished trailer while the eye is still
         * being handed one. Long enough not to be a hard cut, short enough that
         * they arrive together.
         */
        transition: "opacity 140ms",
      }}
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
         * preview scaled ×200 wants it to be able to do.
         */
        allow="autoplay; encrypted-media; compute-pressure"
        // Sized in PERCENT, not pixels, so the factor holds whatever the card's
        // real width turns out to be: 20000 % of the box, scaled back by 1/200,
        // lands on the box again — times OVERSCAN, which is what makes it cover
        // rather than fit. The negative offsets re-centre that overflow.
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
           * Captions off, for real this time. `cc_load_policy=0` in the URL is a
           * preference the player is free to override, and it does: auto-generated
           * tracks turned up on the card anyway. Unloading the module is the
           * instruction it cannot reinterpret.
           */
          post("unloadModule", ["captions"]);
          post("unloadModule", ["cc"]);
          // A card claimed the stage while the frame was still booting.
          const pending = pendingIdRef.current;
          if (!pending) return;
          pendingIdRef.current = null;
          post("mute");
          if (pending === loadedIdRef.current) {
            // It wants the video we were born with: start it, don't reload it.
            wantPlayRef.current = true;
          } else {
            loadedIdRef.current = pending;
            post("loadVideoById", [pending]);
          }
        }}
        className="pointer-events-none"
      />

      {/* Scrim so the icons stay legible over a bright frame. */}
      <div
        aria-hidden
        className={`absolute inset-0 bg-gradient-to-b from-black/45 via-transparent to-transparent ${chrome}`}
      />

      {/* `onPointerMove` here as well as on the card: while the pointer is over
          a control it is no longer over the card, so without this the control
          under the hand would fade out from under it. */}
      <div className={`absolute left-2 top-2 ${chromeUI}`} onPointerMove={wake}>
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
        className={`absolute right-2 top-2 flex flex-col items-center ${chromeUI}`}
        onPointerMove={wake}
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

/*
 * The card's pointer, handed to the stage.
 *
 * Module-level rather than a context: the card that reports the movement and the
 * stage that reacts to it are siblings under different portals, and threading a
 * provider through both to carry two functions that only ever have one owner
 * would be more machinery than the fact deserves.
 */
let stageWake: ((e: { clientX: number; clientY: number }) => void) | null = null;
let stageSleep: (() => void) | null = null;
export function stagePointerMove(e: { clientX: number; clientY: number }) {
  stageWake?.(e);
}
export function stagePointerLeave() {
  stageSleep?.();
}
