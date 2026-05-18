import {
  ArrowLeftIcon,
  CloudArrowUpIcon,
  Cog6ToothIcon,
  FlagIcon,
  HomeIcon,
  PhotoIcon,
  UserIcon,
} from "@heroicons/react/24/outline";
import Link from "next/link";
import { useRouter } from "next/router";
import React from "react";

// Two kinds of nav items:
//  - tabbed pages on the dashboard itself (page: number, click switches the
//    React state)
//  - external links to standalone admin pages (href: string, real <Link>)
const Navigation = [
  { name: "Dashboard",     page: 1, icon: <HomeIcon /> },
  { name: "Reports",       page: 5, icon: <FlagIcon /> },
  { name: "Metadata",      page: 2, icon: <CloudArrowUpIcon /> },
  { name: "Fanarts queue", href: "/admin/fanarts-review",   icon: <PhotoIcon /> },
  { name: "Fanarts by id", href: "/admin/fanarts-by-anime", icon: <PhotoIcon /> },
  { name: "Users",         page: 3, icon: <UserIcon /> },
  { name: "Settings",      page: 4, icon: <Cog6ToothIcon /> },
];

export default function AdminLayout({ children, page, setPage }) {
  // Lock the page body so admin scroll happens inside the content panel,
  // not at the document root. Otherwise the dashboard content can push the
  // navbar out of view when the cards stack vertically.
  React.useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  return (
    <div className="relative w-screen h-screen overflow-hidden">
      <div className="absolute flex flex-col gap-5 top-0 left-0 py-2 bg-secondary w-[14rem] h-full">
        <div className="flex flex-col px-3 gap-2">
          {/* Back to the public site — gives admins a way out of the
              dashboard without typing /en in the URL bar. */}
          <Link
            href="/en"
            className="flex items-center gap-1.5 text-xs text-white/60 hover:text-action transition-colors w-fit"
          >
            <ArrowLeftIcon className="w-4 h-4" />
            Back to site
          </Link>
          <p className="text-sm font-light text-action font-outfit">AniScroll</p>
          <h1 className="text-2xl font-bold text-white">
            Admin <br />
            Dashboard
          </h1>
        </div>
        <div className="flex flex-col px-1">
          {Navigation.map((item) => {
            const active = item.page != null && page === item.page;
            const className = `flex items-center gap-2 p-2 group ${
              active ? "bg-image/50" : "text-txt"
            } hover:bg-image rounded transition-colors duration-200 ease-in-out`;
            const iconWrap = (
              <div
                className={`w-5 h-5 ${
                  active ? "text-action" : "text-txt"
                } group-hover:text-action`}
              >
                {item.icon}
              </div>
            );

            // External link (e.g. Fanarts → /admin/fanarts-review)
            if (item.href) {
              return (
                <Link key={item.name} href={item.href} className={className}>
                  {iconWrap}
                  <p>{item.name}</p>
                </Link>
              );
            }
            // Tabbed page on the dashboard
            return (
              <button
                title={item.name}
                key={item.name}
                type="button"
                onClick={() => setPage(item.page)}
                className={className}
              >
                {iconWrap}
                <p>{item.name}</p>
              </button>
            );
          })}
        </div>
      </div>
      <div className="ml-[14rem] overflow-x-hidden overflow-y-auto h-full">
        {children}
      </div>
    </div>
  );
}
