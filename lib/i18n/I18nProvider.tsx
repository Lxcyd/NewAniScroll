/**
 * Wraps the app in the i18next provider and keeps i18next's active language
 * in sync with our language preference (detected from the browser on first
 * mount, overridden by the user via the navbar switcher).
 *
 * Why a thin wrapper instead of i18next-browser-languagedetector directly:
 * we already own the detection + persistence logic in languagePref.ts (so it
 * stays consistent with how the rest of the app stores client prefs), and we
 * need to listen to our own same-tab LANG_EVENT to re-sync instantly when the
 * user toggles the language.
 */

import { ReactNode, useEffect, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { useRouter } from "next/router";

import i18n, { ensureLanguage } from "./config";
import { getLang, LANG_EVENT, Lang } from "./languagePref";
import { replaceUrlPreservingState } from "@/lib/navigation/replaceUrl";

/**
 * Swap the visible URL's locale prefix to match the active language. When the
 * site language is French we show `/fr/...`; English shows `/en/...`. The /fr
 * URLs are rewritten to the /en page tree in next.config.js, so this is purely
 * cosmetic (the page already rendered) and reload/share-safe.
 *
 * MUST go through replaceUrlPreservingState: this runs after EVERY route
 * change, and the old raw `history.replaceState(null, …)` nulled Next's router
 * state on every entry of a French session — which is what broke back/forward
 * site-wide (Next's popstate does nothing when the entry's state is null).
 */
function syncUrlLocale(lang: Lang) {
  if (typeof window === "undefined") return;
  const { pathname, search, hash } = window.location;
  const want = lang === "fr" ? "/fr" : "/en";
  const other = lang === "fr" ? "/en" : "/fr";
  // Only rewrite when the path starts with the OTHER locale prefix.
  if (pathname === other || pathname.startsWith(other + "/")) {
    const swapped = want + pathname.slice(other.length);
    replaceUrlPreservingState(swapped + search + hash);
  }
}

export default function I18nProvider({ children }: { children: ReactNode }) {
  // Track the active language in state so a change forces a re-render of the
  // whole tree (translations re-resolve). Start at i18n's current language to
  // avoid an SSR/CSR hydration mismatch; the effect below switches it.
  const [, setLang] = useState<Lang>(() => (i18n.language as Lang) || "en");
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    // Only the default locale is bundled (see ./config); a non-default one is
    // fetched as its own chunk. Await it before switching so we never flip
    // i18next onto a language whose strings haven't landed yet.
    const apply = async () => {
      const next = getLang();
      await ensureLanguage(next);
      if (cancelled) return;
      if (i18n.language !== next) i18n.changeLanguage(next);
      setLang(next);
      if (typeof document !== "undefined") {
        document.documentElement.lang = next;
      }
      syncUrlLocale(next);
    };
    // Initial detection on mount (browser language or stored override).
    apply();
    // Re-sync when the user toggles the language anywhere in the app.
    window.addEventListener(LANG_EVENT, apply);
    return () => {
      cancelled = true;
      window.removeEventListener(LANG_EVENT, apply);
    };
  }, []);

  // Re-apply the locale prefix after every client navigation. Pages do their
  // own slug canonicalization with /en, so we re-assert /fr once they settle.
  useEffect(() => {
    const onDone = () => syncUrlLocale(getLang());
    router.events.on("routeChangeComplete", onDone);
    return () => router.events.off("routeChangeComplete", onDone);
  }, [router.events]);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
