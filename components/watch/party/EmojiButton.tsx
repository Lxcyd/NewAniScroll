import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BsEmojiSmile } from "react-icons/bs";
import { ANIME_EMOJIS } from "@/lib/watch2gether/animeEmojis";

interface Props {
  /** Called with the text to insert (unicode emoji or `:shortcode:`). */
  onPick: (insert: string) => void;
  /** When true, portal the panel into the fullscreen player element so it's
   *  visible over the video (a body portal is hidden behind the FS element). */
  fullscreen?: boolean;
  className?: string;
}

// Lightweight, instant emoji picker styled to the app — no heavy third-party
// lib (PicMo was laggy + invisible in fullscreen). Shows our custom anime
// emojis first, then a compact set of standard unicode emojis.
const STANDARD = [
  "😀","😂","🥹","😍","😎","🤔","😭","😡","👍","👎","🙏","👏","🔥","💯","🎉","✨",
  "❤️","💔","💀","👀","😱","🥶","🤯","😴","🤝","🫡","🙌","😏","😈","🤡","🥳","😤",
];

export default function EmojiButton({ onPick, fullscreen, className = "" }: Props) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Position the panel above the trigger.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const PANEL_W = 280;
    const PANEL_H = 240;
    let left = r.left;
    left = Math.min(left, window.innerWidth - PANEL_W - 8);
    left = Math.max(8, left);
    const top = Math.max(8, r.top - PANEL_H - 8);
    setPos({ top, left });
  }, [open]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node))
        return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (insert: string) => {
    onPick(insert);
    setOpen(false);
  };

  // Portal target: the fullscreen element (so it shows over the video) or body.
  const portalTarget =
    typeof document === "undefined"
      ? null
      : fullscreen
        ? ((document.fullscreenElement as HTMLElement) ||
           (document as any).webkitFullscreenElement ||
           document.body)
        : document.body;

  const panel =
    open && pos && portalTarget
      ? createPortal(
          <div
            ref={panelRef}
            className="scrollbar-hide"
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              width: 280,
              height: 240,
              overflowY: "auto",
              zIndex: 2147483000,
              background: "#212127",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 12,
              padding: 10,
              boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
            }}
          >
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", margin: "2px 2px 6px" }}>
              Anime
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 2 }}>
              {ANIME_EMOJIS.map((e) => (
                <button
                  key={e.emoji}
                  type="button"
                  title={e.label}
                  onClick={() => pick(e.emoji)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 4,
                    borderRadius: 6,
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                  }}
                  onMouseEnter={(ev) => (ev.currentTarget.style.background = "rgba(255,255,255,0.1)")}
                  onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={e.url} alt={e.label} style={{ width: 22, height: 22 }} loading="lazy" />
                </button>
              ))}
            </div>

            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", margin: "10px 2px 6px" }}>
              Emoji
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 2 }}>
              {STANDARD.map((u) => (
                <button
                  key={u}
                  type="button"
                  onClick={() => pick(u)}
                  style={{
                    fontSize: 20,
                    lineHeight: "28px",
                    padding: 2,
                    borderRadius: 6,
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                  }}
                  onMouseEnter={(ev) => (ev.currentTarget.style.background = "rgba(255,255,255,0.1)")}
                  onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}
                >
                  {u}
                </button>
              ))}
            </div>
          </div>,
          portalTarget,
        )
      : null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Emoji"
        className={`flex h-9 w-9 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white ${className}`}
      >
        <BsEmojiSmile size={18} />
      </button>
      {panel}
    </>
  );
}
