// Custom emojis for the Watch 2gether chat.
//
// Referenced by REMOTE URL (nothing bundled) and rendered as inline <img> for
// `:shortcode:` tokens. The images below use Twemoji via jsDelivr — a stable,
// CORS-friendly CDN (verified reachable) so they ALWAYS load. They're colorful
// reaction emojis to get the feature working reliably.
//
// 👉 To use real ANIME-CHARACTER art instead, just swap an entry's `url` for any
//    stable image URL (PNG/GIF/WEBP). Keep each `emoji` shortcode unique. If a
//    URL ever 404s, that emoji simply won't render — nothing else breaks.

export interface AnimeEmoji {
  /** Shortcode used in chat text, e.g. ":pog:" */
  emoji: string;
  /** Human label shown in the picker tooltip / search. */
  label: string;
  /** Remote image URL. */
  url: string;
  /** Unicode codepoint(s), space-separated hex (e.g. "1f632"). */
  code: string;
  /** Optional search tags for the picker. */
  tags?: string[];
}

// Twemoji 72px assets on jsDelivr (jdecked fork = actively maintained).
const TW = (code: string) =>
  `https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/72x72/${code}.png`;

// Build an AnimeEmoji entry from a single codepoint, deriving both the image URL
// and the actual unicode character so `:shortcode:` can be auto-replaced inline.
function e(emoji: string, label: string, code: string, tags: string[]): AnimeEmoji {
  return { emoji, label, url: TW(code), code, tags };
}

export const ANIME_EMOJIS: AnimeEmoji[] = [
  e(":pog:", "POG", "1f632", ["wow", "shock", "pog"]),
  e(":lul:", "Laughing", "1f602", ["laugh", "lol"]),
  e(":love:", "Love it", "1f60d", ["love", "heart eyes"]),
  e(":cry:", "Crying", "1f62d", ["cry", "sad"]),
  e(":fire:", "Fire", "1f525", ["fire", "lit"]),
  e(":clap:", "Clap", "1f44f", ["clap", "applause"]),
  e(":heart:", "Heart", "2764", ["heart", "love"]),
  e(":cool:", "Cool", "1f60e", ["cool", "sunglasses"]),
  e(":scream:", "Scream", "1f631", ["scream", "shock"]),
  e(":sparkle:", "Sparkles", "2728", ["sparkle", "shiny"]),
  e(":gg:", "GG", "1f3c6", ["trophy", "win", "gg"]),
  e(":sleep:", "Sleepy", "1f634", ["sleep", "boring"]),
  e(":think:", "Thinking", "1f914", ["think", "hmm"]),
  e(":party:", "Party", "1f389", ["party", "celebrate"]),
  e(":eyes:", "Eyes", "1f440", ["eyes", "look"]),
  e(":skull:", "Skull", "1f480", ["skull", "dead", "lmao"]),
];

/** Convert a space-separated hex codepoint string to its unicode character. */
export function codeToChar(code: string): string {
  return code
    .split(/\s+/)
    .map((c) => String.fromCodePoint(parseInt(c, 16)))
    .join("");
}

/** Map of `:shortcode:` → unicode character, for live input auto-replacement. */
export const SHORTCODE_TO_CHAR: Record<string, string> = ANIME_EMOJIS.reduce(
  (acc, em) => {
    acc[em.emoji] = codeToChar(em.code);
    return acc;
  },
  {} as Record<string, string>,
);

/** Replace any KNOWN `:shortcode:` in a string with its unicode emoji char. */
export function replaceShortcodes(text: string): string {
  return text.replace(SHORTCODE_RE, (m) => SHORTCODE_TO_CHAR[m] ?? m);
}

/** Lookup map for fast `:shortcode:` → url resolution when rendering chat. */
export const ANIME_EMOJI_MAP: Record<string, AnimeEmoji> = ANIME_EMOJIS.reduce(
  (acc, e) => {
    acc[e.emoji] = e;
    return acc;
  },
  {} as Record<string, AnimeEmoji>,
);

// Matches any `:shortcode:` token (letters/digits/_).
export const SHORTCODE_RE = /(:[a-z0-9_]+:)/gi;
