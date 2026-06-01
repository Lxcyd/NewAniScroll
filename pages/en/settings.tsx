import Head from "next/head";
import { motion } from "framer-motion";
import { Navbar } from "@/components/shared/NavBar";
import Footer from "@/components/shared/footer";
import {
  getTitlePref,
  setTitlePref,
  TitlePref,
  useTitlePref,
} from "@/lib/prefs/titlePref";
import { getLang, setLang, Lang, LANG_EVENT } from "@/lib/i18n/languagePref";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/* Reusable segmented switch. Three-option flavour is used by the title
   preference picker; two-option by the UI language placeholder. Kept
   inline (not extracted) because it's the only place we render this
   widget and a generic abstraction would obscure the styling intent. */
function SegmentedPicker<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; sub?: string; disabled?: boolean }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg bg-white/5 ring-1 ring-white/10 p-1 gap-1">
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={opt.disabled}
            onClick={() => !opt.disabled && onChange(opt.value)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors min-w-[88px] ${
              opt.disabled
                ? "opacity-40 cursor-not-allowed"
                : selected
                ? "bg-action text-white"
                : "text-white/70 hover:text-white hover:bg-white/5"
            }`}
          >
            <div>{opt.label}</div>
            {opt.sub && (
              <div className="text-[10px] uppercase tracking-wider opacity-70 mt-0.5">
                {opt.sub}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

export default function Settings() {
  /* Hydration guard: localStorage isn't available during SSR, so on the
     first render we display the default ("en") and immediately re-read
     after mount. Without this guard the SSR HTML would always show
     "en" selected and the client would flicker into the real value. */
  const livePref = useTitlePref();
  const { t } = useTranslation();
  const [titlePref, setTitlePrefState] = useState<TitlePref>("en");
  const [uiLang, setUiLangState] = useState<Lang>("en");
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    setTitlePrefState(getTitlePref());
    setUiLangState(getLang());
    const onLang = () => setUiLangState(getLang());
    window.addEventListener(LANG_EVENT, onLang);
    return () => window.removeEventListener(LANG_EVENT, onLang);
  }, []);
  // Re-sync when the live event fires (e.g. user opened settings in two
  // tabs). Doing this in a separate effect keeps the mount-time read
  // simple and avoids racing with `mounted`.
  useEffect(() => {
    if (mounted) setTitlePrefState(livePref);
  }, [livePref, mounted]);

  const updateTitlePref = (next: TitlePref) => {
    setTitlePrefState(next);
    setTitlePref(next);
  };

  const updateUiLang = (next: Lang) => {
    setUiLangState(next);
    setLang(next);
  };

  return (
    <>
      <Head>
        <title>AniScroll • Beta</title>
        <meta name="title" content="Settings" />
        <meta
          name="description"
          content="Customize how AniScroll looks and which language anime titles appear in."
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" type="image/png" href="/logo.png" />
      </Head>
      <Navbar withNav={true} scrollP={5} shrink={true} />
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="flex flex-col justify-center items-center min-h-screen md:py-0 py-16"
      >
        <div className="max-w-screen-md w-full px-4 py-10">
          <h1 className="text-4xl font-bold mb-2">{t("settings.title")}</h1>
          <p className="text-white/60 mb-10">
            {t("settings.storedLocally")}
          </p>

          {/* ── Anime title language ─────────────────────────────── */}
          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-1">{t("settings.animeTitleLanguage")}</h2>
            <p className="text-white/60 text-sm mb-4">
              {t("settings.animeTitleLanguageDesc")}
            </p>
            <SegmentedPicker<TitlePref>
              value={titlePref}
              onChange={updateTitlePref}
              options={[
                { value: "en", label: t("language.en"), sub: t("settings.default") },
                { value: "romaji", label: "Romaji", sub: t("settings.romajiSub") },
              ]}
            />
            <p className="text-white/40 text-xs mt-3">
              {t("settings.titleLangNote")}
            </p>
          </section>

          {/* ── Interface language ───────────────────────────────── */}
          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-1">{t("settings.interfaceLanguage")}</h2>
            <p className="text-white/60 text-sm mb-4">
              {t("settings.interfaceLanguageDesc")}
            </p>
            <SegmentedPicker<Lang>
              value={uiLang}
              onChange={updateUiLang}
              options={[
                { value: "en", label: t("language.en") },
                { value: "fr", label: t("language.fr") },
              ]}
            />
            <p className="text-white/40 text-xs mt-3">
              {t("settings.interfaceLangNote")}
            </p>
          </section>
        </div>
      </motion.div>
      <Footer />
    </>
  );
}
