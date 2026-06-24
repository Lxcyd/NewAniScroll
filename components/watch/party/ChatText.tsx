import React from "react";
import { ANIME_EMOJI_MAP, SHORTCODE_RE } from "@/lib/watch2gether/animeEmojis";

interface Props {
  text: string;
  /** Inline image size in px. */
  size?: number;
}

// Renders chat text, turning known `:shortcode:` tokens into inline emoji images.
// Unknown shortcodes and unicode emoji pass through as plain text.
export default function ChatText({ text, size = 18 }: Props) {
  const parts = text.split(SHORTCODE_RE);
  return (
    <>
      {parts.map((part, i) => {
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
