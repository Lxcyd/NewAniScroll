import React, { useEffect, useRef } from "react";
import { BsEmojiSmile } from "react-icons/bs";
import { ANIME_EMOJIS } from "@/lib/watch2gether/animeEmojis";

interface Props {
  /** Called with the text to insert (unicode emoji or `:shortcode:`). */
  onPick: (insert: string) => void;
  /** Optional dark/light theme for the picker. */
  className?: string;
}

// Emoji picker trigger backed by PicMo (dynamically imported, client-only).
// Standard emojis insert their unicode char; custom anime emojis insert their
// `:shortcode:` (resolved to an <img> when the chat renders).
export default function EmojiButton({ onPick, className = "" }: Props) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<any>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    let disposed = false;

    (async () => {
      try {
        const [{ createPopup }] = await Promise.all([import("@picmo/popup-picker")]);
        if (disposed || !btnRef.current) return;

        const custom = ANIME_EMOJIS.map((e) => ({
          emoji: e.emoji,
          label: e.label,
          url: e.url,
          tags: e.tags,
        }));

        const popup = createPopup(
          {
            custom,
            // Categories left default; PicMo adds a "custom" category for ours.
          },
          {
            triggerElement: btnRef.current,
            referenceElement: btnRef.current,
            position: "top-start",
            showCloseButton: true,
          },
        );

        popup.addEventListener("emoji:select", (selection: any) => {
          // For custom emojis PicMo returns the shortcode in `emoji`; for
          // standard ones it's the unicode character.
          onPickRef.current(selection.emoji);
        });

        popupRef.current = popup;
      } catch (err) {
        // PicMo not installed / failed to load — button becomes a no-op.
        console.warn("[w2g] emoji picker unavailable:", err);
      }
    })();

    return () => {
      disposed = true;
      try {
        popupRef.current?.destroy?.();
      } catch {
        /* noop */
      }
      popupRef.current = null;
    };
  }, []);

  const toggle = () => {
    popupRef.current?.toggle?.();
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
