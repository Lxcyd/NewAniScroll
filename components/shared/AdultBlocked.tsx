import Link from "next/link";
import { useTranslation } from "react-i18next";
import { Navbar } from "@/components/shared/NavBar";

/**
 * L'ecran d'une page -18 quand « Afficher le contenu adulte » est eteint
 * (10/11/2026, Luc). L'URL reste valide : on dit pourquoi la page est cachee et
 * ou le reglage se change (lib/prefs/adultPrefs.ts).
 */
export default function AdultBlocked() {
  const { t } = useTranslation();
  return (
    <>
    <Navbar withNav />
    <main className="flex min-h-screen items-center justify-center bg-[#0b0b10] px-4 text-white">
      <div className="w-full max-w-md rounded-2xl bg-white/5 p-8 text-center ring-1 ring-white/10">
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-white/5 text-xl font-black text-action border border-solid border-[#3a3a44]">
          18+
        </div>
        <h1 className="m-0 text-xl font-bold">{t("settings.browsing.adultBlockedTitle")}</h1>
        <p className="mt-2 text-sm text-white/60">{t("settings.browsing.adultBlockedBody")}</p>
        <div className="mt-6 flex justify-center gap-3">
          <Link href="/en/settings?focus=showAdult" className="rounded-full bg-action px-5 py-2 text-sm font-bold text-white hover:brightness-110">
            {t("settings.browsing.adultBlockedSettings")}
          </Link>
          <Link href="/" className="rounded-full bg-white/10 px-5 py-2 text-sm font-bold text-white/80 hover:bg-white/15">
            {t("settings.browsing.adultBlockedHome")}
          </Link>
        </div>
      </div>
    </main>
    </>
  );
}
