// Emoji search keywords, split per language so the picker searches in the
// site's current language (an English UI searches English keywords, a French
// UI searches French ones). Sourced from the Unicode CLDR annotations.
import { EMOJI_KEYWORDS_EN } from "./emojiKeywords.en";
import { EMOJI_KEYWORDS_FR } from "./emojiKeywords.fr";

export type EmojiKeywordLang = "en" | "fr";

// Pick the keyword map for a given i18n language code. Anything that isn't
// French (incl. "en", "en-US", undefined) falls back to English.
export function emojiKeywordsFor(lang?: string): Record<string, string> {
  return (lang || "").toLowerCase().startsWith("fr") ? EMOJI_KEYWORDS_FR : EMOJI_KEYWORDS_EN;
}

export { EMOJI_KEYWORDS_EN, EMOJI_KEYWORDS_FR };
