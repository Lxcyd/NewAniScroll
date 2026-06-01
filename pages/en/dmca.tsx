import Footer from "@/components/shared/footer";
import { Navbar } from "@/components/shared/NavBar";
import MobileNav from "@/components/shared/MobileNav";
import Head from "next/head";
import { useTranslation } from "react-i18next";

export default function DMCA() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>AniScroll • Beta</title>
        <meta
          name="description"
          content="AniScroll's disclaimer, DMCA process, and a note on the project's status."
        />
        <meta property="og:title" content="DMCA · AniScroll" />
        <meta
          property="og:description"
          content="AniScroll respects copyright. Read our DMCA process and project status."
        />
        <meta property="og:image" content="/logo.png" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" type="image/png" href="/logo.png" />
      </Head>

      <Navbar withNav scrollP={5} shrink />
      <MobileNav hideProfile />

      <main className="min-h-screen w-full pt-[80px] pb-20">
        <div className="mx-auto w-[90%] lg:w-[70%] max-w-3xl flex flex-col gap-10">
          {/* Hero */}
          <header className="flex flex-col gap-2">
            <h1 className="font-outfit font-bold text-4xl lg:text-5xl text-white">
              {t("dmca.title")}
            </h1>
            <p className="font-karla text-white/60">
              {t("dmca.subtitle")}
            </p>
          </header>

          {/* Project status (the personal note) */}
          <section className="bg-secondary rounded-card p-6 ring-1 ring-white/5">
            <h2 className="font-outfit font-semibold text-action text-2xl mb-3">
              {t("dmca.noteTitle")}
            </h2>
            <div className="font-karla text-white/85 space-y-3 leading-relaxed">
              <p>{t("dmca.note1")}</p>
              <p>{t("dmca.note2")}</p>
              <p className="text-white/60 text-sm">{t("dmca.note3")}</p>
            </div>
          </section>

          {/* Disclaimer */}
          <section>
            <h2 className="font-outfit font-semibold text-2xl text-white mb-3">
              {t("dmca.disclaimerTitle")}
            </h2>
            <div className="font-karla text-white/80 space-y-3 leading-relaxed">
              <p>{t("dmca.disclaimer1")}</p>
              <p>{t("dmca.disclaimer2")}</p>
            </div>
          </section>

          {/* DMCA process */}
          <section>
            <h2 className="font-outfit font-semibold text-2xl text-white mb-3">
              {t("dmca.processTitle")}
            </h2>
            <div className="font-karla text-white/80 space-y-3 leading-relaxed">
              <p>{t("dmca.process1")}</p>
              <p className="text-white/60 text-sm">{t("dmca.process2")}</p>
            </div>

            <div className="mt-4 bg-as-card rounded-card p-5 ring-1 ring-white/5">
              <p className="font-karla text-white font-semibold mb-2">
                {t("dmca.includeTitle")}
              </p>
              <ul className="font-karla text-white/80 space-y-1.5 list-disc pl-5">
                <li>{t("dmca.include1")}</li>
                <li>{t("dmca.include2")}</li>
                <li>{t("dmca.include3")}</li>
                <li>{t("dmca.include4")}</li>
                <li>{t("dmca.include5")}</li>
              </ul>
            </div>

            <p className="mt-4 font-karla text-white/80">
              {t("dmca.emailNotice")}{" "}
              <span className="text-white/60 italic">
                {t("dmca.emailNotAvailable")}
              </span>
              {t("dmca.emailRest")}
            </p>
          </section>
        </div>
      </main>

      <Footer />
    </>
  );
}
