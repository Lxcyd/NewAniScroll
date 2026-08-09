/**
 * Where a trailer comes from, and how much of its edges are fake.
 *
 * THE SOURCE. Trailers are served as plain MP4s by the Cloudflare Worker
 * (`/w/trailer/<id>.mp4`, see worker/src/youtube-trailer.js) rather than
 * embedded from YouTube. The reason is not bandwidth, it is control: a
 * cross-origin embed paints its own chrome — a big centre button on start-up,
 * on pause, on cue — and nothing removes it. No URL parameter does, no CSS
 * reaches into the frame, no message announces it. A <video> element we feed
 * ourselves has no chrome because there is no player but ours, which is also
 * what makes pause, seek and a clean first frame possible at all.
 *
 * THE CROP. Old material published in a modern frame carries its pillarbox in
 * the PIXELS (Death Note's 2006 trailer is 4:3 inside 16:9), so no object-fit
 * removes it. Reading those pixels was impossible while the trailer lived in a
 * cross-origin iframe; it works now only because the Worker answers with
 * `Access-Control-Allow-Origin: *`, which — with crossOrigin="anonymous" —
 * leaves the canvas untainted.
 */

const DEFAULT_BASE =
  (process.env.NEXT_PUBLIC_PROXY_BASE as string | undefined) || "https://proxy.aniscroll.com";

export function trailerSrc(id: string): string {
  return `${DEFAULT_BASE}/w/trailer/${id}.mp4`;
}

/** Sampling grid. Small on purpose: bars are geometry, not detail. */
const PROBE_W = 96;
const PROBE_H = 54;
/**
 * Luma below this counts as "black bar", not "dark scene".
 *
 * Not 18, which was the first value tried and left a visible black line. A
 * bar's edge is never a clean step in a compressed 360p frame: the block
 * boundary bleeds a few levels of grey outward and the encoder leaves ringing
 * along the high-contrast seam. Scanning for near-absolute black stops one or
 * two columns short of the true edge, and what survives the crop is exactly
 * that sliver.
 */
const BLACK_LUMA = 30;
/**
 * How bright the middle of a frame must be for that frame to prove anything.
 *
 * THE rule that makes this safe. Nearly every anime trailer opens on a studio
 * card — a small bright logo on black — which is pixel-for-pixel what a
 * pillarboxed frame looks like. Such a frame cannot tell the two apart, so it
 * does not get a vote. An earlier version sampled only the opening seconds,
 * where every frame is that card, and confidently reported 29 % × 41 % bars on
 * a trailer that has none. Combining bad samples more cleverly does not fix
 * that; discarding them does.
 */
const MIN_CENTRE_LUMA = 34;
/**
 * Widest bar we will believe, as a fraction of the frame. 4:3 inside 16:9 — the
 * case this exists for — puts 12.5 % on each side, and no standard framing does
 * worse, so a larger reading is evidence of a misread rather than a wide bar.
 */
const MAX_BAR = 0.14;
/**
 * Extra crop past what was measured.
 *
 * The two errors are not symmetrical: overshooting eats ~1 % of a picture
 * nobody inspects at 364 px wide, undershooting leaves a black line along the
 * edge, which the eye catches instantly.
 */
const BAR_MARGIN = 0.012;
/** One cap, derived from MAX_BAR, so the two can never disagree. */
const MAX_ZOOM = 1 / (1 - 2 * MAX_BAR);
/**
 * Where the off-screen probe looks, as fractions of the duration.
 *
 * Spread across the whole timeline and never near the start. Two things fall
 * out of that. The studio card is not in the sample set, so it cannot poison
 * the measurement. And a trailer that is boxed ONLY at its start is safe by
 * construction, because the rule below keeps the smallest bars seen: one
 * readable frame without bars, anywhere, drags the estimate to zero. A bar has
 * to survive every probed moment to be believed.
 */
const PROBE_AT = [0.2, 0.35, 0.5, 0.65, 0.8];
/** Two readable frames minimum — one frame agreeing with itself is not a measurement. */
const MIN_VALID_SAMPLES = 2;
/** Give up and let the caller fall back to watching live frames. */
const PROBE_TIMEOUT_MS = 2500;
/**
 * Decisions, kept across sessions.
 *
 * A trailer's framing is a property of the file and cannot change between two
 * hovers, so the second view of a card must never re-measure: it reads this and
 * is correctly framed in its first painted frame. The version suffix means a
 * change to the detector discards what an older one wrote instead of inheriting
 * its mistakes.
 */
const STORE_KEY = "as-trailer-crop-v2";

type Bars = { x: number; y: number };

/**
 * Measure the black bars baked into one frame, or return null when the frame
 * cannot testify (see MIN_CENTRE_LUMA) or the canvas is tainted.
 */
function detectBars(video: HTMLVideoElement, canvas: HTMLCanvasElement): Bars | null {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(video, 0, 0, PROBE_W, PROBE_H);
  } catch {
    return null;
  }
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, PROBE_W, PROBE_H).data;
  } catch {
    // Tainted canvas — CORS didn't hold. Never crop on a guess.
    return null;
  }
  const luma = (x: number, y: number) => {
    const i = (y * PROBE_W + x) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };

  let centreSum = 0;
  let centreCount = 0;
  for (let y = Math.floor(PROBE_H * 0.25); y < PROBE_H * 0.75; y += 1) {
    for (let x = Math.floor(PROBE_W * 0.25); x < PROBE_W * 0.75; x += 1) {
      centreSum += luma(x, y);
      centreCount += 1;
    }
  }
  if (centreCount === 0 || centreSum / centreCount < MIN_CENTRE_LUMA) return null;

  // A column or row is a bar only if EVERY pixel in it is black — one bright
  // pixel is real picture, and the scan stops there.
  const colBlack = (x: number) => {
    for (let y = 0; y < PROBE_H; y += 1) if (luma(x, y) > BLACK_LUMA) return false;
    return true;
  };
  const rowBlack = (y: number) => {
    for (let x = 0; x < PROBE_W; x += 1) if (luma(x, y) > BLACK_LUMA) return false;
    return true;
  };
  let left = 0;
  while (left < PROBE_W / 2 && colBlack(left)) left += 1;
  let right = 0;
  while (right < PROBE_W / 2 && colBlack(PROBE_W - 1 - right)) right += 1;
  let top = 0;
  while (top < PROBE_H / 2 && rowBlack(top)) top += 1;
  let bottom = 0;
  while (bottom < PROBE_H / 2 && rowBlack(PROBE_H - 1 - bottom)) bottom += 1;
  return { x: Math.min(left, right) / PROBE_W, y: Math.min(top, bottom) / PROBE_H };
}

/** Bars → the uniform scale that pushes them out of the box. */
function zoomForBars(bars: Bars): number {
  const measured = Math.max(bars.x, bars.y);
  // Noise-sized readings must not collect the safety margin and become a crop.
  if (measured <= 0.015) return 1;
  // A uniform scale crops one axis, so the worse one decides — pushing the
  // pillarbox out takes any letterbox with it.
  const worst = Math.min(MAX_BAR, measured + BAR_MARGIN);
  return Math.min(MAX_ZOOM, 1 / (1 - 2 * worst));
}

export function readCrop(id: string): number | null {
  try {
    const raw = window.localStorage.getItem(`${STORE_KEY}:${id}`);
    if (!raw) return null;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 1 && v <= MAX_ZOOM ? v : null;
  } catch {
    return null;
  }
}

export function writeCrop(id: string, zoom: number): void {
  try {
    window.localStorage.setItem(`${STORE_KEY}:${id}`, String(zoom));
  } catch {
    /* private mode — the probe simply runs again next time */
  }
}

export function makeProbeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = PROBE_W;
  canvas.height = PROBE_H;
  return canvas;
}

/**
 * Decide a trailer's crop BEFORE its picture is ever shown, by loading a second
 * hidden element and jumping it straight into the middle of the file.
 *
 * Watching the visible copy instead meant waiting for it to play out of its own
 * intro: about a second of visibly wrong framing, followed by a zoom the viewer
 * could see happen. The middle of a trailer is real footage, readable at once,
 * and the file is already in the edge cache — so this is a handful of range
 * requests, not a second download.
 *
 * Resolves null when nothing conclusive came back (every probed frame dark, a
 * seek that never landed, CORS lost); the caller then falls back to sampling
 * the live video, which is slower but never wrong for being empty.
 */
export function probeCrop(src: string, canvas: HTMLCanvasElement): Promise<number | null> {
  return new Promise((resolve) => {
    const probe = document.createElement("video");
    probe.src = src;
    probe.crossOrigin = "anonymous";
    probe.muted = true;
    probe.preload = "auto";
    probe.playsInline = true;

    let done = false;
    const finish = (value: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      // Detach the source, or the element holds its buffer alive for a while.
      probe.removeAttribute("src");
      probe.load();
      resolve(value);
    };
    const timeout = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);

    let index = 0;
    let valid = 0;
    let best: Bars | null = null;

    const seekNext = () => {
      if (index >= PROBE_AT.length || !probe.duration || !Number.isFinite(probe.duration)) {
        finish(best && valid >= MIN_VALID_SAMPLES ? zoomForBars(best) : null);
        return;
      }
      probe.currentTime = probe.duration * PROBE_AT[index];
      index += 1;
    };

    probe.addEventListener("loadedmetadata", seekNext);
    probe.addEventListener("seeked", () => {
      const found = detectBars(probe, canvas);
      if (found) {
        valid += 1;
        best = best ? { x: Math.min(best.x, found.x), y: Math.min(best.y, found.y) } : found;
      }
      seekNext();
    });
    probe.addEventListener("error", () => finish(null));
  });
}

/**
 * The fallback: watch the frames the viewer is already being shown.
 *
 * Slower than the probe — it can only learn from footage that has played — but
 * it cannot be defeated by a seek that won't land. Same rules otherwise: dark
 * frames don't vote, the smallest bars win.
 */
export function sampleLive(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  onZoom: (zoom: number) => void,
  { everyMs = 700, samples = 8 } = {},
): () => void {
  let best: Bars | null = null;
  let valid = 0;
  let seen = 0;
  const timer = setInterval(() => {
    if (video.readyState < 2 || video.paused) return;
    seen += 1;
    const found = detectBars(video, canvas);
    if (found) {
      valid += 1;
      best = best ? { x: Math.min(best.x, found.x), y: Math.min(best.y, found.y) } : found;
    }
    if (best && valid >= MIN_VALID_SAMPLES) onZoom(zoomForBars(best));
    if (seen >= samples) clearInterval(timer);
  }, everyMs);
  return () => clearInterval(timer);
}
