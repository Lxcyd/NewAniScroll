/**
 * Single i18next instance for the whole app.
 *
 * Only the DEFAULT locale is bundled. It is the one SSR renders, so it has to
 * be there synchronously on first paint — but the *other* locale used to be
 * bundled alongside it in the shared `_app` chunk, which meant every visitor
 * downloaded ~48 kB of translations they would never read (~15 kB gzipped on
 * EVERY page of the site). `ensureLanguage()` fetches a non-default locale as
 * its own chunk, on demand.
 *
 * The switch to the detected/chosen language already happened in an effect
 * after mount (I18nProvider), so the visible behaviour is unchanged apart from
 * the chunk fetch — and that fetch is kicked off at module-evaluation time
 * below, in parallel with hydration, rather than waiting for the effect.
 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "../../locales/en.json";
import { DEFAULT_LANG, getLang, Lang, SUPPORTED_LANGS } from "./languagePref";

if (!i18n.isInitialized) {
  i18n.use(initReactI18next).init({
    resources: {
      en: { translation: en },
    },
    lng: DEFAULT_LANG,
    fallbackLng: DEFAULT_LANG,
    supportedLngs: SUPPORTED_LANGS,
    // Non-default locales arrive via addResourceBundle (ensureLanguage), so
    // i18next must not treat a not-yet-loaded language as "nothing to render".
    partialBundledLanguages: true,
    interpolation: {
      // React already escapes values, so i18next escaping would double-encode.
      escapeValue: false,
    },
    react: {
      // We render translated strings synchronously; no Suspense needed since
      // the active bundle is always present by the time we changeLanguage().
      useSuspense: false,
    },
  });
}

/** In-flight / settled loads, so a language is only ever fetched once. */
const loading = new Map<Lang, Promise<void>>();

/**
 * Make sure `lang`'s translations are registered on the i18next instance.
 * Resolves immediately for the bundled default (and for anything already
 * loaded). Never rejects: a failed chunk fetch leaves the UI on the fallback
 * locale rather than breaking the page.
 */
export function ensureLanguage(lang: Lang): Promise<void> {
  if (lang === DEFAULT_LANG || i18n.hasResourceBundle(lang, "translation")) {
    return Promise.resolve();
  }
  const pending = loading.get(lang);
  if (pending) return pending;

  const p = import(`../../locales/${lang}.json`)
    .then((mod) => {
      i18n.addResourceBundle(lang, "translation", mod.default ?? mod, true, true);
    })
    .catch(() => {
      // Allow a later attempt (e.g. the user toggles the language again after
      // a transient network failure) to retry instead of resolving instantly.
      loading.delete(lang);
    });
  loading.set(lang, p);
  return p;
}

// Start fetching the visitor's locale as soon as this module evaluates, so the
// request overlaps hydration instead of waiting for I18nProvider's effect.
if (typeof window !== "undefined") {
  const lang = getLang();
  if (lang !== DEFAULT_LANG) void ensureLanguage(lang);
}

export default i18n;
