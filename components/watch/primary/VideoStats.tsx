/**
 * "Stats for nerds" overlay — a small draggable panel that reads live playback
 * telemetry off the actual <video> element (and the hls.js instance when the
 * source is HLS). Toggled by the `toggleStats` shortcut / player menu row.
 *
 * Intentionally read-only and self-contained: it polls at ~2 Hz rather than
 * subscribing to Vidstack state, so it never triggers re-renders in the player
 * itself. It sits as a sibling overlay inside the player root (so it survives
 * fullscreen, like SkipOverlay).
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MediaPlayerInstance } from "@vidstack/react";
import { getServerScore } from "@/lib/watch/serverPerf";

/** Accumulateurs vivants du lecteur (lib/watch/serverPerf), passes par ref pour
 *  que les lire ici ne coute aucun rendu la-bas. */
export type PerfRefs = {
  wallMs: { current: number };
  stalledMs: { current: number };
  maxHeight: { current: number };
  ttffMs: { current: number };
};

type Stats = {
  resolution: string;
  displayResolution: string;
  fps: string;
  buffered: string;
  bitrate: string;
  droppedFrames: string;
  connectionSpeed: string;
  playbackRate: string;
  volume: string;
  currentTime: string;
  duration: string;
  bufferHealth: string;
  server: string;
  /* Score persiste par lecteur — ce qui classera les chips au prochain
     chargement. Affiche ici pour pouvoir le lire sans passer par la console. */
  ttff: string;
  stallRate: string;
  perfScore: string;
};

const EMPTY: Stats = {
  resolution: "—",
  displayResolution: "—",
  fps: "—",
  buffered: "—",
  bitrate: "—",
  droppedFrames: "—",
  connectionSpeed: "—",
  playbackRate: "—",
  volume: "—",
  currentTime: "—",
  duration: "—",
  bufferHealth: "—",
  server: "—",
  ttff: "—",
  stallRate: "—",
  perfScore: "—",
};

function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export default function VideoStats({
  playerRef,
  hlsRef,
  serverName,
  perf,
  onClose,
}: {
  playerRef: React.RefObject<MediaPlayerInstance>;
  hlsRef: React.MutableRefObject<any>;
  serverName?: string;
  perf?: PerfRefs;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [stats, setStats] = useState<Stats>(EMPTY);

  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    const read = (): Stats => {
      const player = playerRef.current;
      const video =
        (player?.el as HTMLElement | undefined)?.querySelector<HTMLVideoElement>(
          "video",
        ) || null;
      if (!video) return EMPTY;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      const dispW = Math.round(video.clientWidth * dpr);
      const dispH = Math.round(video.clientHeight * dpr);

      // Buffered ahead of the playhead.
      let bufferedEnd = 0;
      try {
        const b = video.buffered;
        for (let i = 0; i < b.length; i++) {
          if (video.currentTime >= b.start(i) && video.currentTime <= b.end(i)) {
            bufferedEnd = b.end(i);
            break;
          }
        }
      } catch {}
      const bufferAhead = Math.max(0, bufferedEnd - video.currentTime);

      // Quality / dropped frames.
      let dropped = "—";
      let totalFrames = "—";
      try {
        const q: any = (video as any).getVideoPlaybackQuality?.();
        if (q) {
          dropped = String(q.droppedVideoFrames ?? 0);
          totalFrames = String(q.totalVideoFrames ?? 0);
        }
      } catch {}

      // hls.js: current level bitrate + measured bandwidth.
      let bitrate = "—";
      let speed = "—";
      let fps = "—";
      const hls = hlsRef?.current;
      try {
        if (hls) {
          const lvl = hls.levels?.[hls.currentLevel];
          if (lvl?.bitrate) bitrate = `${Math.round(lvl.bitrate / 1000)} kbps`;
          if (lvl?.attrs?.["FRAME-RATE"]) fps = `${lvl.attrs["FRAME-RATE"]} fps`;
          const bw = hls.bandwidthEstimate;
          if (bw) speed = `${(bw / 1_000_000).toFixed(2)} Mbps`;
        }
      } catch {}

      // Score persiste du lecteur actif. `C` est la confiance : tant qu'elle est
      // basse, le rang statique de lib/servers.js tient encore la barre.
      let perfScore = "—";
      let ttff = "—";
      let stallRate = "—";
      if (serverName) {
        const { final, measured, C } = getServerScore(serverName);
        perfScore =
          measured == null
            ? `${final.toFixed(0)} (statique)`
            : `${final.toFixed(0)} · C ${C.toFixed(2)}`;
        if (perf) {
          if (perf.ttffMs.current > 0) {
            ttff = `${Math.round(perf.ttffMs.current)} ms`;
          }
          const wall = perf.wallMs.current;
          stallRate =
            wall > 0
              ? `${((perf.stalledMs.current / wall) * 60).toFixed(1)} s/min` +
                (wall < 60_000 ? " (trop court)" : "")
              : "—";
        }
      }

      return {
        resolution: vw && vh ? `${vw}×${vh}` : "—",
        displayResolution: dispW && dispH ? `${dispW}×${dispH}` : "—",
        fps,
        buffered: `${bufferAhead.toFixed(1)} s`,
        bitrate,
        droppedFrames:
          dropped !== "—" ? `${dropped} / ${totalFrames}` : "—",
        connectionSpeed: speed,
        playbackRate: `${video.playbackRate.toFixed(2)}×`,
        volume: video.muted ? "muted" : `${Math.round(video.volume * 100)}%`,
        currentTime: fmtTime(video.currentTime),
        duration: fmtTime(video.duration),
        bufferHealth: `${bufferAhead.toFixed(1)} s`,
        server: serverName || "—",
        ttff,
        stallRate,
        perfScore,
      };
    };

    let last = 0;
    const loop = (ts: number) => {
      if (cancelled) return;
      if (ts - last > 500) {
        last = ts;
        setStats(read());
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [playerRef, hlsRef, serverName, perf]);

  const rows: Array<[string, string]> = [
    [t("stats.server"), stats.server],
    [t("stats.resolution"), stats.resolution],
    [t("stats.displayResolution"), stats.displayResolution],
    [t("stats.fps"), stats.fps],
    [t("stats.bitrate"), stats.bitrate],
    [t("stats.connectionSpeed"), stats.connectionSpeed],
    [t("stats.bufferHealth"), stats.bufferHealth],
    [t("stats.droppedFrames"), stats.droppedFrames],
    [t("stats.playbackRate"), stats.playbackRate],
    [t("stats.volume"), stats.volume],
    [t("stats.time"), `${stats.currentTime} / ${stats.duration}`],
    [t("stats.ttff"), stats.ttff],
    [t("stats.stallRate"), stats.stallRate],
    [t("stats.perfScore"), stats.perfScore],
  ];

  return (
    <div
      className="pointer-events-auto absolute left-3 top-3 z-[30] w-[248px] select-none rounded-lg text-[11px] leading-relaxed text-white shadow-2xl"
      style={{
        background: "rgba(10,12,16,0.86)",
        backdropFilter: "blur(6px)",
        border: "1px solid rgba(255,255,255,0.1)",
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      }}
    >
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
        <span className="text-[11px] font-semibold tracking-wide text-white/90">
          {t("stats.title")}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("stats.close")}
          className="grid h-5 w-5 place-items-center rounded text-white/50 transition hover:bg-white/10 hover:text-white"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
            <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </svg>
        </button>
      </div>
      <div className="space-y-0.5 px-3 py-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-3">
            <span className="text-white/50">{k}</span>
            <span className="truncate text-right text-white/90">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
