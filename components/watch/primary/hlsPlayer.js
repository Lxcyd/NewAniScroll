import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { Spinner } from "@vidstack/react";

function proxyUrl(url, referer) {
  if (!url) return url;
  const ref = referer ? `&referer=${encodeURIComponent(referer)}` : "";
  return `/api/v2/proxy/m3u8?url=${encodeURIComponent(url)}${ref}`;
}

export default function HlsPlayer({ streamData, poster, onError }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Pick the best stream
  const bestStream = streamData?.streams?.[0] || streamData?.sources?.[0];
  const streamUrl = bestStream?.url || null;
  // Per-stream referer takes priority over top-level
  const streamReferer = bestStream?.referer || streamData?.referer || null;
  const isM3U8 = bestStream?.isM3U8 !== false &&
    (bestStream?.isM3U8 === true || streamUrl?.includes(".m3u8"));

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !streamUrl) return;

    setLoading(true);
    setError(null);

    const src = proxyUrl(streamUrl, streamReferer);

    // Initial load timeout: if no playback within 15s, mark as failed
    const loadTimeout = setTimeout(() => {
      if (video.readyState < 2) {
        setLoading(false);
        setError("Stream timed out");
        onError?.("Stream timeout (no metadata in 15s)");
      }
    }, 15000);

    // Stall detection: once playback starts, watch for currentTime advancing.
    // If video is "playing" but time stays frozen for 10s → mark broken.
    let stallTimer = null;
    let lastTime = -1;
    let stallCount = 0;
    const startStallWatch = () => {
      if (stallTimer) return;
      stallTimer = setInterval(() => {
        if (video.paused || video.readyState < 3) {
          stallCount = 0;
          lastTime = video.currentTime;
          return;
        }
        if (video.currentTime === lastTime) {
          stallCount++;
          if (stallCount >= 10) {
            // 10 seconds of no progress while playing
            setError("Playback stalled (no frames advancing)");
            onError?.("Playback stalled (no progress for 10s)");
            clearInterval(stallTimer);
          }
        } else {
          stallCount = 0;
          lastTime = video.currentTime;
        }
      }, 1000);
    };

    const cleanup = () => {
      clearTimeout(loadTimeout);
      if (stallTimer) clearInterval(stallTimer);
    };

    // ── MP4 / direct video file (sibnet, sendvid extractor output) ──
    if (!isM3U8) {
      video.src = src;
      const onMeta = () => {
        setLoading(false);
        clearTimeout(loadTimeout);
        video.play().catch(() => {});
        startStallWatch();
      };
      const onErr = () => {
        setLoading(false);
        setError("Failed to load video");
        cleanup();
        onError?.("Video element error");
      };
      video.addEventListener("loadedmetadata", onMeta);
      video.addEventListener("error", onErr);
      return () => {
        video.removeEventListener("loadedmetadata", onMeta);
        video.removeEventListener("error", onErr);
        cleanup();
      };
    }

    // ── HLS via hls.js ──
    if (Hls.isSupported()) {
      const hls = new Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
      });
      hlsRef.current = hls;

      hls.loadSource(src);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setLoading(false);
        clearTimeout(loadTimeout);
        video.play().catch(() => {});
        startStallWatch();
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          setLoading(false);
          setError("Failed to load stream");
          cleanup();
          onError?.(`HLS ${data.type || "error"}`);
          hls.destroy();
        }
      });

      return () => {
        cleanup();
        hls.destroy();
        hlsRef.current = null;
      };
    }

    // ── Native HLS (Safari) ──
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      const onMeta = () => {
        setLoading(false);
        clearTimeout(loadTimeout);
        video.play().catch(() => {});
        startStallWatch();
      };
      const onErr = () => {
        setLoading(false);
        setError("Failed to load stream");
        cleanup();
        onError?.();
      };
      video.addEventListener("loadedmetadata", onMeta);
      video.addEventListener("error", onErr);
      return () => {
        video.removeEventListener("loadedmetadata", onMeta);
        video.removeEventListener("error", onErr);
        cleanup();
      };
    }

    setError("HLS not supported in this browser");
    setLoading(false);
    cleanup();
    onError?.("HLS not supported");
  }, [streamUrl, streamReferer, isM3U8]);

  // Apply subtitles
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !streamData?.subtitles) return;

    while (video.firstChild) {
      video.removeChild(video.firstChild);
    }

    streamData.subtitles.forEach((sub, i) => {
      const track = document.createElement("track");
      track.kind = sub.kind || "captions";
      track.label = sub.label || `Subtitle ${i + 1}`;
      track.src = proxyUrl(sub.file || sub.url, streamReferer);
      if (i === 0) track.default = true;
      video.appendChild(track);
    });
  }, [streamData?.subtitles]);

  if (!streamUrl) {
    return (
      <div className="flex-center aspect-video w-full h-full bg-black text-white/50 font-karla">
        {error || "No stream available for this server"}
      </div>
    );
  }

  return (
    <div className="relative aspect-video w-full h-full bg-black">
      {loading && (
        <div className="pointer-events-none absolute inset-0 z-50 flex h-full w-full items-center justify-center">
          <Spinner.Root className="text-white animate-spin opacity-100" size={84}>
            <Spinner.Track className="opacity-25" width={8} />
            <Spinner.TrackFill className="opacity-75" width={8} />
          </Spinner.Root>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex-center text-white/50 font-karla text-sm z-50">
          {error}
        </div>
      )}
      <video
        ref={videoRef}
        className="w-full h-full"
        controls
        playsInline
        poster={poster}
      />
    </div>
  );
}
