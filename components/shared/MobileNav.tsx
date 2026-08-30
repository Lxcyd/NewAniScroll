import { SparklesIcon } from "@heroicons/react/20/solid";
import { CalendarIcon, HomeIcon } from "@heroicons/react/24/outline";
import { UserIcon } from "@heroicons/react/24/solid";
import { signOut, useSession } from "next-auth/react";
import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { useTranslation } from "react-i18next";

type MobileNavProps = {
  hideProfile?: boolean;
};

/* Same as the desktop nav: the form only loads when someone asks to sign in. */
const AuthModal = dynamic(() => import("@/components/auth/AuthModal"), {
  ssr: false,
});

export default function MobileNav({ hideProfile = false }: MobileNavProps) {
  const { data: sessions }: { data: any } = useSession();
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);

  const avatarUrl: string | undefined =
    sessions?.user?.image?.large ||
    sessions?.user?.image?.medium ||
    (typeof sessions?.user?.image === "string" ? sessions.user.image : undefined);

  const handleShowClick = () => {
    setIsVisible(true);
  };

  const handleHideClick = () => {
    setIsVisible(false);
  };
  return (
    <>
      {/* NAVBAR */}
      <div className="z-[1000]">
        {!isVisible && (
          <button
            onClick={handleShowClick}
            className="fixed bottom-[30px] right-[20px] z-[100] flex h-[51px] w-[50px] cursor-pointer items-center justify-center rounded-[8px] bg-[#17171f] shadow-lg border border-[#E94560]/40 outline-none focus:outline-none focus-visible:outline-none lg:hidden"
            id="bars"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-[42px] w-[61.5px] text-action"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Mobile Menu */}
      <div
        className={`transition-all duration-150 subpixel-antialiased z-[500]`}
      >
        {/* An AniScroll account has no AniList avatar and no AniList profile
            page: `src` would be undefined, next/image throws, and the whole
            bar disappears. Fall back to the generic icon and to the account
            settings. */}
        {isVisible && sessions && !hideProfile && (
          <Link
            href={
              sessions?.user?.anilistId
                ? `/en/profile/${sessions?.user?.name}${
                    sessions?.user?.tag ? `-${sessions.user.tag}` : ""
                  }`
                : "/en/settings#account"
            }
            className="fixed lg:hidden bottom-[100px] w-[60px] h-[60px] flex items-center justify-center right-[20px] rounded-full z-50 bg-[#17171f]"
          >
            {avatarUrl ? (
              <Image
                src={avatarUrl}
                alt="user avatar"
                width={60}
                height={60}
                className="object-cover w-[60px] h-[60px] rounded-full"
              />
            ) : (
              <UserIcon className="w-8 h-8 text-white/70" />
            )}
          </Link>
        )}
        {isVisible && (
          <div className="fixed bottom-[30px] right-[20px] z-[500] flex h-[51px] px-5 items-center justify-center gap-8 rounded-[8px] text-[11px] bg-[#17171f] shadow-lg lg:hidden">
            <div className="flex items-center gap-5">
              <button className="group flex flex-col items-center">
                <Link href="/en/">
                  <HomeIcon className="w-6 h-6 group-hover:text-action" />
                </Link>
                <Link
                  href="/en/"
                  className="font-karla font-bold text-white/60 group-hover:text-action"
                >
                  home
                </Link>
              </button>
              <button className="group flex flex-col items-center gap-[1px]">
                <Link href="/en/schedule">
                  <CalendarIcon className="w-6 h-6 group-hover:text-action" />
                </Link>
                <Link
                  href="/en/schedule"
                  className="font-karla font-bold text-white/60 group-hover:text-action"
                >
                  {t("nav.schedule")}
                </Link>
              </button>
              <button className="group flex gap-[1px] flex-col items-center">
                <Link href="/en/discover">
                  <SparklesIcon className="w-6 h-6 group-hover:text-action" />
                </Link>

                <Link
                  href="/en/discover"
                  className="font-karla font-bold text-white/60 group-hover:text-action"
                >
                  {t("nav.discover")}
                </Link>
              </button>
              <button className="group flex gap-[1px] flex-col items-center">
                <Link href="/en/settings">
                  {/* gear icon */}
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                    stroke="currentColor"
                    className="w-6 h-6 group-hover:text-action"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a6.759 6.759 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                  </svg>
                </Link>
                <Link
                  href="/en/settings"
                  className="font-karla font-bold text-white/60 group-hover:text-action"
                >
                  settings
                </Link>
              </button>
              {sessions ? (
                <button
                  onClick={() => signOut({ redirect: true })}
                  className="group flex gap-[1.5px] flex-col items-center "
                >
                  <div>
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 96 960 960"
                      className="group-hover:fill-action w-6 h-6 fill-txt"
                    >
                      <path d="M186.666 936q-27 0-46.833-19.833T120 869.334V282.666q0-27 19.833-46.833T186.666 216H474v66.666H186.666v586.668H474V936H186.666zm470.668-176.667l-47-48 102-102H370v-66.666h341.001l-102-102 46.999-48 184 184-182.666 182.666z"></path>
                    </svg>
                  </div>
                  <h1 className="font-karla font-bold text-white/60 group-hover:text-action">
                    logout
                  </h1>
                </button>
              ) : (
                <button
                  onClick={() => setAuthOpen(true)}
                  className="group flex gap-[1.5px] flex-col items-center "
                >
                  <div>
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 96 960 960"
                      className="group-hover:fill-action w-6 h-6 fill-txt mr-2"
                    >
                      <path d="M486 936v-66.666h287.334V282.666H486V216h287.334q27 0 46.833 19.833T840 282.666v586.668q0 27-19.833 46.833T773.334 936H486zm-78.666-176.667l-47-48 102-102H120v-66.666h341l-102-102 47-48 184 184-182.666 182.666z"></path>
                    </svg>
                  </div>
                  <h1 className="font-karla font-bold text-white/60 group-hover:text-action">
                    login
                  </h1>
                </button>
              )}
            </div>
            <button onClick={handleHideClick}>
              <svg
                width="20"
                height="21"
                className="fill-action"
                viewBox="0 0 20 21"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <rect
                  x="2.44043"
                  y="0.941467"
                  width="23.5842"
                  height="3.45134"
                  rx="1.72567"
                  transform="rotate(45 2.44043 0.941467)"
                />
                <rect
                  x="19.1172"
                  y="3.38196"
                  width="23.5842"
                  height="3.45134"
                  rx="1.72567"
                  transform="rotate(135 19.1172 3.38196)"
                />
              </svg>
            </button>
          </div>
        )}
      </div>
      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} />
    </>
  );
}
