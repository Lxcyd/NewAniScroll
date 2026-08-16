/**
 * Baked-in black bars in a trailer, found without being able to see the video.
 *
 * THE PROBLEM. Some masters are not 16:9 — a 4:3 TV series, a 2.35:1 film, or an
 * upscale sitting in a black window — and YouTube plays them inside a 16:9 frame
 * with the difference filled in black. `object-fit: cover` would crop those away
 * for a <video>; an iframe has no such thing, and the player is cross-origin, so
 * its pixels cannot be read. That is exactly why the old crop probe was deleted
 * along with the proxy: there was nothing left to measure.
 *
 * WHAT CAN STILL BE MEASURED. YouTube publishes `mq1/mq2/mq3.jpg` — three frames
 * taken at roughly 25 %, 50 % and 75 % through the video — at 320×180, in true
 * 16:9, with `Access-Control-Allow-Origin: *`. They are ordinary images from our
 * point of view, so they go into a canvas and can be read pixel by pixel. The
 * bars in the video are the bars in those frames.
 *
 * (`1/2/3.jpg` are the same frames at 120×90, which is 4:3 — they carry
 * YouTube's OWN letterbox and would report a 12.5 % bar on every 16:9 video on
 * earth. Checked, and the reason the `mq` set is used.)
 *
 * THREE FRAMES, NOT ONE, because the real trap is the false positive: plenty of
 * trailers are letterboxed for SOME shots and full-frame for others, and
 * cropping those would blow up every shot that was already correct. See `median`
 * below for how disagreement is resolved.
 *
 * MEASURED on 140 popular trailers: one crop, no false positives. This is a rare
 * fix, not a common one — which is the honest shape of the problem rather than a
 * disappointment.
 *
 * A LIMIT THAT CANNOT BE ENGINEERED AWAY FROM HERE. Some videos are pillarboxed
 * in playback while YouTube's stills of them are not. Naruto (-G9BqkgZXRA) is
 * one: the played frame carries a constant ~10 % bar on each side — measured on
 * 19 screenshots of the real card, present in every one — and NONE of mq1/mq2/
 * mq3/mqdefault/maxresdefault/hqdefault/sddefault shows a single black column at
 * any threshold up to 64. The stills are simply not the same picture as the
 * stream, and since the stream is cross-origin there is nothing else to look at.
 * Those trailers keep their bars. Written down so the next person does not spend
 * an afternoon loosening thresholds against an image that never had the evidence
 * in it.
 */

/** A pixel is "black" if its brightest channel is under this. */
const BLACK = 20;
/** How much of a line must be black for the line to be part of a bar. */
const HIT = 0.97;
/**
 * How bright the first line INSIDE the bar has to be.
 *
 * A real bar has a hard edge: black, then picture. Without this test a night
 * sky, a fade to black, or a dark title card is read as a bar and the trailer
 * gets zoomed for no reason.
 */
const LIT = 30;
/** Never take more than this off one side, whatever the pixels say. */
const MAX_SIDE = 0.3;
/** Below this, it is JPEG noise on the edge rather than a bar. */
const MIN_BAR = 0.02;

/**
 * The three frames YouTube publishes for a video, at ~25/50/75 % through it.
 *
 * Exported because they are useful twice: this file reads them for black bars,
 * and TrailerAmbient lights the card with them when the live glow is off (Data
 * Saver) or the trailer has not started. There used to be a second exported
 * name for that second use, returning this very list unchanged — one name is
 * enough for one list of URLs. They are the only frames
 * of the video reachable from a browser — the real storyboard sheets under
 * i.ytimg.com/sb/ are signed and answer 403 without the token from the player
 * response, which a cross-origin page cannot have. Checked, so nobody tries.
 */
export function storyboardFrames(id: string): string[] {
  return ["mq1", "mq2", "mq3"].map((n) => `https://i.ytimg.com/vi/${id}/${n}.jpg`);
}

export type TrailerBars = {
  /** Fraction of the height that is bar, top AND bottom (symmetric). */
  tb: number;
  /** Fraction of the width that is bar, left AND right (symmetric). */
  lr: number;
};

const NONE: TrailerBars = { tb: 0, lr: 0 };

const cache = new Map<string, TrailerBars>();
const inFlight = new Map<string, Promise<TrailerBars>>();

type Side = "top" | "bottom" | "left" | "right";

function lineStats(
  d: Uint8ClampedArray,
  w: number,
  h: number,
  side: Side,
  i: number,
): { blackRatio: number; mean: number } {
  let black = 0;
  let sum = 0;
  let n = 0;
  const at = (x: number, y: number) => {
    const p = (y * w + x) * 4;
    const m = Math.max(d[p], d[p + 1], d[p + 2]);
    if (m <= BLACK) black++;
    sum += m;
    n++;
  };
  // The outermost two pixels of each line are skipped: JPEG ringing at a corner
  // is not evidence about the middle of an edge.
  if (side === "top") for (let x = 2; x < w - 2; x++) at(x, i);
  else if (side === "bottom") for (let x = 2; x < w - 2; x++) at(x, h - 1 - i);
  else if (side === "left") for (let y = 2; y < h - 2; y++) at(i, y);
  else for (let y = 2; y < h - 2; y++) at(w - 1 - i, y);
  return { blackRatio: black / n, mean: sum / n };
}

function barOn(d: Uint8ClampedArray, w: number, h: number, side: Side): number {
  const span = side === "top" || side === "bottom" ? h : w;
  const cap = Math.floor(span * MAX_SIDE);
  // Start at 1: the very first row of a JPEG carries the compression's own
  // ringing and is dark on plenty of pictures that have no bar at all.
  let i = 1;
  while (i < cap && lineStats(d, w, h, side, i).blackRatio >= HIT) i++;
  if (i <= 1) return 0;
  if (lineStats(d, w, h, side, i).mean < LIT) return 0;
  return i / span;
}

async function frameBars(url: string): Promise<Record<Side, number>> {
  const img = new Image();
  // Without this the canvas is tainted and getImageData throws. ytimg answers
  // `Access-Control-Allow-Origin: *`, which is what makes any of this possible.
  img.crossOrigin = "anonymous";
  img.src = url;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return {
    top: barOn(data, width, height, "top"),
    bottom: barOn(data, width, height, "bottom"),
    left: barOn(data, width, height, "left"),
    right: barOn(data, width, height, "right"),
  };
}

/**
 * What the whole video does, from three samples of it.
 *
 * THE MEDIAN, NOT THE MINIMUM. The minimum looked like the cautious choice and
 * was too severe: one disagreeing frame — an end card that fills the frame, a
 * shot whose set touches the edge — cancelled a bar that was present everywhere
 * else. The median of three asks that TWO agree, which is the useful definition
 * of "the bar is there while the video plays". Measured: it rescues a genuinely
 * windowboxed trailer that the minimum threw away, and it still refuses the
 * trailers whose framing changes shot to shot.
 *
 * THEN SYMMETRY. A real letterbox is symmetric, so opposite sides are reduced to
 * their smaller value. Asymmetry means we are looking at a dark picture, not at
 * a bar — and it keeps the crop centred, so nothing has to be re-aligned.
 */
export function detectBars(id: string): Promise<TrailerBars> {
  const done = cache.get(id);
  if (done) return Promise.resolve(done);
  const pending = inFlight.get(id);
  if (pending) return pending;

  const p = (async () => {
    try {
      const frames = await Promise.all(storyboardFrames(id).map(frameBars));
      const median = (side: Side) =>
        frames.map((f) => f[side]).sort((a, b) => a - b)[1];
      const tb = Math.min(median("top"), median("bottom"));
      const lr = Math.min(median("left"), median("right"));
      const bars: TrailerBars = {
        tb: tb < MIN_BAR ? 0 : tb,
        lr: lr < MIN_BAR ? 0 : lr,
      };
      cache.set(id, bars);
      return bars;
      // A missing storyboard, a decode failure, a browser without canvas: none
      // of those is a statement about the video, so none of them crops it.
    } catch {
      cache.set(id, NONE);
      return NONE;
    } finally {
      inFlight.delete(id);
    }
  })();
  inFlight.set(id, p);
  return p;
}

/** What we already know, for the render that happens before the images land. */
export function peekBars(id: string): TrailerBars {
  return cache.get(id) ?? NONE;
}
