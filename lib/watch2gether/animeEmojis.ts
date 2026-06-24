// Curated custom "anime" emojis for the Watch 2gether chat.
//
// These are passed to PicMo's `custom` option and used to render `:shortcode:`
// tokens in chat messages. Images are referenced by REMOTE URL — nothing is
// imported/bundled, so you can freely add/remove entries here without touching
// any build step. Just keep each `emoji` shortcode unique.
//
// NOTE on sources: use stable, CORS-friendly image hosts (PNG/GIF/WEBP, ideally
// square ~64–128px). If a URL 404s the emoji simply won't render — non-fatal.
// Swap these for your own preferred art any time.

export interface AnimeEmoji {
  /** Shortcode used in chat text, e.g. ":kannapog:" */
  emoji: string;
  /** Human label shown in the picker tooltip / search. */
  label: string;
  /** Remote image URL. */
  url: string;
  /** Optional search tags for the picker. */
  tags?: string[];
}

// A small starter set. Replace/extend with your own curated art.
export const ANIME_EMOJIS: AnimeEmoji[] = [
  { emoji: ":pikapog:", label: "Pikachu POG", url: "https://cdn3.emoji.gg/emojis/8434-pikachu-pog.png", tags: ["pokemon", "pog"] },
  { emoji: ":narutorun:", label: "Naruto run", url: "https://cdn3.emoji.gg/emojis/4920_naruto.png", tags: ["naruto", "run"] },
  { emoji: ":zorohap:", label: "Zoro happy", url: "https://cdn3.emoji.gg/emojis/3219-zoro.png", tags: ["onepiece", "zoro"] },
  { emoji: ":luffygear:", label: "Luffy gear", url: "https://cdn3.emoji.gg/emojis/9921-luffy.png", tags: ["onepiece", "luffy"] },
  { emoji: ":gojo:", label: "Gojo", url: "https://cdn3.emoji.gg/emojis/3081-gojo.png", tags: ["jjk", "gojo"] },
  { emoji: ":animecry:", label: "Anime cry", url: "https://cdn3.emoji.gg/emojis/5183-anime-cry.png", tags: ["sad", "cry"] },
  { emoji: ":uwu:", label: "UwU", url: "https://cdn3.emoji.gg/emojis/9020-uwu.png", tags: ["uwu", "cute"] },
  { emoji: ":nani:", label: "NANI?!", url: "https://cdn3.emoji.gg/emojis/2056-nani.png", tags: ["shock", "nani"] },
  { emoji: ":animelaugh:", label: "Anime laugh", url: "https://cdn3.emoji.gg/emojis/6739-anime-laugh.png", tags: ["laugh", "funny"] },
  { emoji: ":blushanime:", label: "Anime blush", url: "https://cdn3.emoji.gg/emojis/1652-blush.png", tags: ["blush", "cute"] },
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
