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

function NativeTrailer({ id, base }: { id: string; base: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [t0] = useState(() => Date.now());
  const [firstFrameMs, setFirstFrameMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(true);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    setFirstFrameMs(null);
    setError(null);
  }, [id]);

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
          className="h-full w-full object-cover"
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
        {head && <span className="text-xs text-white/60">{head}</span>}
      </div>

      <div className="flex flex-wrap gap-10">
        <div>
          <div className="mb-2 text-xs uppercase tracking-widest text-white/40">
            &lt;video&gt; natif
          </div>
          {base ? (
            <NativeTrailer key={`n${nonce}${id}${base}`} id={id} base={base} />
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
