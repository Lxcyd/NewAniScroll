import Link from "next/link";
import { useState } from "react";
import Logo from "./Logo";
import { useTranslation } from "react-i18next";
import { getCurrentSeason } from "@/utils/getTimes";

/** Largeur du contenu du pied, par defaut celle des pages du site.
 *  Toutes ne l'ont pas : la page /watch tient ses colonnes a 95 % jusqu'en xl
 *  (le lecteur a besoin de la place), et un pied qui se resserrait a 80 % sous
 *  elles ne ressemblait plus a la fin de LA page mais a un bloc etranger pose
 *  dessous. D'ou le reglage, plutot qu'une largeur de plus en dur ici. */
const DEFAULT_WIDTH = "w-[90%] lg:w-[95%] xl:w-[80%]";

function Footer({ widthClass = DEFAULT_WIDTH }: { widthClass?: string }) {
  const { t } = useTranslation();
  const [year] = useState(new Date().getFullYear());
  const [season] = useState(getCurrentSeason());

  return (
    <footer className="flex-col w-full">
      <div className="text-[#dbdcdd] z-40 bg-[#0c0d10] lg:flex lg:h-[12rem] w-full lg:items-center lg:justify-between">
        <div
          className={`mx-auto flex ${widthClass} flex-col space-y-10 py-6 lg:flex-row lg:items-center lg:justify-between lg:space-y-0 lg:py-0`}
        >
          <div className="flex flex-col gap-2">
            <Logo size="md" />
            <p className="font-karla lg:text-[0.8rem] text-[0.65rem] text-[#9c9c9c]  lg:w-[520px] italic">
              {t("footer.disclaimer")}
            </p>
          </div>
          <div className="flex flex-col gap-10 lg:flex-row lg:items-end lg:gap-[9.06rem] text-[#a7a7a7] text-sm lg:text-end">
            <div className="flex flex-col gap-10 font-karla font-bold lg:flex-row lg:gap-[5.94rem]">
              <ul className="flex flex-col gap-y-[0.7rem] ">
                <li className="cursor-pointer hover:text-action">
                  <Link href={`/en/search/anime?season=${season}&year=${year}`}>
                    {t("home.thisSeason")}
                  </Link>
                </li>
                <li className="cursor-pointer hover:text-action">
                  <Link href={`/en/search/anime`}>{t("home.popularAnime")}</Link>
                </li>
              </ul>
              <ul className="flex flex-col gap-y-[0.7rem]">
                <li className="cursor-pointer hover:text-action">
                  <Link href={`/en/search/anime?format=MOVIE`}>{t("footer.movies")}</Link>
                </li>
                <li className="cursor-pointer hover:text-action">
                  <Link href={`/en/search/anime?format=TV`}>{t("footer.tvShows")}</Link>
                </li>
                <li className="cursor-pointer hover:text-action">
                  <Link href={`/en/dmca`}>{t("footer.dmca")}</Link>
                </li>
                <li className="cursor-pointer hover:text-action">
                  <Link href={`/en/sources`}>{t("footer.sources")}</Link>
                </li>
                {/* /en/about existed but nothing linked to it. */}
                <li className="cursor-pointer hover:text-action">
                  <Link href={`/en/about`}>{t("footer.about")}</Link>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
      <div className="bg-tersier border-t border-white/5">
        <div
          className={`mx-auto flex ${widthClass} flex-col pb-6 lg:flex-row lg:items-center lg:justify-between lg:space-y-0 lg:py-0`}
        >
          <p className="flex items-center gap-1 font-karla lg:text-[0.81rem] text-[0.7rem] text-[#CCCCCC] py-3">
            &copy; {new Date().getFullYear()} AniScroll
          </p>
        </div>
      </div>
    </footer>
  );
}

export default Footer;

