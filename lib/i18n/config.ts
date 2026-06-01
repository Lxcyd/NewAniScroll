/**
 * Single i18next instance for the whole app. Resources are bundled (no
 * network fetch) so the very first render already has translations once the
 * client picks the language. SSR always renders the default locale; the
 * I18nProvider switches to the detected/chosen language on mount, matching
 * the existing client-only-pref approach used elsewhere (titlePref).
 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "../../locales/en.json";
import fr from "../../locales/fr.json";
import { DEFAULT_LANG } from "./languagePref";

if (!i18n.isInitialized) {
  i18n.use(initReactI18next).init({
    resources: {
      en: { translation: en },
      fr: { translation: fr },
    },
    lng: DEFAULT_LANG,
    fallbackLng: DEFAULT_LANG,
    supportedLngs: ["en", "fr"],
    interpolation: {
      // React already escapes values, so i18next escaping would double-encode.
      escapeValue: false,
    },
    react: {
      // We render translated strings synchronously; no Suspense needed since
      // resources are bundled.
      useSuspense: false,
    },
  });
}

export default i18n;
