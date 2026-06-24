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
  /** Optional search tags for the picker. */
  tags?: string[];
}

// Twemoji 72px assets on jsDelivr (jdecked fork = actively maintained).
const TW = (code: string) =>
  `https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/72x72/${code}.png`;

export const ANIME_EMOJIS: AnimeEmoji[] = [
  { emoji: ":pog:", label: "POG", url: TW("1f632"), tags: ["wow", "shock", "pog"] },
  { emoji: ":lul:", label: "Laughing", url: TW("1f602"), tags: ["laugh", "lol"] },
  { emoji: ":love:", label: "Love it", url: TW("1f60d"), tags: ["love", "heart eyes"] },
  { emoji: ":cry:", label: "Crying", url: TW("1f62d"), tags: ["cry", "sad"] },
  { emoji: ":fire:", label: "Fire", url: TW("1f525"), tags: ["fire", "lit"] },
  { emoji: ":clap:", label: "Clap", url: TW("1f44f"), tags: ["clap", "applause"] },
  { emoji: ":heart:", label: "Heart", url: TW("2764"), tags: ["heart", "love"] },
  { emoji: ":cool:", label: "Cool", url: TW("1f60e"), tags: ["cool", "sunglasses"] },
  { emoji: ":scream:", label: "Scream", url: TW("1f631"), tags: ["scream", "shock"] },
  { emoji: ":sparkle:", label: "Sparkles", url: TW("2728"), tags: ["sparkle", "shiny"] },
  { emoji: ":gg:", label: "GG", url: TW("1f3c6"), tags: ["trophy", "win", "gg"] },
  { emoji: ":sleep:", label: "Sleepy", url: TW("1f634"), tags: ["sleep", "boring"] },
  { emoji: ":think:", label: "Thinking", url: TW("1f914"), tags: ["think", "hmm"] },
  { emoji: ":party:", label: "Party", url: TW("1f389"), tags: ["party", "celebrate"] },
  { emoji: ":eyes:", label: "Eyes", url: TW("1f440"), tags: ["eyes", "look"] },
  { emoji: ":skull:", label: "Skull", url: TW("1f480"), tags: ["skull", "dead", "lmao"] },
];

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
