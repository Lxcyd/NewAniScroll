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
import { useEffect, useState } from "react";

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
  const [titlePref, setTitlePrefState] = useState<TitlePref>("en");
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    setTitlePrefState(getTitlePref());
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
          <h1 className="text-4xl font-bold mb-2">Settings</h1>
          <p className="text-white/60 mb-10">
            Your preferences are stored locally on this device.
          </p>

          {/* ── Anime title language ─────────────────────────────── */}
          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-1">Anime title language</h2>
            <p className="text-white/60 text-sm mb-4">
              How anime titles are displayed everywhere on the site (search,
              hero, lists, schedule…).
            </p>
            <SegmentedPicker<TitlePref>
              value={titlePref}
              onChange={updateTitlePref}
              options={[
                { value: "en", label: "English", sub: "Default" },
                { value: "romaji", label: "Romaji", sub: "Japanese romanized" },
              ]}
            />
            <p className="text-white/40 text-xs mt-3">
              French titles are not supplied by AniList and would have to be
              guessed from synonyms, which is unreliable — so this picker only
              covers English and Romaji.
            </p>
          </section>

          {/* ── Interface language (placeholder) ─────────────────── */}
          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-1">Interface language</h2>
            <p className="text-white/60 text-sm mb-4">
              Language used for buttons, menus and labels across the site.
            </p>
            <SegmentedPicker
              value={"en"}
              onChange={() => {}}
              options={[
                { value: "en", label: "English" },
                { value: "fr", label: "Français", disabled: true, sub: "Soon" },
              ]}
            />
            <p className="text-white/40 text-xs mt-3">
              French translations are being prepared and will be enabled in a
              future update.
            </p>
          </section>
        </div>
      </motion.div>
      <Footer />
    </>
  );
}
