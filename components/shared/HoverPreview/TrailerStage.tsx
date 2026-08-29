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
import { useDataSaver } from "@/lib/prefs/dataSaver";
import { onFirstTrailer } from "@/lib/preview/previewStore";
import { detectBars, peekBars, type TrailerBars } from "@/lib/preview/trailerBars";
import { isFatalTrailerError, markTrailerBlocked } from "@/lib/preview/trailerBlocked";
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
 * real pixel size. The bench that produced those counts lived in public/ and has
 * been removed — next-pwa precaches everything there, so every visitor was
 * downloading it. It is in the history if it is ever needed again (see the
 * DEVLOG entry of 2026-08-15); the numbers it established are above.
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
 * A ceiling on the crop, however convincing the measurement.
 *
 * Past this the picture is being destroyed to hide a border, and a wrong
 * measurement should cost a black edge rather than a trailer shown at double
 * size. 1.6 clears the two shapes that actually turn up — 4:3 in 16:9 needs
 * 1.333, a windowed master a little more — with room to spare.
 */
const MAX_ZOOM = 1.6;

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

/** YouTube's player states. ENDED matters only to stop the clock below. */
const PLAYING = 1;
const PAUSED = 2;
const ENDED = 0;

/**
 * THE AMBIENT LIGHT IS A SECOND PLAYER, and the idea is Hayase's (see
 * hayase-app/interface, ui/cards/YoutubeIframe.svelte). It is worth spelling out
 * because this file spent a long time trying to solve the wrong problem.
 *
 * We could not read the trailer's pixels: the embed is cross-origin, so
 * `drawImage(iframe)` does not exist and there is nothing to sample — which is
 * why the glow fell back to the three published stills, and why it could not
 * follow the picture. All of that took "the light must be COMPUTED from the
 * video" for granted.
 *
 * It does not have to be. A blurred copy of the video IS the light. Mount the
 * same embed a second time behind the card, blur it into oblivion, over-saturate
 * it, and every frame lights the card by itself — no pixel is ever read, so the
 * cross-origin rule has nothing to say about it.
 *
 * WHAT IT COSTS, honestly: a second decoder and a second stream of the same
 * video. That is why it is skipped under Data Saver, the same preference that
 * already turns off the watch player's ambient sampling.
 *
 * WHAT IT GIVES UP: the two players have their own clocks, so they drift by a
 * fraction of a second. Through a 34 px blur that is invisible — the light is a
 * colour, not a picture.
 */
const MIRRORED = new Set([
  "loadVideoById",
  "playVideo",
  "pauseVideo",
  "seekTo",
  // Captions too: a subtitle band is a bright white bar across the bottom of
  // the picture, and through the blur it becomes a glowing smear that belongs
  // to no scene.
  "unloadModule",
  "setOption",
]);
/**
 * How far the two players may drift before the glow is pulled back into line.
 *
 * MEASURED, because the first version of this trusted one command to do it. On
 * the first card the two clocks sit within ±0.08 s of each other for as long as
 * you like — but a card SWITCH left the glow 0.35 to 0.67 s ahead, every time
 * and for good. The reveal seeks the visible player back to zero; the copy is
 * still loading the new video at that instant and drops the seek, as the player
 * drops anything aimed at a video it has not finished loading. It then stays
 * ahead by exactly what the other one rewound.
 *
 * Half a second is not subtle: at a cut, the light changes before the picture
 * does. So the offset is not assumed away, it is watched and corrected.
 *
 * The threshold is what keeps that correction rare. Each one is a seek, and a
 * seek darkens the halo for an instant while the copy rebuffers — worth paying
 * once after a switch, not every few seconds over jitter that nobody can see.
 */
const SYNC_TOLERANCE_S = 0.3;
/** And never two corrections in a row without giving the first one time to land. */
const SYNC_COOLDOWN_MS = 2500;

/**
 * The head start the copy is given, in seconds.
 *
 * MEASURED, and only measurable once the capture method was fixed: a screenshot
 * taken with a `clip` does not composite a CSS filter over a cross-origin
 * iframe — it hands back the raw player — so every earlier reading of the halo
 * was of the video itself, and dutifully reported no lag at all. Taken full
 * page, where the filter is really applied, the cross-correlation between the
 * picture's changes and the halo's peaks one sample late and nowhere else:
 * 0.0069 against 0.0009 everywhere around it, at 51 ms per sample.
 *
 * WHERE IT COMES FROM. Not the clocks — those hold to ±0.05 s. It is the second
 * player's own pipeline: its frames go through a blur pass before they reach the
 * screen, and that pass costs a compositor frame the visible copy does not pay.
 *
 * So the copy is set slightly ahead, and its light lands with the picture rather
 * than after it.
 *
 * HOW BIG, AND WHY NO SMALLER FIGURE IS CLAIMED. Three runs:
 *
 *     no lead   peak at +1 sample  (halo late)
 *     50 ms     peak at -1 sample  (halo early)
 *     25 ms     peak at -1 sample  (unchanged)
 *
 * Halving the lead did not move the peak, which is the instrument saying it has
 * run out of resolution: its step is 50 ms, and past this the number cannot be
 * refined by this method — only the SIGN of the error was ever reliable, and it
 * has flipped. What is honest to state is |lag| <= 50 ms, against a video frame
 * that is itself 33 to 42 ms long. Tuning further would be fitting noise.
 *
 * 25 ms is kept rather than 50 because it is the smaller of the two settings
 * that measure the same, and because a light very slightly ahead of a cut reads
 * as the cut while one behind it reads as a fault.
 */
const GLOW_LEAD_S = 0.025;

/** Blur radius of the glow copy. The card's own stack used the same figure. */
const GLOW_BLUR_PX = 34;
/** How far past the video's box the glow copy is drawn, so light escapes it. */
const GLOW_SPREAD = 1.3;
/**
 * NO BRIGHTNESS HERE, and the reason is a bug this file shipped.
 *
 * A `brightness()` was added to make the halo denser, on the argument that the
 * old five-layer stack piled up ~2.15 of opacity and that a multiply was the
 * faithful way to reproduce it. That argument is wrong twice. Stacking
 * translucent copies of one picture CONVERGES to that picture — alpha
 * compositing an image over itself returns the image — so the stack never
 * exceeded the video's own colours; it only made the light more opaque against
 * the page. And a multiply clips: orange (255,140,0) at ×1.7 becomes
 * (255,238,0), which is yellow. Reported from the real card, on a BLEACH title
 * card that is orange on screen and was lighting the page yellow, and on a blue
 * shot whose halo came out several shades too light.
 *
 * So the filter is the watch player's, exactly (see LiveAmbient in
 * UniversalPlayer): blur and saturation, nothing that can move a hue. Density,
 * if it is ever wanted again, comes from coverage — a wider spread, a larger
 * copy — never from a channel multiply.
 */

/**
 * How often the glow is told where the trailer is.
 *
 * Fast enough that the light drifts rather than steps — the ambient recomposes
 * every 120 ms and can only be as smooth as what it is told — and slow enough
 * that it is not a per-frame re-render of the open card.
 */
const PROGRESS_TICK_MS = 200;
/**
 * Seconds for the glow to walk the trailer's three stills end to end.
 *
 * It then turns round and walks back, so the light never arrives anywhere and
 * stops. Slow enough to read as light drifting rather than as an effect
 * cycling; fast enough that the first few seconds of a hover — which is all
 * most of them are — visibly move.
 */
const GLOW_SWEEP_S = 9;

export default function TrailerStage() {
  const attachment = useSyncExternalStore(subscribeStage, getStage, () => null);
  /**
   * No second decoder on a device whose owner asked us to spare it.
   *
   * The same preference already turns off the watch player's ambient sampling,
   * so "Data Saver means no ambient light" is a rule the app already has. The
   * card is not left dark: PreviewCard falls back to the storyboard glow, which
   * costs three 4 KB JPEGs it has already fetched to measure the black bars.
   */
  const dataSaver = useDataSaver();

  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  /** The blurred copy of the player that lights the card. See the render. */
  const glowBoxRef = useRef<HTMLDivElement>(null);
  const glowFrameRef = useRef<HTMLIFrameElement>(null);
  const glowLoadedRef = useRef(false);
  /** The copy's own clock, read the same way as the visible player's. */
  const glowAtRef = useRef(0);
  const glowSeenRef = useRef(0);
  /** When the copy was last pulled back into line. See SYNC_COOLDOWN_MS. */
  const lastSyncRef = useRef(0);
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const volCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  /** Dernieres coordonnees VUES, pour distinguer un geste d'un decor qui bouge. */
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
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
   * The cursor is shown again, on its own clock.
   *
   * SEPARATE FROM THE CONTROLS on purpose. Scrolling has to bring the pointer
   * back — the page is moving under it and the visitor needs to see where they
   * are — but it must NOT summon the buttons: a pointer resting on a scrolling
   * page emits movement it never made, which is the whole reason MOVE_SLOP
   * exists. Two questions, two answers.
   */
  const [cursorOn, setCursorOn] = useState(false);
  const cursorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Baked-in black bars in THIS trailer, if it has any. See trailerBars.ts. */
  const [bars, setBars] = useState<TrailerBars>({ tb: 0, lr: 0 });

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
  /**
   * The last position the player reported, and the instant we heard it.
   *
   * Kept as a PAIR because the second half is what makes the glow move. The
   * player's updates are not a metronome — they arrive when it feels like it,
   * and after a load it can go quiet for seconds at a time — so a light driven
   * message by message stops dead between them. With the timestamp beside it,
   * the position at any moment is arithmetic (see the ticker below) and the
   * messages become corrections rather than the only source of motion.
   */
  const atRef = useRef(0);
  const atSeenRef = useRef(0);
  /** Is the picture actually advancing — i.e. may the extrapolation run. */
  const runningRef = useRef(false);
  /** Seen the clock at the start of the CURRENT video — see ADVANCED. */
  const rewoundRef = useRef(false);
  /** Already revealed for the current attachment. */
  const shownRef = useRef(false);
  /**
   * Has the player ever spoken to us.
   *
   * The difference between "not awake yet" and "awake but stopped": a command
   * sent to the first is dropped, a command sent to the second is obeyed. Only
   * the first is worth deferring for.
   */
  const aliveRef = useRef(false);
  /** Handlers of the live attachment, read from inside the message listener. */
  const handlersRef = useRef(attachment?.handlers ?? null);
  handlersRef.current = attachment?.handlers ?? null;
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Has THIS card already been given a second load. See the backstop. */
  const retriedRef = useRef(false);

  /**
   * Fire a command at the player.
   *
   * Guarded on the frame having LOADED, not merely existing. A fresh iframe's
   * contentWindow is still about:blank on our own origin, so posting to it with
   * YouTube's origin as the target throws "The target origin provided does not
   * match the recipient window's origin".
   */
  /** The same, aimed at the glow copy alone — used to re-align it. */
  const postGlow = useCallback((func: string, args: unknown[] = []) => {
    if (!glowLoadedRef.current) return;
    glowFrameRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func, args }),
      ORIGIN,
    );
  }, []);

  const post = useCallback((func: string, args: unknown[] = []) => {
    if (!loadedRef.current) return;
    frameRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func, args }),
      ORIGIN,
    );
    /*
     * Transport commands go to BOTH players — see the glow frame below.
     *
     * Only these four. Sound is emphatically not mirrored: the second player
     * exists to be looked at through a heavy blur and must never be heard, and
     * it is born muted so there is nothing to undo.
     */
    if (glowLoadedRef.current && MIRRORED.has(func)) {
      postGlow(func, args);
    }
  }, []);

  /**
   * Ask both players to start reporting.
   *
   * The embed says nothing until it has received a `listening`, and it can miss
   * one sent while it is still booting — so this is repeated rather than sent
   * once, both at boot and again on every card (see the two effects below).
   */
  const subscribe = useCallback(() => {
    // The API's own shape: `id` and `channel` alongside the event. A bare
    // `{event:"listening"}` is accepted by some builds and ignored by others.
    const msg = JSON.stringify({ event: "listening", id: 1, channel: "widget" });
    if (loadedRef.current) frameRef.current?.contentWindow?.postMessage(msg, ORIGIN);
    // The copy is subscribed as well, and only for its clock: a player that is
    // never asked to speak reports nothing, and an unmeasured drift is one that
    // cannot be corrected.
    if (glowLoadedRef.current) glowFrameRef.current?.contentWindow?.postMessage(msg, ORIGIN);
  }, []);

  /**
   * Captions off — ONCE PER VIDEO, not once per session.
   *
   * That distinction is the bug. `cc_load_policy=0` in the URL is a request the
   * player is free to override, and it does; unloading the module answers that,
   * but it was done a single time, in the iframe's `onLoad`. Every card after
   * the first arrives by `loadVideoById`, and a new video builds itself a new
   * captions module — so the subtitles came back on every trailer but the one
   * the player happened to boot on.
   *
   * Both spellings and both instructions, because which of them a given build
   * obeys is not something to find out one deploy at a time: `unloadModule`
   * takes the feature away, `setOption(track, {})` selects no track for the
   * builds that keep it.
   */
  const silenceCaptions = useCallback(() => {
    post("unloadModule", ["captions"]);
    post("unloadModule", ["cc"]);
    post("setOption", ["captions", "track", {}]);
    post("setOption", ["cc", "track", {}]);
  }, [post]);

  const reveal = useCallback(() => {
    if (shownRef.current) return;
    shownRef.current = true;
    // The video is up and its modules exist: this is the moment the answer
    // sticks, and it is per showing, so no trailer escapes it.
    silenceCaptions();
    /*
     * BACK TO THE BEGINNING — the price of waiting for proof, refunded.
     *
     * The reveal waits for the clock to move, because a clock that moves is the
     * only honest evidence that the player has finished laying itself out. But
     * the video has been RUNNING during that wait, hidden: whatever it took to
     * get here — the load, the first frames, a slow tick of the player's own
     * reporting — was played to nobody, and the trailer opened somewhere in its
     * second second.
     *
     * The seek costs nothing to fetch: those seconds are the ones already in the
     * buffer, which is exactly why this is done at the reveal rather than by
     * starting later. The trailer is watched from its first frame again.
     */
    post("seekTo", [0, true]);
    /*
     * The copy is sent to the same place, plus its head start — and separately,
     * because the mirrored seek above may not survive: a player still finishing
     * a load drops what is aimed at it, which is exactly how the copy used to
     * end up half a second ahead. Sent here rather than a moment later so its
     * rebuffer happens while the layer is still fading in, where nobody sees it.
     */
    postGlow("seekTo", [GLOW_LEAD_S, true]);
    // The clock is back at zero as of NOW, and the ticker must not spend the
    // next message-less second extrapolating from the position the seek just
    // threw away — which is the whole of the trailer's hidden head start.
    atRef.current = 0;
    atSeenRef.current = performance.now();
    runningRef.current = true;
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
  }, [post, postGlow, silenceCaptions]);

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
    atRef.current = 0;
    atSeenRef.current = 0;
    runningRef.current = false;
    glowAtRef.current = 0;
    glowSeenRef.current = 0;
    lastSyncRef.current = 0;
    setVisible(false);
    // The button must not open on the pause icon because the LAST card was left
    // paused — the state belongs to the showing, not to the player.
    setPaused(false);
    setShowControls(false);
    setCursorOn(false);
    originRef.current = null;
    lastPointRef.current = null;

    if (!attachment) {
      // Parked: paused rather than left running behind a card nobody is looking
      // at. The next card replaces the video outright, so nothing is lost.
      post("pauseVideo");
      return;
    }

    openedAtRef.current = Date.now();

    /*
     * Ask what this trailer's own black bars are, if any.
     *
     * Started here rather than at reveal so it races the ~800 ms the video takes
     * to start: three 4 KB images off a host we already preconnect nearly always
     * land first, and the frame is shown already cropped. `peekBars` fills in
     * synchronously for a trailer seen before, so a second hover never re-crops
     * in front of the viewer.
     */
    setBars(peekBars(attachment.id));
    const wanted = attachment.id;
    void detectBars(wanted).then((b) => {
      // The pointer may have moved on to another card while those loaded.
      if (getStage()?.id !== wanted) return;
      /*
       * Too late to crop THIS showing, and that is deliberate. Changing the
       * player's size resizes a ×200 iframe and makes it lay itself out again;
       * doing that under a trailer the visitor is already watching trades a
       * black edge for a jolt in the middle of the picture. The answer is
       * cached, so the next hover on this trailer is cropped from the start.
       */
      if (shownRef.current) return;
      setBars(b);
    });

    if (bootId === null) {
      // Nobody warmed us in time — this card pays the boot, as every card used
      // to. See onFirstTrailer below for the path that normally gets here first.
      loadedIdRef.current = attachment.id;
      setBootId(attachment.id);
      return;
    }

    if (!loadedRef.current) {
      pendingIdRef.current = attachment.id;
    } else if (attachment.id === loadedIdRef.current) {
      /*
       * The player is already on this video: start it where it stands rather
       * than reloading, which would throw away the one video already fetched.
       *
       * AND IT IS PROBABLY PAUSED, which is the whole of a reported bug. Every
       * close parks the player with `pauseVideo`, and the viewer can pause it
       * themselves; coming back to the same card therefore lands on a stopped
       * player. Two things then went wrong at once, and both are asked for
       * here instead of being waited for:
       *
       *  - The play was deferred to the next message from the player, which
       *    only ever helps a player still waking up. A paused, idle one says
       *    nothing at all, so nothing arrived to trigger it and the trailer sat
       *    there until the 1.8 s backstop fired.
       *  - The reveal waits for the clock to be seen at the START of the video
       *    and then to move. Resumed at eight seconds in, that proof can never
       *    be met, so the picture stayed hidden behind the banner for the full
       *    4 s of the other backstop. Measured on dev, both delays in series.
       *
       * Seeking to zero is not a workaround for the second: the reveal seeks
       * there anyway, on purpose (see `reveal`), so the trailer is meant to be
       * watched from its first frame. Doing it now simply makes the rewind real
       * before the proof is asked for.
       */
      post("mute");
      if (aliveRef.current) {
        playedRef.current = true;
        post("seekTo", [0, true]);
        post("playVideo");
      } else {
        // Still booting: a command now would be dropped, so the first message
        // it sends carries the play instead.
        wantPlayRef.current = true;
      }
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
    /*
     * AND THE REVEAL BACKSTOP IS NOT A BLIND REVEAL — that is the black card.
     *
     * It used to be `setTimeout(reveal, …)` flat, on the reading that a missing
     * message is the only thing that can keep the picture hidden. It is not: a
     * load can simply be LOST. `loadVideoById` aimed at a player still finishing
     * the previous card's load is dropped — the same rule that made the glow run
     * half a second ahead — and a sweep across a carousel hands the player a new
     * id every few hundred milliseconds. Nothing then plays, no clock is ever
     * reported, and four seconds later this timer lifted the banner off a player
     * showing nothing at all: the black rectangle reported on the card, which
     * only went away by hovering again until one load survived.
     *
     * So the timer asks first WHETHER anything is playing. No position at all
     * means the video never arrived: reveal nothing, ask for it again, and if
     * the second attempt is just as silent give the card its artwork back rather
     * than a black hole.
     *
     * A REPORTED POSITION IS NOT ENOUGH, and that is the case this cost us. The
     * test used to be "any position at all", on the reading that the picture is
     * there and only the proof is missing. A video that cannot be played HERE —
     * geo-blocked, embedding refused — reports `currentTime: 0` quite happily
     * and then stays at 0 for ever: proof of a player, not of a picture. Four
     * seconds later this lifted the banner off a black rectangle, which is
     * exactly what Prison School shows in France. So the clock has to have
     * MOVED: zero is the number a video that never started reports.
     */
    retriedRef.current = false;
    const backstop = () => {
      // Already showing: this timer is not cleared by a successful reveal, and
      // the reveal rewinds the clock to zero. Without this line, a trailer that
      // was revealed a moment before the four seconds are up would read as
      // "never started" under the stricter test below and be RELOADED under the
      // viewer — the one regression a tighter rule could introduce here.
      if (shownRef.current) return;
      if (atSeenRef.current && atRef.current > ADVANCED) {
        reveal();
        return;
      }
      const id = loadedIdRef.current;
      if (!retriedRef.current && id) {
        retriedRef.current = true;
        post("mute");
        post("loadVideoById", [id]);
        revealTimerRef.current = setTimeout(backstop, REVEAL_ANYWAY_MS);
        return;
      }
      // Out of ideas, and the banner is still up: leave it up. `onHide` releases
      // the stage, so the player is parked instead of sitting behind the card
      // playing to nobody.
      handlersRef.current?.onHide(true);
    };
    revealTimerRef.current = setTimeout(backstop, REVEAL_ANYWAY_MS);
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
        // The glow copy follows the same slot, drawn larger about its centre:
        // a light source exactly the size of the card cannot spill past it.
        const glow = glowBoxRef.current;
        if (glow) {
          const dx = (r.width * (GLOW_SPREAD - 1)) / 2;
          const dy = (r.height * (GLOW_SPREAD - 1)) / 2;
          glow.style.left = `${r.left - dx}px`;
          glow.style.top = `${r.top - dy}px`;
          glow.style.width = `${r.width * GLOW_SPREAD}px`;
          glow.style.height = `${r.height * GLOW_SPREAD}px`;
        }
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
      /*
       * The copy speaks too, and it is answering a different question.
       *
       * Its messages say nothing about the card — it has no controls, no
       * reveal, no error to report that the visible player will not report
       * first. The one thing worth having is its clock, which is what makes the
       * drift measurable instead of assumed. So it is taken and the message
       * goes no further; letting it fall through would have the copy's position
       * driving the reveal of the picture.
       */
      if (e.source === glowFrameRef.current?.contentWindow) {
        const t = (data?.info as { currentTime?: unknown } | null | undefined)?.currentTime;
        if (typeof t === "number") {
          glowAtRef.current = t;
          glowSeenRef.current = performance.now();
        }
        return;
      }
      // Anything at all from the player means it is past its boot and will obey
      // a command sent right now. See the attach effect.
      aliveRef.current = true;
      /*
       * The player says this video cannot be watched HERE.
       *
       * Written down for the session, not just acted on: without the memory the
       * card mounts the player, learns it is blocked, hides — and repeats the
       * whole performance on the next hover, for ever. Only the codes that mean
       * a durable refusal count; see trailerBlocked.ts.
       */
      if (data?.event === "onError") {
        const code = data.info;
        if (isFatalTrailerError(code)) markTrailerBlocked(loadedIdRef.current ?? "");
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
        atRef.current = at;
        atSeenRef.current = performance.now();
        if (at < REWOUND) rewoundRef.current = true;
        else if (rewoundRef.current && at > ADVANCED) reveal();
      }

      /*
       * The video's LENGTH is deliberately not read any more. It was only ever
       * the denominator of `currentTime / duration`, and nothing needs that
       * ratio now that the glow sweeps on its own clock (see the ticker below).
       * Probed on dev: both numbers arrive perfectly well and continuously —
       * they were never the fault.
       */

      if (state === undefined) return;
      if (state === PLAYING) {
        setPaused(false);
        /*
         * SAID AGAIN, not just recorded locally — and its absence is what froze
         * the ambient light.
         *
         * `onPlaying(true)` was sent exactly once, from `reveal`. `false` on the
         * other hand is sent on every PAUSED the player reports — and it reports
         * one for things the viewer never did: the seek back to 0 that the
         * reveal performs, a buffering hiccup, a quality switch. Nothing ever
         * put the card back into the playing state, so a single blip left it
         * believing the trailer had stopped while the picture ran on.
         *
         * The card's transport state is what mounts the glow's blend loop (see
         * TrailerAmbient): torn down there, it is never rebuilt, and the light
         * holds whichever still was last composed for the rest of the trailer.
         * A pause SHOULD freeze the light — that part is deliberate — which is
         * why a resume has to unfreeze it.
         *
         * Guarded on `shownRef`, like the `false` below: the card hides its
         * banner while `playing`, so claiming it before the frame is revealed
         * would leave a blank card for as long as the reveal takes.
         */
        if (shownRef.current) handlersRef.current?.onPlaying(true);
        // The picture is moving, so the local clock may run between messages.
        runningRef.current = true;
      } else if (state === PAUSED) {
        setPaused(true);
        if (shownRef.current) handlersRef.current?.onPlaying(false);
        runningRef.current = false;
      } else if (state === ENDED) {
        // The position stops here rather than being extrapolated past the end.
        runningRef.current = false;
      }
    };

    window.addEventListener("message", onMessage);
    const handshake = setInterval(subscribe, 150);
    const stopHandshake = setTimeout(() => clearInterval(handshake), 4000);

    return () => {
      window.removeEventListener("message", onMessage);
      clearInterval(handshake);
      clearTimeout(stopHandshake);
    };
  }, [bootId, post, reveal, subscribe]);

  /**
   * AND AGAIN ON EVERY CARD, because the boot handshake expires.
   *
   * It stops after four seconds, which covers the player waking up and nothing
   * else. If the frame is still loading when it stops — a cold cache, a slow
   * network, an idle boot that lost the race — the player is never told to
   * report, and it then stays silent for the WHOLE session: commands still work,
   * so the video plays, but no `currentTime` ever arrives, the reveal has no
   * proof to wait for, and every card falls through to the backstop above. One
   * lost message at boot should not cost the session its trailers.
   *
   * Two seconds per card, which is inside the ~800 ms the video takes to start
   * and cheap: an already-subscribed player answers a second `listening` by
   * re-sending what it would have sent anyway.
   */
  useEffect(() => {
    if (!attachment) return;
    subscribe();
    const again = setInterval(subscribe, 200);
    const stop = setTimeout(() => clearInterval(again), 2000);
    return () => {
      clearInterval(again);
      clearTimeout(stop);
    };
  }, [attachment, subscribe]);

  /**
   * WHERE THE TRAILER IS, ON OUR OWN CLOCK — the glow's only source of motion.
   *
   * WHY THE MESSAGES ARE NOT ENOUGH, which is the mistake this replaces. The
   * position used to be forwarded straight from the player's updates, on the
   * assumption that they tick. They do not, reliably: the embed volunteers a
   * position when it feels like it, goes quiet for long stretches after a load,
   * and can spend a whole short trailer without announcing its length at all.
   * A light relayed from that stream lit one still and held it — exactly the
   * complaint. Here the messages only ever CORRECT `atRef`; the movement in
   * between is arithmetic on a timestamp, so a silent player costs accuracy,
   * never motion.
   *
   * AND IT ASKS AGAIN FOR THE LENGTH. `listening` is what makes the embed
   * answer with `initialDelivery`, the message a bare `duration` rides on. The
   * boot handshake stops after four seconds — long before a card that opens a
   * minute later loads its own video.
   */
  useEffect(() => {
    if (!attachment) return;
    const timer = setInterval(() => {
      // The same proof the reveal waits for: until the clock has been seen at
      // the start of THIS video, the position still belongs to the previous
      // one — and a sweep started from the middle of nowhere is a jump.
      if (!shownRef.current || !rewoundRef.current) return;
      const now = performance.now();
      const elapsed = runningRef.current ? (now - atSeenRef.current) / 1000 : 0;
      const t = atRef.current + elapsed;

      /*
       * Pull the light back onto the picture when it has slipped.
       *
       * Both positions are extrapolated the same way, so what is compared is
       * two clocks and not two message arrival times — otherwise the jitter
       * between updates would look like drift and this would seek for ever.
       */
      if (runningRef.current && glowSeenRef.current && now - lastSyncRef.current > SYNC_COOLDOWN_MS) {
        const glowT = glowAtRef.current + (now - glowSeenRef.current) / 1000;
        // Against the head start, not against zero: the copy is meant to run
        // GLOW_LEAD_S ahead, so that is the offset being held, and a correction
        // that put it back level would reintroduce the very lag it exists for.
        if (Math.abs(glowT - t - GLOW_LEAD_S) > SYNC_TOLERANCE_S) {
          lastSyncRef.current = now;
          postGlow("seekTo", [Math.max(0, t + GLOW_LEAD_S), true]);
        }
      }
      /*
       * A TRIANGLE, NOT THE PLAYHEAD — measured, and the correction is the whole
       * point of this file's last three attempts.
       *
       * The card used to send `t / duration`, on the reading that the three
       * stills sit at 1/6, 3/6 and 5/6 of the video and the light should stand
       * where the picture stands. That is true and it is useless: trailers run
       * one to three minutes and a hover lasts ten to thirty seconds. Probed on
       * dev against a 129 s trailer, twenty-five seconds of hovering moved the
       * fraction from 0.002 to 0.19 — the whole visit spent below 1/6, which is
       * the region where the blend is 100 % of the first still. The light was
       * not stuck by a bug, it was standing still by construction.
       *
       * And there is no fourth frame to fix it with: mq4 answers 404 and the
       * real storyboard sheets under i.ytimg.com/sb/ answer 403 without the
       * player's token (both checked, again). Three stills is the ceiling.
       *
       * So the sweep is given its own clock and walks the three of them back and
       * forth. What is lost is the claim that the glow stands where the playhead
       * stands — a claim it could not honour anyway at this scale. What is kept
       * is that every colour on screen is one the trailer really contains, and
       * that the light never stops moving while the picture does not.
       */
      const cycle = (t / GLOW_SWEEP_S) % 2;
      handlersRef.current?.onProgress(cycle > 1 ? 2 - cycle : cycle);
    }, PROGRESS_TICK_MS);
    return () => clearInterval(timer);
  }, [attachment, postGlow]);

  useEffect(
    () => () => {
      if (idleRef.current) clearTimeout(idleRef.current);
      if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current);
      if (volCloseRef.current) clearTimeout(volCloseRef.current);
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
    // The local clock follows the button for the same reason the icon does: the
    // player's confirmation is a round trip, and until it lands the glow would
    // otherwise keep drifting through a trailer that has stopped.
    if (paused) {
      post("playVideo");
      setPaused(false);
      atSeenRef.current = performance.now();
      runningRef.current = true;
    } else {
      post("pauseVideo");
      setPaused(true);
      runningRef.current = false;
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

  const showCursor = useCallback(() => {
    setCursorOn(true);
    if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current);
    cursorTimerRef.current = setTimeout(() => setCursorOn(false), IDLE_MS);
  }, []);

  /**
   * The rule: nothing on arrival, both controls as soon as the hand moves.
   *
   * WHAT WAS WRONG BEFORE, because it is worth not rebuilding. This used to
   * demand that the pointer come to REST for 400 ms before movement counted as
   * intent — a rule copied from the code that decides whether to open a card at
   * all, where it is right. Here it was self-defeating: the card opens BECAUSE
   * the pointer stopped, so no `pointermove` arrives to start that countdown,
   * and once the visitor did move, every further move pushed the countdown back
   * another 400 ms. The controls could only appear if you stopped a second time.
   * They almost never appeared.
   *
   * So there is no arming phase. There is a grace period in which the picture is
   * left alone, and after it the first real displacement shows the controls.
   * `MOVE_SLOP` is the only thing still filtered out: a pointer sitting on a
   * scrolling page emits movement it did not make.
   */
  const wake = useCallback((e: { clientX: number; clientY: number }) => {
    if (Date.now() - openedAtRef.current < OPEN_GRACE_MS) return;
    /*
     * Un `pointermove` ne prouve pas qu'une main a bouge.
     *
     * Le navigateur en emet aussi quand c'est la PAGE qui bouge sous un curseur
     * immobile — et cette couche-ci bouge tout le temps : elle suit la carte,
     * qui suit la grille, qui defile. Les coordonnees, elles, ne mentent pas :
     * inchangees, rien n'a bouge. Sans ce filtre le compte a rebours d'inactivite
     * etait repousse en boucle et les boutons restaient poses sur la video,
     * exactement ce qu'un lecteur classique ne fait pas.
     */
    const last = lastPointRef.current;
    if (last && last.x === e.clientX && last.y === e.clientY) return;
    lastPointRef.current = { x: e.clientX, y: e.clientY };
    // Before the slop filter: the cursor comes back for ANY movement, including
    // the tiny ones that are not enough to mean "I am reaching for a control".
    showCursor();
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
  }, [showCursor]);

  const sleep = useCallback(() => {
    if (idleRef.current) clearTimeout(idleRef.current);
    if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current);
    originRef.current = null;
    lastPointRef.current = null;
    setShowControls(false);
    setCursorOn(false);
  }, []);

  /**
   * Scrolling gives the pointer back.
   *
   * Listened for on the document rather than on this layer: the wheel is only
   * one way to scroll, and a visitor using the keyboard or the scrollbar has
   * exactly the same need to see where their pointer is. Only while a trailer is
   * actually showing — there is nothing to give back otherwise.
   */
  useEffect(() => {
    if (!visible) return;
    document.addEventListener("scroll", showCursor, true);
    return () => document.removeEventListener("scroll", showCursor, true);
  }, [visible, showCursor]);

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

  /*
   * How far the player really overflows, once this trailer's own bars are known.
   *
   * OVERSCAN is the floor — it covers the slot not being exactly 16:9 and eats
   * bars up to ~6 % on its own. A measured bar only matters when it is bigger
   * than that, which is why this is a max and not a product: a 12.5 % pillarbox
   * (4:3 in a 16:9 frame) wants 1.333, not 1.12 x 1.333.
   */
  const zoom = Math.min(
    MAX_ZOOM,
    Math.max(OVERSCAN, 1 / (1 - 2 * bars.tb), 1 / (1 - 2 * bars.lr)),
  );

  const controlsVisible = visible && (showControls || volOpen);
  const chrome = `transition-opacity duration-200 ${
    controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
  }`;

  if (src === undefined) return null;

  return (
    <>
      {/*
       * The ambient light: the same trailer, drawn behind the card and blurred
       * out of legibility. See MIRRORED above for why this is a second player
       * rather than a reading of the first one.
       *
       * BELOW the card (z-79 against the card's z-80) and pointer-transparent:
       * it is light, so nothing about it may be clickable, and the card's opaque
       * surface is what keeps it a halo instead of a second picture.
       *
       * The clip is the card's own rule, repeated here because this layer is not
       * inside the card: light may spill left, right and up as far as the blur
       * carries it, and is cut short below the picture — light off a screen does
       * not wrap round to backlight the text under it.
       */}
      {!dataSaver && (
        <div
          className="pointer-events-none fixed z-[79]"
          aria-hidden
          style={{
            clipPath: "inset(-400px -400px -150px -400px)",
            left: 0,
            top: 0,
            // A size to be born with, overwritten by the follow effect on the
            // first card. Without it this player would boot into a 0 × 0 box
            // and pick the layout a tiny player deserves — the same trap the
            // visible frame avoids with SCALE, and one the browser is entitled
            // to answer by never starting the video at all.
            width: 364,
            height: 205,
          }}
          ref={glowBoxRef}
        >
          <div
            className="h-full w-full overflow-hidden"
            style={{
              // The blur is applied to the BOX, not to the frame inside it: the
              // box clips the oversized player first, and the filter then
              // carries that clipped picture out past its own edges. That
              // outward bleed is the halo.
              filter: `blur(${GLOW_BLUR_PX}px) saturate(1.8)`,
              opacity: visible && attachment ? 1 : 0,
              transition: "opacity 240ms",
            }}
          >
            <iframe
              ref={glowFrameRef}
              src={src}
              title=""
              allow="autoplay; encrypted-media; compute-pressure"
              tabIndex={-1}
              /*
               * MOUNTED ×200 AND SHRUNK BACK, exactly like the visible copy —
               * and the sentence that used to sit here, claiming the blur made
               * that unnecessary, was the bug.
               *
               * A 34 px blur does hide the SHAPE of YouTube's chrome. It does
               * nothing about its light: the progress bar is a white line 530 px
               * long, and blurred it becomes a bright band lying across the
               * halo, with the title's smear above it. Worse, that chrome comes
               * and goes on the player's own schedule — so the light changed
               * abruptly while the picture on the card did not move at all,
               * which is precisely the fault reported. Photographed in the
               * probe: "Saga of…" and the progress bar, legible, inside the
               * layer that is supposed to be nothing but colour.
               *
               * The reduction is the fix that already exists in this file: the
               * chrome is sized in pixels, so it shrinks to nothing while the
               * video still fills the frame. See SCALE.
               */
              style={{
                position: "absolute",
                border: 0,
                width: `${SCALE * zoom * 100}%`,
                height: `${SCALE * zoom * 100}%`,
                left: `${(-(zoom - 1) / 2) * 100}%`,
                top: `${(-(zoom - 1) / 2) * 100}%`,
                transform: `scale(${1 / SCALE})`,
                transformOrigin: "0 0",
              }}
              onLoad={(e) => {
                // Same trap as the visible frame: `about:blank` fires onLoad too.
                if (!e.currentTarget.getAttribute("src")) return;
                glowLoadedRef.current = true;
                // It boots on the same video as the visible player but silent,
                // and every transport command since is mirrored to it.
                glowFrameRef.current?.contentWindow?.postMessage(
                  JSON.stringify({ event: "command", func: "mute", args: [] }),
                  ORIGIN,
                );
              }}
              className="pointer-events-none"
            />
          </div>
        </div>
      )}

      <div
        ref={boxRef}
      // Marked as part of the preview so that reaching for a control is not read
      // as leaving the card — the provider closes on any pointerover outside.
      data-preview-popup=""
      /*
       * IT TAKES THE POINTER, and that is a correction.
       *
       * It used to be pointer-transparent so the card underneath kept receiving
       * the hover — with the movement that wakes the controls forwarded from the
       * card through a module-level pair of functions. That relay was fragile
       * for nothing: `data-preview-popup` above already tells the provider that
       * this layer IS the preview, so hovering it keeps the card open exactly
       * like hovering the card. The events belong where the controls are.
       *
       * Transparent again the moment no card is open — otherwise the parked
       * layer would sit over the grid swallowing hovers meant for posters.
       */
      className="fixed z-[81] overflow-hidden"
      onPointerMove={wake}
      onPointerLeave={sleep}
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
        pointerEvents: attachment ? "auto" : "none",
        /*
         * The pointer gets out of the way of the picture it just summoned, and
         * comes back the moment the hand moves — the same rule as the controls,
         * because it is the same question: is the visitor watching, or reaching
         * for something? A cursor parked in the middle of a three-second trailer
         * is the one thing on the card nobody put there on purpose.
         */
        cursor: visible && !controlsVisible && !cursorOn ? "none" : "default",
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
          width: `${SCALE * zoom * 100}%`,
          height: `${SCALE * zoom * 100}%`,
          left: `${(-(zoom - 1) / 2) * 100}%`,
          top: `${(-(zoom - 1) / 2) * 100}%`,
          transform: `scale(${1 / SCALE})`,
          // Top-left, otherwise the reduction re-centres and shifts the picture.
          transformOrigin: "0 0",
          /*
           * THE PAGE MUST STILL SCROLL under a playing trailer.
           *
           * This is a cross-origin document: a wheel over it is delivered to
           * YouTube's page, not to ours, and never reaches our scroller. So a
           * pointer resting on a poster — which is where it is, the card opened
           * under it — froze the page outright. Measured: a real wheel moved
           * scrollY by 0. The card then looked pinned to the screen, because
           * nothing was moving at all.
           *
           * The layer AROUND it keeps `pointerEvents: auto` so hovering still
           * wakes the cursor and the controls; only the frame itself steps out
           * of the way. Nothing is lost: the player is `controls=0` and
           * `disablekb=1`, so it has no interaction of its own to receive.
           */
          pointerEvents: "none",
        }}
        onLoad={(e) => {
          /*
           * Only NOW is the frame on YouTube's origin and safe to talk to —
           * PROVIDED it went there. `src` is undefined until a card asks for a
           * video, and an iframe with no src loads `about:blank`, which fires
           * this handler exactly like a real navigation and inherits OUR origin.
           * The flag went up on that, and every command after it was posted to
           * our own blank document with YouTube named as the target origin:
           * "Failed to execute 'postMessage'… the target origin provided does
           * not match the recipient window's origin", once per tick of the
           * `listening` repeater.
           */
          if (!e.currentTarget.getAttribute("src")) return;
          loadedRef.current = true;
          /*
           * Captions off, for real this time. `cc_load_policy=0` in the URL is a
           * preference the player is free to override, and it does: auto-generated
           * tracks turned up on the card anyway. Unloading the module is the
           * instruction it cannot reinterpret.
           */
          silenceCaptions();
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

      {/* The card's own fade into the body, repeated here because this layer
          covers the card's copy of it. Not tied to the controls: it belongs to
          the picture, not to the chrome, and the whole complaint was that it
          vanished the moment the trailer replaced the artwork. See globals.css,
          where both copies share one declaration. */}
      <div aria-hidden className="as-preview-videofade" />

      {/* Scrim so the icons stay legible over a bright frame. */}
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-0 bg-gradient-to-b from-black/45 via-transparent to-transparent ${chrome}`}
      />

      {/* Dead centre, which is where it belongs and where it could not go before.
          It was pushed into a corner while YouTube still painted its own button
          in the middle — two buttons in one place reads as a bug. SCALE removed
          that one, so the middle is ours.

          `onPointerMove` here as well as on the layer: a pointer resting ON the
          button still has to count as movement, or the control fades out from
          under the hand that is reaching for it. */}
      <div
        className={`absolute inset-0 flex items-center justify-center ${chrome}`}
        onPointerMove={wake}
      >
        <button
          type="button"
          onClick={togglePlay}
          aria-label={paused ? "Play" : "Pause"}
          className="as-preview-videobtn h-11 w-11"
        >
          {paused ? <MdPlayArrow size={28} /> : <MdPause size={28} />}
        </button>
      </div>

      <div
        className={`absolute right-2 top-2 flex flex-col items-center ${chrome}`}
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
    </>
  );
}
