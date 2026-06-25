import React from "react";
import { ANIME_EMOJI_MAP, SHORTCODE_RE } from "@/lib/watch2gether/animeEmojis";
import { ANIME_STICKER_MAP } from "@/lib/watch2gether/animeStickers";

interface Props {
  text: string;
  /** Inline image size in px. */
  size?: number;
}

// Renders chat text, turning known `:shortcode:` tokens into inline images:
//   • anime STICKERS (image-only, served from /public) — rendered a bit larger,
//   • the unicode-backed custom emoji set.
// Unknown shortcodes and plain unicode emoji pass through as text.
export default function ChatText({ text, size = 18 }: Props) {
  const parts = text.split(SHORTCODE_RE);
  return (
    <>
      {parts.map((part, i) => {
        const sticker = ANIME_STICKER_MAP[part];
        if (sticker) {
          return (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              src={sticker.src}
              alt={sticker.label}
              title={sticker.label}
              className="inline-block align-text-bottom"
              style={{ width: size * 1.4, height: size * 1.4 }}
              loading="lazy"
            />
          );
        }
        const custom = ANIME_EMOJI_MAP[part];
        if (custom) {
          return (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              src={custom.url}
              alt={custom.label}
              title={custom.label}
              className="inline-block align-text-bottom"
              style={{ width: size, height: size }}
            />
          );
        }
        return <React.Fragment key={i}>{part}</React.Fragment>;
      })}
    </>
  );
}
