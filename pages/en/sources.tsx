import Footer from "@/components/shared/footer";
import { Navbar } from "@/components/shared/NavBar";
import MobileNav from "@/components/shared/MobileNav";
import Head from "next/head";
import { useTranslation } from "react-i18next";

/**
 * Credits page — who supplies the data AniScroll shows.
 *
 * One of these is contractual, not courtesy: Simkl expects attribution under
 * its free tier. The rest are here because they earned it. (TMDB used to be the
 * other one — its terms mandated a verbatim disclaimer — but it is no longer a
 * provider, so both the credit and the disclaimer are gone with it.)
 *
 * Streaming hosts are deliberately absent: they aren't data sources, and the
 * footer disclaimer already covers them.
 *
 * Source names and URLs live in code rather than the locale files — proper
 * nouns don't translate, and duplicating them across fr/en would only invite
 * drift. Only the descriptions are translated.
 */

type Source = {
  name: string;
  url: string;
  /** i18n key for what it gives us. */
  key: string;
};

const SOURCES: Source[] = [
  { name: "AniList", url: "https://anilist.co", key: "anilist" },
  { name: "fanart.tv", url: "https://fanart.tv", key: "fanart" },
  { name: "AnimeThemes", url: "https://animethemes.moe", key: "animethemes" },
  { name: "MyAnimeList", url: "https://myanimelist.net", key: "mal" },
  { name: "Jikan", url: "https://jikan.moe", key: "jikan" },
  { name: "Simkl", url: "https://simkl.com", key: "simkl" },
  { name: "Fribb/anime-lists", url: "https://github.com/Fribb/anime-lists", key: "fribb" },
  { name: "AniSkip", url: "https://aniskip.com", key: "aniskip" },
  { name: "Anime-Skip", url: "https://anime-skip.com", key: "animeskip" },
];

export default function Sources() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>AniScroll • Beta</title>
        <meta
          name="description"
          content="The open databases and communities whose data powers AniScroll."
        />
        <meta property="og:title" content="Sources · AniScroll" />
        <meta
          property="og:description"
          content="The open databases and communities whose data powers AniScroll."
        />
        <meta property="og:image" content="/logo.png" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" type="image/png" href="/logo.png" />
      </Head>

      <Navbar withNav scrollP={5} shrink />
      <MobileNav hideProfile />

      <main className="min-h-screen w-full pt-[80px] pb-20">
        <div className="mx-auto w-[90%] lg:w-[70%] max-w-3xl flex flex-col gap-10">
          <header className="flex flex-col gap-2">
            <h1 className="font-outfit font-bold text-4xl lg:text-5xl text-white">
              {t("sources.title")}
            </h1>
            <p className="font-karla text-white/60">{t("sources.subtitle")}</p>
          </header>

          <section className="bg-secondary rounded-card p-6 ring-1 ring-white/5">
            <h2 className="font-outfit font-semibold text-action text-2xl mb-3">
              {t("sources.thanksTitle")}
            </h2>
            <div className="font-karla text-white/85 space-y-3 leading-relaxed">
              <p>{t("sources.thanks1")}</p>
              <p className="text-white/60 text-sm">{t("sources.thanks2")}</p>
            </div>
          </section>

          <section>
            <h2 className="font-outfit font-semibold text-2xl text-white mb-4">
              {t("sources.dataTitle")}
            </h2>
            <ul className="flex flex-col gap-3">
              {SOURCES.map((s) => (
                <li
                  key={s.name}
                  className="bg-as-card rounded-card p-4 ring-1 ring-white/5"
                >
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-outfit font-semibold text-white hover:text-action transition-colors"
                  >
                    {s.name}
                  </a>
                  <p className="font-karla text-white/70 text-sm mt-1">
                    {t(`sources.desc.${s.key}`)}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="font-outfit font-semibold text-2xl text-white mb-3">
              {t("sources.legalTitle")}
            </h2>
            <div className="font-karla text-white/80 space-y-3 leading-relaxed">
              <p className="text-white/60 text-sm">{t("sources.legalNote")}</p>
            </div>
          </section>
        </div>
      </main>

      <Footer />
    </>
  );
}
