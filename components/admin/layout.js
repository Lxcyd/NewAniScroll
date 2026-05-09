import {
  CloudArrowUpIcon,
  Cog6ToothIcon,
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
  { name: "Dashboard", page: 1, icon: <HomeIcon /> },
  { name: "Metadata",  page: 2, icon: <CloudArrowUpIcon /> },
  { name: "Fanarts",   href: "/admin/fanarts-review", icon: <PhotoIcon /> },
  { name: "Users",     page: 3, icon: <UserIcon /> },
  { name: "Settings",  page: 4, icon: <Cog6ToothIcon /> },
];

export default function AdminLayout({ children, page, setPage }) {
  return (
    <div className="relative w-screen h-screen">
      <div className="absolute flex flex-col gap-5 top-0 left-0 py-2 bg-secondary w-[14rem] h-full">
        <div className="flex flex-col px-3">
          <p className="text-sm font-light text-action font-outfit">moopa</p>
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
      <div className="ml-[14rem] overflow-x-hidden h-full">{children}</div>
    </div>
  );
}
