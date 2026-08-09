/**
 * Throwaway bench for the native-<video> trailer, to be deleted once the
 * approach is accepted or dropped.
 *
 * It answers the only questions that matter before rewriting PreviewCard:
 * does it start fast, does it look right at the card's real size (364 px), and
 * do OUR controls — the ones an iframe made impossible — actually work?
 *
 * The two players sit side by side on purpose. Reading a screenshot of the new
 * one alone is how the old bug survived several fixes; the comparison is the
 * measurement.
 */
import { useEffect, useRef, useState } from "react";

const DEFAULT_BASE =
  (process.env.NEXT_PUBLIC_PROXY_BASE as string | undefined) || "https://proxy.aniscroll.com";

/**
 * Worker origin, overridable with `?base=`.
 *
 * So this page can be judged WITHOUT deploying to proxy.aniscroll.com, which
 * serves production playback: run `wrangler dev` in worker/ and open
 * /dev/trailer-test?base=http://127.0.0.1:8788. Read once at module scope
 * because it must not change under a playing <video>.
 */
function workerBase() {
  if (typeof window === "undefined") return DEFAULT_BASE;
  const q = new URLSearchParams(window.location.search).get("base");
  return q ? q.replace(/\/$/, "") : DEFAULT_BASE;
}

/** The preview card's real video box, so the test isn't flattered by size. */
const WIDTH = 364;
const HEIGHT = 191;

const SAMPLES = [
  { label: "Kimetsu no Yaiba", id: "6vMuWuWlW4I" },
  { label: "Jujutsu Kaisen", id: "RIyb52EMx8c" },
  { label: "Death Note", id: "NlJZ-YgAt-c" },
  { label: "My Hero Academia", id: "AhqVltWDqFA" },
];

/** Sampling grid for the bar detector. Small on purpose — see detectBars. */
const PROBE_W = 96;
const PROBE_H = 54;
/** Luma below this counts as "black bar", not "dark scene". */
const BLACK_LUMA = 18;
/**
 * Never zoom past this, whatever the pixels say.
 *
 * A trailer that opens on a genuinely black shot reports bars on every edge; the
 * min-across-samples rule below is the real defence, and this is what stops the
 * pathological case (a video that is dark in every sample) from blowing the
 * picture up to nothing.
 */
const MAX_ZOOM = 1.6;
/** When to sample. Not 0 — trailers fade in from black, which reads as bars. */
const PROBE_TIMES_MS = [1200, 2600, 4200, 6000];

/**
 * Measure the black bars baked into the picture.
 *
 * Old 4:3 material published in a 16:9 frame carries its pillarbox in the
 * pixels, so no amount of CSS object-fit removes it — the bars ARE the image.
 * Reading them was impossible while the trailer lived in a cross-origin iframe;
 * it is possible now only because our worker answers with
 * `Access-Control-Allow-Origin: *`, which (with crossOrigin="anonymous") leaves
 * the canvas untainted.
 *
 * Returns the bar thickness on each axis as a fraction of the frame.
 */
function detectBars(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, PROBE_W, PROBE_H);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, PROBE_W, PROBE_H).data;
  } catch {
    // Tainted canvas — CORS didn't hold. Never zoom on a guess.
    return null;
  }
  const luma = (x: number, y: number) => {
    const i = (y * PROBE_W + x) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  // A column/row is a bar only if EVERY pixel in it is black. One bright pixel
  // means real picture, so the scan stops there.
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
  return {
    x: Math.min(left, right) / PROBE_W,
    y: Math.min(top, bottom) / PROBE_H,
  };
}

function NativeTrailer({ id, base, autoCrop }: { id: string; base: string; autoCrop: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [t0] = useState(() => Date.now());
  const [firstFrameMs, setFirstFrameMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(true);
  const [progress, setProgress] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [bars, setBars] = useState<string>("");

  useEffect(() => {
    setFirstFrameMs(null);
    setError(null);
    setZoom(1);
    setBars("");
  }, [id]);

  /**
   * Sample a few times and keep the SMALLEST bars seen.
   *
   * One sample is not evidence: a shot that happens to be dark at the edges
   * looks exactly like a pillarbox. Bars that are real are present in every
   * frame, so the minimum across samples converges on them and a dark scene
   * only ever pulls the estimate down — the safe direction, since under-zooming
   * leaves a thin band and over-zooming eats the picture.
   */
  useEffect(() => {
    if (!autoCrop) return;
    if (!canvasRef.current) {
      canvasRef.current = document.createElement("canvas");
      canvasRef.current.width = PROBE_W;
      canvasRef.current.height = PROBE_H;
    }
    let best: { x: number; y: number } | null = null;
    const timers = PROBE_TIMES_MS.map((at) =>
      setTimeout(() => {
        const video = ref.current;
        if (!video || video.readyState < 2 || !canvasRef.current) return;
        const found = detectBars(video, canvasRef.current);
        if (!found) return;
        best = best
          ? { x: Math.min(best.x, found.x), y: Math.min(best.y, found.y) }
          : found;
        // Only one axis can be cropped by a uniform scale, so take the worse
        // one — zooming to kill the pillarbox also pushes the letterbox out.
        const worst = Math.max(best.x, best.y);
        // A bar under ~1.5 % is measurement noise, not a bar.
        const next = worst > 0.015 ? Math.min(MAX_ZOOM, 1 / (1 - 2 * worst)) : 1;
        setZoom(next);
        setBars(`x ${(best.x * 100).toFixed(1)}% · y ${(best.y * 100).toFixed(1)}%`);
      }, at),
    );
    return () => timers.forEach(clearTimeout);
  }, [autoCrop, id]);

  return (
    <div>
      <div
        className="relative overflow-hidden rounded-lg bg-black"
        style={{ width: WIDTH, height: HEIGHT }}
      >
        <video
          ref={ref}
          src={`${base}/w/trailer/${id}.mp4`}
          autoPlay
          loop
          muted
          playsInline
          preload="auto"
          // The reason the bars can be measured at all: without this the canvas
          // is tainted and getImageData throws. The worker sends ACAO: *.
          crossOrigin="anonymous"
          className="h-full w-full object-cover transition-transform duration-500"
          style={{ transform: `scale(${zoom})` }}
          // `loadeddata` is the honest "there are pixels now" event — the one
          // the iframe never had an equivalent for.
          onLoadedData={() => setFirstFrameMs(Date.now() - t0)}
          onError={() => setError("load failed")}
          onPlay={() => setPaused(false)}
          onPause={() => setPaused(true)}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            setProgress(v.duration ? v.currentTime / v.duration : 0);
          }}
        />
        {error && (
          <div className="absolute inset-0 grid place-items-center text-sm text-red-400">
            {error}
          </div>
        )}
        {/* Proof the controls exist at all: a scrubber over a trailer is the
            thing the iframe made unbuildable. */}
        <div
          className="absolute bottom-0 left-0 h-1 bg-red-500 transition-[width] duration-100"
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      <div className="mt-2 flex items-center gap-2 text-xs text-white/70">
        <button
          type="button"
          className="rounded bg-white/10 px-2 py-1 hover:bg-white/20"
          onClick={() => {
            const v = ref.current;
            if (!v) return;
            if (v.paused) v.play();
            else v.pause();
          }}
        >
          {paused ? "Play" : "Pause"}
        </button>
        <button
          type="button"
          className="rounded bg-white/10 px-2 py-1 hover:bg-white/20"
          onClick={() => {
            const v = ref.current;
            if (!v) return;
            v.muted = !v.muted;
            setMuted(v.muted);
          }}
        >
          {muted ? "Unmute" : "Mute"}
        </button>
        <button
          type="button"
          className="rounded bg-white/10 px-2 py-1 hover:bg-white/20"
          onClick={() => {
            if (ref.current) ref.current.currentTime = 8;
          }}
        >
          Seek 8s
        </button>
        <span className="ml-auto tabular-nums">
          {firstFrameMs != null ? `first frame ${firstFrameMs} ms` : "…"}
        </span>
      </div>
      <div className="mt-1 text-xs tabular-nums text-white/40">
        {autoCrop
          ? `bandes ${bars || "…"} → zoom ×${zoom.toFixed(3)}`
          : "auto-crop desactive"}
      </div>
    </div>
  );
}

/** The current production path, for the side-by-side. */
function IframeTrailer({ id }: { id: string }) {
  return (
    <div className="overflow-hidden rounded-lg bg-black" style={{ width: WIDTH, height: HEIGHT }}>
      <iframe
        title="iframe trailer"
        allow="autoplay"
        className="h-full w-full border-0"
        src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&controls=0&disablekb=1&rel=0&playsinline=1&fs=0&modestbranding=1&iv_load_policy=3`}
      />
    </div>
  );
}

export default function TrailerTest() {
  const [id, setId] = useState(SAMPLES[0].id);
  const [nonce, setNonce] = useState(0);
  const [head, setHead] = useState<string>("");
  // Resolved on the client only (it can depend on the query string), so the
  // players wait for it rather than mount against the server's guess and then
  // reload with a different src.
  const [base, setBase] = useState<string | null>(null);
  const [autoCrop, setAutoCrop] = useState(true);
  useEffect(() => setBase(workerBase()), []);

  // Cold vs warm edge cache, straight from the response header — the number
  // that decides whether this costs anything at scale.
  const probe = async () => {
    const started = Date.now();
    const res = await fetch(`${base}/w/trailer/${id}.mp4`, {
      method: "GET",
      headers: { Range: "bytes=0-1023" },
    });
    setHead(
      `HTTP ${res.status} · cache ${res.headers.get("x-aniscroll-cache") || "?"} · ` +
        `${res.headers.get("content-type")} · ${Date.now() - started} ms`,
    );
  };

  return (
    <div className="min-h-screen bg-[#12121a] p-8 font-sans text-white">
      <h1 className="mb-1 text-xl font-bold">Trailer : &lt;video&gt; natif vs iframe YouTube</h1>
      <p className="mb-6 text-sm text-white/50">
        Page de test jetable. Gauche = nouveau (proxy worker, aucun chrome possible), droite =
        production actuelle. Worker : <code className="text-white/70">{base ?? "…"}</code> —
        surchargeable avec <code className="text-white/70">?base=http://127.0.0.1:8788</code> pour
        juger sans deployer sur la prod.
      </p>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        {SAMPLES.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => {
              setId(s.id);
              setNonce((n) => n + 1);
            }}
            className={`rounded px-3 py-1.5 text-sm ${
              id === s.id ? "bg-white text-black" : "bg-white/10 hover:bg-white/20"
            }`}
          >
            {s.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setNonce((n) => n + 1)}
          className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
        >
          Remonter les deux
        </button>
        <button
          type="button"
          onClick={probe}
          className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
        >
          Sonder le cache edge
        </button>
        <button
          type="button"
          onClick={() => {
            setAutoCrop((v) => !v);
            setNonce((n) => n + 1);
          }}
          className={`rounded px-3 py-1.5 text-sm ${
            autoCrop ? "bg-emerald-500/80 text-black" : "bg-white/10 hover:bg-white/20"
          }`}
        >
          Auto-crop {autoCrop ? "ON" : "OFF"}
        </button>
        {head && <span className="text-xs text-white/60">{head}</span>}
      </div>

      <div className="flex flex-wrap gap-10">
        <div>
          <div className="mb-2 text-xs uppercase tracking-widest text-white/40">
            &lt;video&gt; natif
          </div>
          {base ? (
            <NativeTrailer key={`n${nonce}${id}${base}`} id={id} base={base} autoCrop={autoCrop} />
          ) : (
            <div className="rounded-lg bg-black" style={{ width: WIDTH, height: HEIGHT }} />
          )}
        </div>
        <div>
          <div className="mb-2 text-xs uppercase tracking-widest text-white/40">
            iframe YouTube (prod)
          </div>
          <IframeTrailer key={`i${nonce}${id}`} id={id} />
        </div>
      </div>
    </div>
  );
}
