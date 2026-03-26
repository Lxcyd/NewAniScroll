import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { Spinner } from "@vidstack/react";

const PROXY_URL = process.env.NEXT_PUBLIC_HLS_PROXY || "";

function proxyUrl(url) {
  if (!url || !PROXY_URL) return url;
  return `${PROXY_URL}/?url=${encodeURIComponent(url)}`;
}

export default function HlsPlayer({ streamData, poster }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const streamUrl =
    streamData?.streams?.[0]?.url || streamData?.sources?.[0]?.url || null;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !streamUrl) return;

    setLoading(true);
    setError(null);

    const src = proxyUrl(streamUrl);

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
        video.play().catch(() => {});
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          setLoading(false);
          setError("Failed to load stream");
          hls.destroy();
        }
      });

      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari native HLS
      video.src = src;
      video.addEventListener("loadedmetadata", () => {
        setLoading(false);
        video.play().catch(() => {});
      });
    } else {
      setError("HLS not supported in this browser");
      setLoading(false);
    }
  }, [streamUrl]);

  // Apply subtitles
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !streamData?.subtitles) return;

    // Remove existing tracks
    while (video.firstChild) {
      video.removeChild(video.firstChild);
    }

    streamData.subtitles.forEach((sub, i) => {
      const track = document.createElement("track");
      track.kind = sub.kind || "captions";
      track.label = sub.label || `Subtitle ${i + 1}`;
      track.src = proxyUrl(sub.file || sub.url);
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
        crossOrigin="anonymous"
      />
    </div>
  );
}
