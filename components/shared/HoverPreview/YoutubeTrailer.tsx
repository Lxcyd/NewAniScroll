import { useEffect, useRef, useState } from "react";

/**
 * The trailer frame of the hover preview — a port of Hayase's
 * `ui/cards/YoutubeIframe.svelte`.
 *
 * Everything here is driven by the YouTube iframe API's postMessage protocol,
 * with no SDK script loaded. The undocumented part is the handshake: you must
 * post `{"event":"listening",...}` INTO the frame before it sends anything back,
 * and the frame isn't listening the moment `load` fires — hence the 100 ms
 * interval that keeps asking until the first message arrives.
 *
 * The three messages we act on:
 *   - `onReady`         → set the volume to 30 (a trailer at 100 % on hover is
 *                         hostile).
 *   - `initialDelivery` → if `videoData.isPlayable` is false the video is
 *                         region-locked or embed-disabled; tell the parent to
 *                         drop us and keep the banner.
 *   - `infoDelivery`    → playerState 1 (playing) reveals the frame, so we never
 *                         cut from the banner to a black loading square;
 *                         playerState 0 (ended) loops manually.
 *
 * The loop is manual — `loop=1` needs `playlist=<id>`, and YouTube renders extra
 * chrome as soon as a playlist is set — so on ENDED we remount the iframe by
 * blanking the src for one tick.
 *
 * `pointer-events: none` is load-bearing: a cross-origin frame swallows the
 * pointer events HoverPreviewProvider uses to know the card is still hovered, so
 * the card would close the moment the pointer entered the trailer. The mute
 * control is therefore ours, sitting above the frame.
 */

const PARAMS = (muted: boolean) =>
  new URLSearchParams({
    autoplay: "1",
    controls: "0",
    disablekb: "1",
    cc_lang_pref: "ja",
    rel: "0",
    playsinline: "1",
    fs: "0",
    mute: muted ? "1" : "0",
  }).toString();

const ORIGIN = "https://www.youtube-nocookie.com";

export default function YoutubeTrailer({
  id,
  onHide,
}: {
  id: string;
  /** true = unplayable, drop the frame; false = playing, the banner can go. */
  onHide: (hidden: boolean) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [muted, setMuted] = useState(true);
  const [hidden, setHidden] = useState(true);
  // Blanked for one tick to force a remount when the video ends (manual loop).
  const [src, setSrc] = useState(id);

  const call = (func: string, args: string | null = null) => {
    frameRef.current?.contentWindow?.postMessage(
      `{"event":"command", "func":"${func}", "args":${args}}`,
      "*",
    );
  };

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== ORIGIN) return;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      let json: any;
      try {
        json = JSON.parse(e.data as string);
      } catch {
        return;
      }

      if (json.event === "onReady") call("setVolume", "[30]");

      if (json.event === "initialDelivery" && json.info?.videoData?.isPlayable === false) {
        onHide(true);
      }

      if (json.event === "infoDelivery") {
        if (json.info?.playerState === 1) {
          setHidden(false);
          onHide(false);
        } else if (json.info?.playerState === 0) {
          setSrc("");
          setTimeout(() => setSrc(id), 0);
        }
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [id, onHide]);

  const initFrame = () => {
    const ping = () =>
      frameRef.current?.contentWindow?.postMessage(
        '{"event":"listening","id":1,"channel":"widget"}',
        "*",
      );
    ping();
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(ping, 100);
  };

  const toggleMute = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    call(muted ? "unMute" : "mute");
    setMuted(!muted);
  };

  const params = PARAMS(muted);
  const frameClass = `absolute left-0 top-1/2 w-full h-[calc(100%+200px)] -translate-y-1/2 transform-gpu border-0 pointer-events-none transition-opacity duration-300 ${
    hidden ? "opacity-0" : "opacity-100"
  }`;

  return (
    <>
      {/* h-full w-full, not `size-full`: the project is on Tailwind 3.3 and the
          `size-*` shorthand only lands in 3.4 — Hayase's classes don't compile here. */}
      <div className="absolute top-0 h-full w-full overflow-clip rounded-t">
        <button
          type="button"
          onClick={toggleMute}
          aria-label={muted ? "Unmute" : "Mute"}
          className={`absolute right-0 top-0 z-10 p-3 text-white transition-opacity duration-300 ${
            hidden ? "opacity-0" : "opacity-100"
          }`}
        >
          {muted ? (
            // lucide volume-x
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="pointer-events-none"
            >
              <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />
              <line x1="22" x2="16" y1="9" y2="15" fill="none" />
              <line x1="16" x2="22" y1="9" y2="15" fill="none" />
            </svg>
          ) : (
            // lucide volume-2
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="pointer-events-none"
            >
              <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />
              <path d="M16 9a5 5 0 0 1 0 6" fill="none" />
              <path d="M19.364 18.364a9 9 0 0 0 0-12.728" fill="none" />
            </svg>
          )}
        </button>
        {src && (
          <iframe
            ref={frameRef}
            // Cookie-less embed: the frame gets an opaque origin, so a trailer
            // on a poster never joins the visitor to their YouTube identity.
            {...({ credentialless: "true" } as Record<string, string>)}
            title="trailer"
            allow="autoplay"
            className={frameClass}
            onLoad={initFrame}
            src={`${ORIGIN}/embed/${src}?${params}&enablejsapi=1`}
          />
        )}
      </div>

      {/* Hayase's signature: a second, muted copy of the same frame behind the
          card, blurred and over-saturated, so the trailer casts its own colour
          onto the page. It carries no API handshake — it is pure decoration. */}
      <div className="absolute top-0 -z-10 h-full w-full overflow-clip rounded-t blur-2xl saturate-200 pointer-events-none">
        {src && (
          <iframe
            {...({ credentialless: "true" } as Record<string, string>)}
            title=""
            aria-hidden
            allow="autoplay"
            className={frameClass}
            src={`${ORIGIN}/embed/${src}?${params}`}
          />
        )}
      </div>
    </>
  );
}
