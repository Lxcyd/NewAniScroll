import React, { useEffect, useRef } from "react";
import { BsEmojiSmile } from "react-icons/bs";
import { ANIME_EMOJIS } from "@/lib/watch2gether/animeEmojis";

interface Props {
  /** Called with the text to insert (unicode emoji or `:shortcode:`). */
  onPick: (insert: string) => void;
  className?: string;
}

// PicMo is loaded from a CDN at RUNTIME (browser, on click) rather than bundled.
// This keeps it entirely out of the webpack build graph — so a missing package
// can never break `next build` — and it's client-only anyway (it touches
// window/document at module scope, which would crash during SSR).
const PICMO_URL = "https://esm.sh/@picmo/popup-picker@5.8.5";
const PICMO_CSS = "https://esm.sh/@picmo/popup-picker@5.8.5/dist/index.css";

let picmoModPromise: Promise<any> | null = null;
function loadPicmo(): Promise<any> {
  if (picmoModPromise) return picmoModPromise;
  // Inject the stylesheet once.
  if (typeof document !== "undefined" && !document.getElementById("picmo-css")) {
    const link = document.createElement("link");
    link.id = "picmo-css";
    link.rel = "stylesheet";
    link.href = PICMO_CSS;
    document.head.appendChild(link);
  }
  // webpackIgnore so webpack leaves this as a native browser import of a URL.
  picmoModPromise = import(/* webpackIgnore: true */ PICMO_URL).catch((e) => {
    picmoModPromise = null;
    throw e;
  });
  return picmoModPromise;
}

export default function EmojiButton({ onPick, className = "" }: Props) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<any>(null);
  const buildingRef = useRef(false);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    return () => {
      try {
        popupRef.current?.destroy?.();
      } catch {
        /* noop */
      }
      popupRef.current = null;
    };
  }, []);

  const ensurePopup = async () => {
    if (popupRef.current || buildingRef.current || !btnRef.current) return popupRef.current;
    buildingRef.current = true;
    try {
      const mod: any = await loadPicmo();
      const createPopup = mod?.createPopup;
      if (typeof createPopup !== "function" || !btnRef.current) return null;

      const custom = ANIME_EMOJIS.map((e) => ({
        emoji: e.emoji,
        label: e.label,
        url: e.url,
        tags: e.tags,
      }));

      const popup = createPopup(
        { custom },
        {
          triggerElement: btnRef.current,
          referenceElement: btnRef.current,
          position: "top-start",
          showCloseButton: true,
        },
      );
      popup.addEventListener("emoji:select", (selection: any) => {
        onPickRef.current(selection.emoji);
      });
      popupRef.current = popup;
      return popup;
    } catch (err) {
      console.warn("[w2g] emoji picker unavailable:", err);
      return null;
    } finally {
      buildingRef.current = false;
    }
  };

  const toggle = async () => {
    const popup = await ensurePopup();
    popup?.toggle?.();
  };

  return (
    <button
      ref={btnRef}
      type="button"
      onClick={toggle}
      title="Emoji"
      className={`flex h-9 w-9 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white ${className}`}
    >
      <BsEmojiSmile size={18} />
    </button>
  );
}
