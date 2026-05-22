import { useSearch } from "@/lib/context/isOpenState";
import { getCurrentSeason } from "@/utils/getTimes";
import { ArrowUpCircleIcon } from "@heroicons/react/20/solid";
import { UserIcon } from "@heroicons/react/24/solid";
import { signIn, signOut, useSession } from "next-auth/react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import Logo from "./Logo";
import ChangelogButton from "./ChangelogButton";
import ReportButton from "./ReportButton";
import { isAdminName } from "@/lib/auth/isAdmin";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";

const getScrollPosition = (el: Window | Element = window) => {
  if (el instanceof Window) {
    return { x: el.pageXOffset, y: el.pageYOffset };
  } else {
    return { x: el.scrollLeft, y: el.scrollTop };
  }
};

type NavbarProps = {
  info?: AniListInfoTypes | null;
  scrollP?: number;
  toTop?: boolean;
  withNav?: boolean;
  paddingY?: string;
  home?: boolean;
  back?: boolean;
  shrink?: boolean;
  bgHover?: boolean;
};

export function Navbar({
  info = null,
  // Default scroll threshold lowered so the background fades in almost
  // immediately as the user scrolls — avoids the page content briefly
  // sitting on a transparent navbar.
  scrollP = 20,
  toTop = false,
  // Unified navbar — always shows nav links + search by default so every
  // page gets the same layout the home page does.
  withNav = true,
  paddingY = "py-3",
  home = false,
  back = false,
  shrink = false,
  bgHover = false,
}: NavbarProps) {
  const { data: session }: { data: any } = useSession();
  const router = useRouter();
  const titlePref = useTitlePref();
  const [scrollPosition, setScrollPosition] = useState<
    { x: number; y: number } | undefined
  >();
  const { setIsOpen } = useSearch();

  const year = new Date().getFullYear();
  const season = getCurrentSeason();

  /* When the page passed an `info` (anime detail / watch pages do
     this), the navbar's Report button gets pre-targeted at that
     anime + the episode currently in the URL. The user can still
     switch tabs to file a Site bug. On other pages we leave the
     context null so only the Site-bug tab is selectable. */
  const animeReportContext = info
    ? {
        animeId: info.id,
        animeTitle: pickTitle(info.title, titlePref),
        episode: (() => {
          const m = router.asPath.match(/[?&]num=(\d+)/);
          return m ? Number(m[1]) : undefined;
        })(),
      }
    : null;

  useEffect(() => {
    const handleScroll = () => {
      setScrollPosition(getScrollPosition());
    };

    // Add a scroll event listener when the component mounts
    window.addEventListener("scroll", handleScroll);

    // Clean up the event listener when the component unmounts
    return () => {
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);
  // ── Unified navbar layout ──
  // Same structure on every page: logo left, nav links spread, centered
  // search bar, avatar right. Symmetric horizontal padding so the logo's
  // distance from the left edge equals the avatar's distance from the right.
  // The `info` / `home` props no longer drive different layouts — they only
  // toggle ancillary affordances (back button, title fade-in).
  const PAD_X = "px-6 lg:px-10";
  return (
    <>
      <nav
        // z-[9999] beats every other element on the page (player ambient
        // glow at z-auto in its own stacking context, modals at z-999, etc.).
        //
        // Opera blur-bleed-through fix (also harmless on Chrome / Edge /
        // Firefox / Safari):
        //   - `translateZ(0)` promotes the navbar onto its own GPU layer
        //     with whole-pixel rasterisation, so fractional-DPR (Windows
        //     125%/150%) doesn't leave a sub-pixel seam at the corners.
        //   - `isolation: isolate` creates a fresh stacking context for the
        //     navbar so the watch-page blur sibling can't composite pixels
        //     into the navbar's box.
        //   - `backface-visibility: hidden` hints to the compositor that
        //     the navbar is fully opaque, killing edge-sampling artefacts.
        className={`fixed top-0 left-0 right-0 z-[9999] w-full ${PAD_X} py-2 rounded-none border-0 ${
          bgHover ? "hover:bg-tersier" : ""
        } ${
          (scrollPosition?.y ?? 0) >= scrollP
            ? "bg-tersier"
            : ""
        } transition-colors duration-200 ease-linear`}
        style={{
          borderRadius: 0,
          transform: "translateZ(0)",
          isolation: "isolate",
          backfaceVisibility: "hidden",
          willChange: "transform",
        }}
      >
        {/* Three-zone layout:
            - LEFT: logo + nav links, stretched to fill its half.
            - CENTER: search bar, absolutely positioned in the viewport
              center so it never drifts when links change width.
            - RIGHT: avatar, mirroring the logo's left margin.
            We use a positioning trick (the bar lives outside the flex flow)
            so the search bar stays in the geometric center of the navbar
            regardless of how many nav items are rendered.
            min-h drives the navbar's overall height; items are centered
            inside via items-center on the flex row. */}
        <div className="relative flex items-center w-full gap-6 min-h-[48px]">
          {/* Centered search bar — geometric center of the viewport. */}
          {withNav && (
            <button
              type="button"
              onClick={() => setIsOpen(true)}
              title="Search"
              className="hidden lg:flex absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 items-center gap-2 w-[320px] h-9 px-4 rounded-full bg-white/10 hover:bg-white/15 ring-1 ring-white/10 text-white/70 hover:text-white/90 transition-all"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                className="shrink-0"
              >
                <path
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M15 15l6 6m-11-4a7 7 0 110-14 7 7 0 010 14z"
                ></path>
              </svg>
              <span className="text-base font-karla truncate">Search anime…</span>
            </button>
          )}

          {/* Left: logo + nav links. Fills the half-width up to the search bar.
              No back-arrow on anime detail pages — clicking the logo returns
              to the home, which is the same outcome and keeps the navbar
              visually identical across every page. */}
          <div className="flex items-center gap-8 flex-1 min-w-0">
            <Logo size="sm" />

            {withNav && (
              <ul className="hidden lg:flex items-center gap-8 font-outfit text-[16px]">
                <li>
                  <Link
                    /* Lower-case season + year only. The search page
                       auto-applies format=TV + sort=POPULARITY_DESC
                       when a season is selected and no other filters
                       are present, so the URL stays human-readable. */
                    href={`/en/search/anime?season=${season.toLowerCase()}&year=${year}`}
                    className="hover:text-action/80 transition-all duration-150 ease-linear whitespace-nowrap"
                  >
                    This Season
                  </Link>
                </li>
                <li>
                  <Link
                    href="/en/search/anime"
                    className="hover:text-action/80 transition-all duration-150 ease-linear whitespace-nowrap"
                  >
                    Anime
                  </Link>
                </li>
                <li>
                  <Link
                    href="/en/schedule"
                    className="hover:text-action/80 transition-all duration-150 ease-linear whitespace-nowrap"
                  >
                    Schedule
                  </Link>
                </li>
                {!session && (
                  <li>
                    <button
                      onClick={() => signIn("AniListProvider")}
                      className="hover:text-action/80 transition-all duration-150 ease-linear whitespace-nowrap"
                    >
                      Sign In
                    </button>
                  </li>
                )}
                {session && (
                  <li>
                    <Link
                      href={`/en/profile/${session?.user?.name}`}
                      className="hover:text-action/80 transition-all duration-150 ease-linear whitespace-nowrap"
                    >
                      My List
                    </Link>
                  </li>
                )}
              </ul>
            )}
          </div>

          {/* Right: avatar / sign-in. Fixed at the right edge — its margin
              from the right edge equals the logo's margin from the left,
              both controlled by the parent's symmetric PAD_X. */}
          <div className="flex shrink-0 items-center gap-4">
            {/* Mobile-only search icon — desktop has the inline pill above. */}
            <button
              type="button"
              title="Search"
              onClick={() => setIsOpen(true)}
              className="flex lg:hidden flex-center w-[26px] h-[26px]"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="32"
                height="32"
                viewBox="0 0 24 24"
              >
                <path
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M15 15l6 6m-11-4a7 7 0 110-14 7 7 0 010 14z"
                ></path>
              </svg>
            </button>
            {/* <div
                className="bg-white"
                // title={sessions ? "Go to Profile" : "Login With AniList"}
              > */}
            {/* Report + changelog — sit just left of the avatar so users can
                always reach them no matter what page they're on. They share
                a tight gap so they read as a pair, not two unrelated icons. */}
            <div className="flex items-center gap-0">
              <ReportButton anime={animeReportContext} />
              <ChangelogButton />
            </div>
            {/* Avatar + hover menu — same shell whether signed-in or out.
                Signed-out users used to only see a single "login" icon
                that did nothing on hover; now they get the same dropdown
                affordance with a Sign-In entry + a Settings link, which
                lets them tweak preferences (title language, etc.) before
                signing in. The signed-in variant keeps the avatar image
                + click-to-profile behaviour. */}
            <div className="w-10 h-10 relative flex flex-col items-center group shrink-0">
              {session ? (
                <button
                  type="button"
                  onClick={() =>
                    router.push(`/en/profile/${session?.user?.name}`)
                  }
                  className="rounded-full w-10 h-10 bg-white/30 overflow-hidden"
                  title="Profile"
                >
                  <Image
                    src={session?.user?.image?.large}
                    alt="avatar"
                    width={64}
                    height={64}
                    className="w-10 h-10 object-cover"
                  />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => signIn("AniListProvider")}
                  title="Sign in with AniList"
                  className="w-10 h-10 bg-white/30 rounded-full overflow-hidden shrink-0"
                >
                  <UserIcon className="w-full h-full translate-y-1" />
                </button>
              )}

              {/* Hover dropdown — pure CSS via `group-hover`, no JS state.
                  Padded top by mirroring the avatar height so the hover
                  bridge doesn't collapse when the cursor moves down. */}
              <div className="hidden md:grid absolute z-50 right-0 top-full pt-2 w-36 opacity-0 invisible group-hover:visible group-hover:opacity-100 transition-all duration-200">
                <div className="bg-secondary text-white shadow-2xl rounded-md p-1 py-2 font-karla font-light grid place-items-stretch gap-1 text-center">
                  {session ? (
                    <>
                      <Link
                        href={`/en/profile/${session?.user?.name}`}
                        className="hover:text-action py-1"
                      >
                        Profile
                      </Link>
                      {/* Admin link shows only for users matching the
                          NEXT_PUBLIC_ADMIN_USERNAMES env var. */}
                      {isAdminName(session?.user?.name) && (
                        <Link href="/admin" className="hover:text-action py-1">
                          Admin
                        </Link>
                      )}
                      <Link href="/en/settings" className="hover:text-action py-1">
                        Settings
                      </Link>
                      <button
                        type="button"
                        onClick={() => signOut({ redirect: true })}
                        className="hover:text-action py-1"
                      >
                        Log out
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => signIn("AniListProvider")}
                        className="hover:text-action py-1"
                      >
                        Sign In
                      </button>
                      <Link href="/en/settings" className="hover:text-action py-1">
                        Settings
                      </Link>
                    </>
                  )}
                </div>
              </div>
            </div>
            {/* </div> */}
          </div>
        </div>
      </nav>
      {toTop && (
        <button
          type="button"
          onClick={() => {
            window.scrollTo({
              top: 0,
              behavior: "smooth",
            });
          }}
          className={`${
            scrollPosition?.y ?? 0 >= 180
              ? "-translate-x-6 opacity-100"
              : "translate-x-[100%] opacity-0"
          } transform transition-all duration-300 ease-in-out fixed bottom-24 lg:bottom-14 right-0 z-[500]`}
        >
          <ArrowUpCircleIcon className="w-10 h-10 text-white" />
        </button>
      )}
    </>
  );
}
