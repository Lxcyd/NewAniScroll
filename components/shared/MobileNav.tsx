import { SparklesIcon as SparklesSolid } from "@heroicons/react/24/solid";
import {
  CalendarIcon,
  HomeIcon,
  MagnifyingGlassIcon,
  SparklesIcon,
  BookmarkIcon,
} from "@heroicons/react/24/outline";
import {
  CalendarIcon as CalendarSolid,
  HomeIcon as HomeSolid,
  BookmarkIcon as BookmarkSolid,
} from "@heroicons/react/24/solid";
import { useSearch } from "@/lib/context/isOpenState";
import { profileHref } from "@/lib/profile/href";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

type MobileNavProps = {
  /** Garde pour compatibilite : l'avatar a quitte cette barre (il est dans la
   *  barre du haut, avec son menu en panneau — AccountSheet). */
  hideProfile?: boolean;
};

/**
 * Barre d'onglets du bas, telephone et tablette (< lg, la ou la barre du haut
 * cache ses liens). Remplace l'ancien bouton « menu » flottant : il fallait un
 * appui de plus pour tout, et le bouton couvrait le bas a droite de chaque page.
 *
 * Montee par <Navbar> sur toutes les pages qui en ont une, et directement par
 * les rares pages qui n'ont pas de barre du haut (CatalogGrid, recent…) — une
 * page ne doit donc pas monter les deux. `owner` compte les instances pour que
 * la classe de <body> ne tombe qu'au demontage de la derniere.
 *
 * La page garde sa place : la classe `has-tabbar` sur <body> lui ajoute en bas
 * la hauteur de la barre + la zone sure (styles/globals.css).
 */
let owner = 0;

export default function MobileNav(_props: MobileNavProps) {
  const { data: session }: { data: any } = useSession();
  const { t } = useTranslation();
  const router = useRouter();
  // `useSearch()` peut rendre `undefined` : <MobileNav> est monte par des pages
  // d'erreur hors du fournisseur. On ne fait pas tomber la barre pour un bouton.
  const search = useSearch();

  useEffect(() => {
    owner++;
    document.body.classList.add("has-tabbar");
    return () => {
      owner--;
      if (owner <= 0) document.body.classList.remove("has-tabbar");
    };
  }, []);

  /* Le prefixe de langue ramene a /en : les adresses /fr/... sont reecrites vers
     l'arbre /en (next.config.js), et toutes les comparaisons ci-dessous visent
     /en. Sans ca, sur une adresse francaise, aucun onglet n'etait surligne, la
     barre « lecture » ne s'appliquait pas, et une page statique (rendue en /en
     au build) ne s'hydratait pas avec le meme onglet que le serveur. */
  const path = (router?.asPath?.split(/[?#]/)[0] || "").replace(/^\/fr(?=\/|$)/, "/en");
  const onWatch = path.startsWith("/en/anime/watch");
  // Classe sur <body> plutot qu'un `body:has(.as-tabbar-watch)` en CSS : sous
  // Safari, un :has() sur body revalide la page entiere a chaque mutation.
  useEffect(() => {
    document.body.classList.toggle("tabbar-watch", onWatch);
    return () => document.body.classList.remove("tabbar-watch");
  }, [onWatch]);
  const listHref = session ? profileHref(session.user) : "/en/my-list";
  const tabs = [
    { href: "/en", label: t("nav.home"), Icon: HomeIcon, IconOn: HomeSolid, on: path === "/en" || path === "/en/" || path === "/" },
    { href: "/en/discover", label: t("nav.discover"), Icon: SparklesIcon, IconOn: SparklesSolid, on: path.startsWith("/en/discover") },
    { href: null, label: t("nav.search"), Icon: MagnifyingGlassIcon, IconOn: MagnifyingGlassIcon, on: path.startsWith("/en/search") },
    { href: "/en/schedule", label: t("nav.schedule"), Icon: CalendarIcon, IconOn: CalendarSolid, on: path.startsWith("/en/schedule") },
    { href: listHref, label: t("nav.myList"), Icon: BookmarkIcon, IconOn: BookmarkSolid, on: path.startsWith("/en/my-list") || path.startsWith("/en/profile") },
  ];

  return (
    <nav
      aria-label="Navigation"
      className={`as-tabbar ${path.startsWith("/en/anime/watch") ? "as-tabbar-watch " : ""}fixed bottom-0 left-0 right-0 z-[900] lg:hidden border-t border-white/10 bg-[#17171f]`}
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="mx-auto flex h-[60px] max-w-[560px] items-stretch justify-around px-1">
        {tabs.map(({ href, label, Icon, IconOn, on }) => {
          const I = on ? IconOn : Icon;
          const inner = (
            <>
              <I className="h-6 w-6" aria-hidden />
              <span className="max-w-full truncate font-karla text-[11px] font-semibold leading-none">{label}</span>
            </>
          );
          const cls = `flex h-full w-full flex-col items-center justify-center gap-1 transition-colors ${
            on ? "text-action" : "text-white/60 active:text-white"
          }`;
          return (
            <li key={label} className="flex min-w-0 flex-1">
              {href ? (
                <Link href={href} className={cls} aria-current={on ? "page" : undefined}>
                  {inner}
                </Link>
              ) : (
                <button type="button" className={cls} onClick={() => search?.setIsOpen(true)}>
                  {inner}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
