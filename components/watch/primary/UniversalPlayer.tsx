import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";

import { useEffect, useRef, useState } from "react";
// @ts-ignore — react-dom types not installed but createPortal is exported
import { createPortal } from "react-dom";
import {
  MediaPlayer,
  MediaProvider,
  Track,
  type MediaPlayerInstance,
} from "@vidstack/react";
import {
  defaultLayoutIcons,
  DefaultVideoLayout,
} from "@vidstack/react/player/layouts/default";
import SubtitleSettings from "./SubtitleSettings";
import HoverPreview from "./HoverPreview";

type Stream = {
  url: string;
  quality?: string;
  isM3U8?: boolean;
  referer?: string;
  /** Skip our local /api/v2/proxy/m3u8 — URL is already through an external
   *  proxy that handles CORS + segment rewriting (e.g. anime-proxy for vidmoly). */
  directUrl?: boolean;
};

type Subtitle = {
  file?: string;
  url?: string;
  label?: string;
  kind?: string;
  language?: string;
  default?: boolean;
};

export type UniversalStreamData = {
  streams?: Stream[];
  sources?: Stream[];
  iframe?: string;
  subtitles?: Subtitle[];
  referer?: string;
  error?: boolean;
};

type Props = {
  streamData: UniversalStreamData | null;
  poster?: string;
  onError?: (reason?: string) => void;
  ambient?: boolean;
  serverId?: string;
  /** Used as the download filename when the user hits the download button. */
  downloadName?: string;
};

function proxied(url: string, referer?: string | null): string {
  if (!url) return url;
  const ref = referer ? `&referer=${encodeURIComponent(referer)}` : "";
  return `/api/v2/proxy/m3u8?url=${encodeURIComponent(url)}${ref}`;
}

/**
 * StaticGlow — CSS-only ambient (poster + pink accent).
 * Used as the base layer always, and as the ONLY layer for iframe embeds
 * (where we can't reach into the cross-origin video element).
 */
function StaticGlow({
  poster,
  intense = false,
}: {
  poster?: string;
  intense?: boolean;
}) {
  // Same approach as LiveAmbient: element sized exactly to the player, heavy
  // CSS blur creates the visible glow by bleeding colors past its box.
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{
        zIndex: 0,
        backgroundImage: poster
          ? `url(${poster})`
          : "linear-gradient(135deg, #E94560 0%, #8E1B3B 100%)",
        backgroundSize: "cover",
        backgroundPosition: "center",
        filter: "blur(140px) saturate(1.8)",
        transform: "scale(1.1)",
        opacity: intense ? 0.95 : 0.8,
      }}
    />
  );
}

/**
 * LiveAmbient — YouTube/Spotify-style ambient.
 * A low-res canvas is drawn from the video every frame (~30 fps), sized via
 * CSS to extend beyond the player, heavily blurred, and faded out with a
 * radial mask. Result: one coherent gradient that IS the video's colors,
 * with no visible edge/rectangle.
 */
function LiveAmbient({
  playerRef,
}: {
  playerRef: React.RefObject<MediaPlayerInstance>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let raf = 0;

    const tick = () => {
      raf = requestAnimationFrame(tick);

      const canvas = canvasRef.current;
      if (!canvas) return;

      const playerEl = playerRef.current?.el as HTMLElement | undefined;
      const video = playerEl?.querySelector("video") as HTMLVideoElement | null;
      if (!video || video.readyState < 2 || video.videoWidth === 0) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      try {
        // Draw the full frame at low res — CSS blur + mask handle smoothing
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      } catch {
        // Cross-origin taint — silently skip
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playerRef]);

  // Canvas positioned EXACTLY over the player. The CSS blur() filter extends
  // the colors ~blur_radius pixels beyond the canvas's bounding box in every
  // direction — that overflow IS the visible ambient light. The player (z-10)
  // covers the sharp center; only the blurred tail remains visible around it.
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      width={48}
      height={27}
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{
        zIndex: 0,
        filter: "blur(140px) saturate(1.8)",
        transform: "scale(1.1)",
        opacity: 0.95,
      }}
    />
  );
}

/**
 * Unified player:
 *  - Direct streams → Vidstack MediaPlayer with DefaultVideoLayout
 *    (speed / quality / captions / chromecast / PiP, pink #E94560 accent,
 *     live ambient light sampled from video frames)
 *  - Iframe embeds → same chrome + poster-only ambient glow (can't inject
 *    controls cross-origin)
 */
export default function UniversalPlayer({
  streamData,
  poster,
  onError,
  ambient = true,
  serverId,
  downloadName = "anime.mp4",
}: Props) {
  const playerRef = useRef<MediaPlayerInstance>(null);
  const [subSettingsOpen, setSubSettingsOpen] = useState(false);
  // Reference to the vds-controls-group element where we portal our buttons.
  const [controlsGroupEl, setControlsGroupEl] = useState<HTMLElement | null>(null);

  // Wait for Vidstack to render its controls, then grab the bottom group.
  useEffect(() => {
    let cancelled = false;
    const find = () => {
      if (cancelled) return;
      const playerEl = playerRef.current?.el as HTMLElement | undefined;
      if (!playerEl) {
        setTimeout(find, 200);
        return;
      }
      // Bottom controls group — last vds-controls-group in the player
      const groups = playerEl.querySelectorAll<HTMLElement>(".vds-controls-group");
      const bottom = groups[groups.length - 1] || null;
      if (bottom) {
        setControlsGroupEl(bottom);
      } else {
        setTimeout(find, 200);
      }
    };
    find();
    return () => {
      cancelled = true;
    };
  }, []);

  const bestStream =
    streamData?.streams?.[0] || streamData?.sources?.[0] || null;
  const iframeSrc = streamData?.iframe || null;

  if (streamData?.error || (!bestStream && !iframeSrc)) {
    return (
      <div className="flex-center aspect-video w-full h-full bg-black text-white/50 font-karla">
        Source unavailable
      </div>
    );
  }

  // ── Iframe embeds ──
  if (iframeSrc) {
    // Vidmoly is anti-embed for non-whitelisted domains. Sending no referer
    // sometimes bypasses the check; sandbox grants the JS-redirect chain
    // permissions to actually load the player.
    const isVidmoly = /vidmoly\.(to|biz|net)/i.test(iframeSrc);
    return (
      <div className="relative h-full w-full">
        {ambient && <StaticGlow poster={poster} intense />}
        <IframeEmbed
          src={iframeSrc}
          serverId={serverId}
          onError={onError}
          referrerPolicy={isVidmoly ? "no-referrer" : "origin"}
        />
      </div>
    );
  }

  // If the extractor pre-wrapped the URL through an external proxy (vidmoly →
  // anime-proxy), use it as-is. Otherwise wrap through our local proxy.
  const src = bestStream!.directUrl
    ? bestStream!.url
    : proxied(bestStream!.url, bestStream!.referer || streamData?.referer);
  const isM3U8 =
    bestStream!.isM3U8 === true ||
    (bestStream!.isM3U8 !== false && bestStream!.url.includes(".m3u8"));

  // Download URL — same-origin endpoint that streams the actual video.
  // For HLS, we use /api/v2/download-stream which fetches m3u8 + concatenates
  // every segment into one .ts file (browser saves it as a single playable
  // video, not a useless playlist file). For MP4, /api/v2/download streams
  // the file directly.
  const safeName = downloadName.replace(/[^\w.-]/g, "_") || "anime";
  const refererParam = bestStream!.referer || streamData?.referer;
  // Unwrap anime-proxy wrapping if present — download-stream handles its own
  // anime-proxy routing per host detection.
  const innerUrl = (() => {
    try {
      const u = new URL(bestStream!.url);
      if (u.hostname.endsWith("anime-api-proxy.vercel.app")) {
        const inner = u.searchParams.get("url");
        if (inner) return inner;
      }
    } catch {}
    return bestStream!.url;
  })();
  const ext = isM3U8 ? "ts" : "mp4";
  const downloadUrl = isM3U8
    ? `/api/v2/download-stream?url=${encodeURIComponent(innerUrl)}` +
      `&filename=${encodeURIComponent(safeName + ".ts")}` +
      (refererParam ? `&referer=${encodeURIComponent(refererParam)}` : "")
    : `/api/v2/download?url=${encodeURIComponent(innerUrl)}` +
      `&filename=${encodeURIComponent(safeName + ".mp4")}` +
      (refererParam ? `&referer=${encodeURIComponent(refererParam)}` : "");

  const subtitleTracks = (streamData?.subtitles || [])
    .map((s) => {
      const url = s.file || s.url;
      if (!url) return null;
      return {
        src: proxied(url, bestStream!.referer || streamData?.referer),
        label: s.label || s.language || "Subtitle",
        language: s.language || "en",
        kind: (s.kind as any) || "subtitles",
        default: s.default,
      };
    })
    .filter(Boolean) as Array<{
      src: string;
      label: string;
      language: string;
      kind: any;
      default?: boolean;
    }>;

  return (
    <div className="relative h-full w-full">
      {ambient && (
        <>
          <StaticGlow poster={poster} />
          <LiveAmbient playerRef={playerRef} />
        </>
      )}

      <MediaPlayer
        ref={playerRef}
        className="vds-player relative z-10 h-full w-full overflow-hidden bg-black"
        src={{
          src,
          type: isM3U8 ? "application/vnd.apple.mpegurl" : "video/mp4",
        }}
        poster={poster}
        load="eager"
        playsinline
        crossorigin="anonymous"
        aspectRatio="16/9"
        onError={() => onError?.("Playback error")}
      >
        <MediaProvider>
          {subtitleTracks.map((t, i) => (
            <Track
              key={t.src}
              src={t.src}
              kind={t.kind}
              label={t.label}
              language={t.language}
              default={t.default || i === 0}
            />
          ))}
        </MediaProvider>

        <DefaultVideoLayout icons={defaultLayoutIcons} />
      </MediaPlayer>

      {/* Buttons portaled INTO Vidstack's bottom control group — they sit
          directly next to the captions / settings / PiP / fullscreen buttons
          and inherit Vidstack's button sizing + chrome visibility. */}
      {controlsGroupEl && createPortal(
        <>
          <button
            type="button"
            onClick={() => setSubSettingsOpen(true)}
            title="Subtitle settings"
            aria-label="Subtitle settings"
            className="vds-button moopa-vds-btn group ring-media-focus relative inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-md outline-none ring-inset hover:bg-white/20 data-[focus]:ring-4"
            style={{ color: "rgb(var(--media-controls-color, 240 240 240))" }}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-7 w-7">
              <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-9 11H6v-2h5v2zm7 0h-5v-2h5v2zm0-4H6V9h12v2z" />
            </svg>
          </button>
          <a
            href={downloadUrl}
            download={`${safeName}.${ext}`}
            title={`Download ${ext.toUpperCase()}`}
            aria-label="Download"
            className="vds-button moopa-vds-btn group ring-media-focus relative inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-md outline-none ring-inset hover:bg-white/20 data-[focus]:ring-4"
            style={{ color: "rgb(var(--media-controls-color, 240 240 240))" }}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-7 w-7">
              <path d="M12 16l-5-5h3V4h4v7h3l-5 5zm-7 2h14v2H5v-2z" />
            </svg>
          </a>
        </>,
        controlsGroupEl
      )}

      {/* Hover preview — actual video frame at the cursor position on the scrubber */}
      <HoverPreview playerRef={playerRef} src={src} isM3U8={isM3U8} />

      <SubtitleSettings open={subSettingsOpen} onClose={() => setSubSettingsOpen(false)} />
    </div>
  );
}

function IframeEmbed({
  src,
  serverId,
  onError,
  referrerPolicy = "origin",
}: {
  src: string;
  serverId?: string;
  onError?: (reason?: string) => void;
  referrerPolicy?: React.HTMLAttributeReferrerPolicy;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    const timeout = setTimeout(() => {
      setFailed(true);
      onError?.("Iframe didn't load within 20s");
    }, 20000);
    const iframe = iframeRef.current;
    const handleLoad = () => clearTimeout(timeout);
    iframe?.addEventListener("load", handleLoad);
    return () => {
      clearTimeout(timeout);
      iframe?.removeEventListener("load", handleLoad);
    };
  }, [src, serverId]);

  if (failed) {
    return (
      <div className="flex-center aspect-video w-full h-full bg-black text-white/50 font-karla">
        Failed to load player
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      src={src}
      className="relative z-10 aspect-video h-full w-full bg-black"
      frameBorder="0"
      scrolling="no"
      allowFullScreen
      referrerPolicy={referrerPolicy}
      allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
    />
  );
}
