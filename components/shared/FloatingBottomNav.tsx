import Link from "next/link";
import { useRouter } from "next/router";
import {
  HomeIcon,
  MagnifyingGlassIcon,
  UserIcon,
  Squares2X2Icon,
} from "@heroicons/react/24/outline";
import { FireIcon } from "@heroicons/react/24/solid";

/**
 * AniScroll-inspired floating bottom nav for mobile.
 * Shows: Home, Discover (swipe), Search, Lists, Profile.
 * The center "Discover" button is elevated and colored in the accent pink/red.
 */
export default function FloatingBottomNav() {
  const router = useRouter();
  const path = router.pathname;

  const isActive = (test: string) =>
    path === test || path.startsWith(test + "/");

  return (
    <nav
      className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="flex items-center gap-1 rounded-pill bg-as-card/90 px-2 py-2 shadow-[0_8px_32px_rgba(0,0,0,0.55)] ring-1 ring-white/5 backdrop-blur-md">
        <NavItem href="/en" icon={<HomeIcon className="h-5 w-5" />} label="Home" active={path === "/en"} />
        <NavItem href="/en/search" icon={<MagnifyingGlassIcon className="h-5 w-5" />} label="Search" active={isActive("/en/search")} />

        {/* Elevated central Discover button */}
        <Link
          href="/en/discover"
          className={`-mt-6 flex h-14 w-14 items-center justify-center rounded-full shadow-glow ring-2 ring-as-accent/40 transition-transform hover:scale-105 ${
            isActive("/en/discover")
              ? "bg-gradient-to-br from-rose-500 to-pink-600"
              : "bg-gradient-to-br from-rose-600 to-pink-700"
          }`}
          aria-label="Discover (swipe)"
        >
          <FireIcon className="h-6 w-6 text-white" />
        </Link>

        <NavItem href="/en/profile" icon={<Squares2X2Icon className="h-5 w-5" />} label="Lists" active={isActive("/en/profile")} />
        <NavItem href="/en/settings" icon={<UserIcon className="h-5 w-5" />} label="You" active={isActive("/en/settings")} />
      </div>
    </nav>
  );
}

function NavItem({
  href,
  icon,
  label,
  active,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  active?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`flex flex-col items-center gap-0.5 rounded-pill px-3 py-1.5 font-karla text-[10px] transition-colors ${
        active ? "text-as-accent" : "text-white/60 hover:text-white"
      }`}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}
