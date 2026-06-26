// Emoji search keywords, split per language so the picker searches in the
// site's current language (an English UI searches English keywords, a French
// UI searches French ones). Sourced from the Unicode CLDR annotations.
//
// Each language map is ~150KB, so they're loaded LAZILY (dynamic import) — only
// the active language, and only once the emoji picker actually needs it. This
// keeps them out of the initial chat bundle.

export type EmojiKeywordLang = "en" | "fr";

// Anything that isn't French (incl. "en", "en-US", undefined) → English.
function langOf(lang?: string): EmojiKeywordLang {
  return (lang || "").toLowerCase().startsWith("fr") ? "fr" : "en";
}

// Load the keyword map for a given i18n language code (lazy, cached by the
// module system on subsequent calls).
export async function loadEmojiKeywords(lang?: string): Promise<Record<string, string>> {
  if (langOf(lang) === "fr") {
    return (await import("./emojiKeywords.fr")).EMOJI_KEYWORDS_FR;
  }
  return (await import("./emojiKeywords.en")).EMOJI_KEYWORDS_EN;
}
