import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Translate a chunk of third-party English text (e.g. an AniList synopsis)
 * into the active UI language on the fly, via /api/v2/translate (Redis-cached
 * server-side). Returns the original text immediately, then swaps in the
 * translation once it resolves — so there's never a blank flash, and English
 * is always the graceful fallback if translation fails or the language is EN.
 *
 * A small in-memory cache dedupes repeat requests within a session (e.g.
 * navigating back to the same anime) so we don't re-hit the API.
 */
const memCache = new Map<string, string>();

export function useTranslatedText(source: string | null | undefined): string {
  const { i18n } = useTranslation();
  const lang = i18n.language || "en";
  const [out, setOut] = useState<string>(source || "");

  useEffect(() => {
    const text = source || "";
    // English (source language) or empty → nothing to translate.
    if (!text.trim() || lang === "en") {
      setOut(text);
      return;
    }

    const key = `${lang}:${text}`;
    const cached = memCache.get(key);
    if (cached != null) {
      setOut(cached);
      return;
    }

    // Show the original while the translation is in flight.
    setOut(text);

    let cancelled = false;
    fetch("/api/v2/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, target: lang }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data) => {
        if (cancelled) return;
        if (data?.translated && data.text) {
          memCache.set(key, data.text);
          setOut(data.text);
        }
      })
      .catch(() => {
        /* keep the English original */
      });

    return () => {
      cancelled = true;
    };
  }, [source, lang]);

  return out;
}
