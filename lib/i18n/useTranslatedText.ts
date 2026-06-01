import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Translate a chunk of third-party English text (e.g. an AniList synopsis)
 * into the active UI language on the fly, via /api/v2/translate (Redis-cached
 * server-side). Returns the original text immediately, then swaps in the
 * translation once it resolves — so there's never a blank flash, and English
 * is always the graceful fallback if translation fails or the language is EN.
 *
 * A module-level in-memory cache dedupes repeat requests within a session and
 * is shared with `prefetchTranslations`, so content translated ahead of time
 * (e.g. the home hero carousel) renders instantly with no English flash.
 */
const memCache = new Map<string, string>();
// Tracks in-flight requests so concurrent callers (a prefetch + a live hook)
// don't fire duplicate POSTs for the same text.
const inflight = new Map<string, Promise<string>>();

function cacheKeyOf(text: string, lang: string) {
  return `${lang}:${text}`;
}

/** Translate one string, hitting the in-memory cache / dedup first. */
function translateOne(text: string, lang: string): Promise<string> {
  const key = cacheKeyOf(text, lang);
  const cached = memCache.get(key);
  if (cached != null) return Promise.resolve(cached);
  const existing = inflight.get(key);
  if (existing) return existing;

  const p = fetch("/api/v2/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, target: lang }),
  })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((data) => {
      const result = data?.translated && data.text ? data.text : text;
      memCache.set(key, result);
      return result as string;
    })
    .catch(() => text)
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, p);
  return p;
}

/**
 * Warm the cache for a batch of strings (e.g. every hero-carousel synopsis)
 * so they're already translated by the time the user reaches each slide.
 * No-op for English. Fire-and-forget; runs the requests in parallel.
 */
export function prefetchTranslations(
  texts: Array<string | null | undefined>,
  lang: string,
) {
  if (!lang || lang === "en") return;
  for (const t of texts) {
    const text = (t || "").trim();
    if (!text) continue;
    if (memCache.has(cacheKeyOf(text, lang))) continue;
    // Fire and forget — result lands in memCache for the live hook to read.
    void translateOne(text, lang);
  }
}

export function useTranslatedText(source: string | null | undefined): string {
  const { i18n } = useTranslation();
  const lang = i18n.language || "en";
  const text = (source || "").trim();

  // Initialise from cache synchronously so a pre-translated string renders
  // with no English flash on the very first paint.
  const [out, setOut] = useState<string>(() => {
    if (!text || lang === "en") return source || "";
    return memCache.get(cacheKeyOf(text, lang)) ?? (source || "");
  });

  useEffect(() => {
    if (!text || lang === "en") {
      setOut(source || "");
      return;
    }
    const cached = memCache.get(cacheKeyOf(text, lang));
    if (cached != null) {
      setOut(cached);
      return;
    }
    // Show the original while the translation is in flight.
    setOut(source || "");
    let cancelled = false;
    translateOne(text, lang).then((res) => {
      if (!cancelled) setOut(res);
    });
    return () => {
      cancelled = true;
    };
  }, [source, lang, text]);

  return out;
}
