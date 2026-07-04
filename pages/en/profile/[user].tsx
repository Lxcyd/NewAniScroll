import Image from "next/image";
import Link from "next/link";
import Head from "next/head";
import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { SparklesIcon } from "@heroicons/react/24/solid";
import { getUser } from "@/prisma/user";
import { Navbar } from "@/components/shared/NavBar";
import Footer from "@/components/shared/footer";
import pls from "@/utils/request";
import { CurrentMediaTypes } from "..";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { animeHref, useClickTarget } from "@/lib/prefs/clickTarget";
import { useTranslation } from "react-i18next";
import { listLabel, STATUS_TO_LIST, LIST_COLORS } from "@/components/anime/v2/helpers";
import QueueSection from "@/components/list/QueueSection";
import ForYouPanel from "@/components/discover/ForYouPanel";

type MyListProps = {
  media: CurrentMediaTypes[];
  sessions: any;
  user: any;
  time: any;
  userSettings: any;
  /** Set when the viewed profile is private and the viewer isn't the owner. */
  isPrivate?: boolean;
  viewedName?: string;
};

export default function MyList({
  media,
  sessions,
  user,
  time,
  userSettings,
  isPrivate,
  viewedName,
}: MyListProps) {
  const titlePref = useTitlePref();
  const clickTarget = useClickTarget();
  const { t } = useTranslation();
  // Owner = the signed-in viewer looking at their own profile (drives the
  // client-only watch-next queue, which lives in this device's localStorage).
  const isOwner =
    !!sessions?.user?.name &&
    String(sessions.user.name).toLowerCase() ===
      String(user?.name).toLowerCase();
  const [filter, setFilter] = useState<string>("all");
  const [showForYou, setShowForYou] = useState(false);

  // Flatten AniList's lists → one entry array, then re-group by the canonical
  // status so the layout matches /my-list exactly (status order + colours).
  // AniList may split a status across custom lists, so we key off entry.status.
  const STATUS_ORDER = [
    "CURRENT",
    "REPEATING",
    "COMPLETED",
    "PAUSED",
    "PLANNING",
    "DROPPED",
  ];
  const groups = useMemo(() => {
    const byStatus: Record<string, any[]> = {};
    for (const list of media || []) {
      for (const e of list.entries || []) {
        const key = e.status || list.status || "PLANNING";
        (byStatus[key] ||= []).push(e);
      }
    }
    // De-dupe by mediaId within each status (custom lists can repeat entries).
    for (const k of Object.keys(byStatus)) {
      const seen = new Set();
      byStatus[k] = byStatus[k].filter((e) => {
        const id = e.mediaId || e.media?.id;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    }
    return STATUS_ORDER.map((s) => ({ status: s, entries: byStatus[s] || [] })).filter(
      (g) => g.entries.length > 0,
    );
  }, [media]);

  const totalEntries = useMemo(
    () => groups.reduce((acc, g) => acc + g.entries.length, 0),
    [groups],
  );

  const visibleGroups =
    filter === "all" ? groups : groups.filter((g) => g.status === filter);

  // Private-profile guard: the owner sees their list normally (handled
  // server-side), everyone else lands here. Placed AFTER all hooks so the
  // hook call order stays stable (rules-of-hooks).
  if (isPrivate) {
    return (
      <>
        <Head>
          <title>{viewedName ? `${viewedName} • AniScroll` : "AniScroll"}</title>
        </Head>
        <Navbar withNav toTop shrink bgHover scrollP={110} paddingY={"py-1"} />
        <div className="flex flex-col items-center justify-center min-h-screen px-4 text-center">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="w-12 h-12 text-white/50 mb-4"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"
            />
          </svg>
          <h1 className="text-2xl font-bold mb-2">{t("profile.privateTitle")}</h1>
          <p className="text-white/60 max-w-sm">{t("profile.privateBody")}</p>
        </div>
      </>
    );
  }

  return (
    <>
      <Head>
        <title>{user.name} • AniScroll</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" type="image/png" href="/logo.png" />
      </Head>

      <Navbar withNav toTop shrink bgHover scrollP={110} paddingY={"py-1"} />

      {/* User banner + avatar header — the only thing that differs from
          /my-list. No description (AniList "about" is often empty/awkward). */}
      <div className="relative z-0 w-full h-[200px] md:h-[240px]">
        {user.bannerImage ? (
          <Image
            src={user.bannerImage}
            alt=""
            fill
            priority
            className="object-cover brightness-[0.55]"
          />
        ) : (
          <div className="absolute inset-0 bg-image brightness-[0.55]" />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-primary" />
      </div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="w-full max-w-screen-lg mx-auto px-4 pb-16"
      >
        {/* Avatar + name, pulled up to overlap the banner. `relative z-10`
            keeps it above the banner's absolutely-positioned <Image fill>,
            which otherwise paints over the negative-margin content. */}
        <div className="relative z-10 flex items-end gap-4 -mt-14 md:-mt-16 mb-8">
          <Image
            src={user.avatar.large}
            alt={user.name}
            width={120}
            height={120}
            priority
            className="object-cover h-24 w-24 md:h-28 md:w-28 rounded-2xl ring-4 ring-primary shadow-xl shrink-0"
          />
          <div className="pb-1">
            <h1 className="text-2xl md:text-3xl font-bold leading-tight">
              {user.name}
            </h1>
            <p className="text-white/50 text-sm mt-1">
              {user.statistics.anime.count} {t("profile.totalAnime", { defaultValue: "anime" })}
              {" · "}
              {user.statistics.anime.episodesWatched} {t("common.episode", { defaultValue: "ep" })}
              {time?.days ? ` · ${time.days}${t("home.days", { defaultValue: "d" }).charAt(0).toLowerCase()}` : ""}
            </p>
          </div>
        </div>

        {/* For You — recommendation engine, owner only. */}
        {isOwner && (
          <div className="mb-6">
            <button
              type="button"
              onClick={() => setShowForYou(true)}
              className="inline-flex items-center gap-2 rounded-full bg-action px-5 py-2.5 text-sm font-karla font-bold text-white shadow-[0_0_20px_rgba(233,69,96,0.35)] transition-transform hover:scale-105"
            >
              <SparklesIcon className="h-5 w-5" />
              {t("recommend.title")}
            </button>
          </div>
        )}

        {/* Watch-next queue — only for the owner viewing their own profile.
            Client-only (localStorage); renders nothing when empty. */}
        {isOwner && <QueueSection />}

        {totalEntries === 0 ? (
          <div className="flex flex-col items-center gap-5 py-20 text-center">
            <p className="font-bold text-lg">{t("myList.empty")}</p>
            <Link
              href="/en/search/anime"
              className="px-4 py-2 rounded-lg ring-1 ring-action text-sm hover:bg-action/10"
            >
              {t("profile.startWatching")}
            </Link>
          </div>
        ) : (
          <>
            {/* Status filter chips */}
            <div className="flex flex-wrap gap-2 mb-8">
              <button
                onClick={() => setFilter("all")}
                className={`px-3 py-1.5 rounded-full text-sm ${
                  filter === "all" ? "bg-action text-white" : "bg-white/5 text-white/70"
                }`}
              >
                {t("profile.showAll")} ({totalEntries})
              </button>
              {groups.map((g) => {
                const label = STATUS_TO_LIST[g.status] || g.status;
                return (
                  <button
                    key={g.status}
                    onClick={() => setFilter(g.status)}
                    className={`px-3 py-1.5 rounded-full text-sm ${
                      filter === g.status
                        ? "bg-action text-white"
                        : "bg-white/5 text-white/70"
                    }`}
                  >
                    {listLabel(t, label)} ({g.entries.length})
                  </button>
                );
              })}
            </div>

            <div className="grid gap-10">
              {visibleGroups.map((g) => {
                const label = STATUS_TO_LIST[g.status] || g.status;
                const color = LIST_COLORS[label] || "#6b7280";
                return (
                  <section key={g.status} id={g.status.toLowerCase()}>
                    <h2 className="flex items-center gap-2 font-bold text-lg mb-3">
                      <span
                        className="w-2.5 h-2.5 rounded-full"
                        style={{ background: color }}
                      />
                      {listLabel(t, label)}
                    </h2>
                    <div className="overflow-hidden rounded-lg bg-white/[0.03] ring-1 ring-white/5">
                      {g.entries.map((e: any) => (
                        <Link
                          key={e.mediaId || e.media?.id}
                          href={animeHref(e.media?.id || e.mediaId, clickTarget)}
                          className="flex items-center gap-3 px-3 py-2 hover:bg-action/10 transition-colors"
                        >
                          {e.media?.coverImage?.large ? (
                            <Image
                              src={e.media.coverImage.large}
                              alt=""
                              width={40}
                              height={40}
                              className="w-10 h-10 rounded-md object-cover shrink-0"
                            />
                          ) : (
                            <div className="w-10 h-10 rounded-md bg-white/10 shrink-0" />
                          )}
                          <span className="flex-1 min-w-0 text-sm font-medium truncate">
                            {pickTitle(e.media?.title, titlePref)}
                          </span>
                          {e.score ? (
                            <span className="text-xs text-white/60 w-10 text-center shrink-0">
                              ★ {e.score}
                            </span>
                          ) : (
                            <span className="w-10 shrink-0" />
                          )}
                          <span className="text-xs text-white/60 w-16 text-right shrink-0">
                            {e.media?.episodes
                              ? `${e.progress}/${e.media.episodes}`
                              : e.progress}
                          </span>
                        </Link>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          </>
        )}
      </motion.div>
      <Footer />
      {isOwner && (
        <ForYouPanel isVisible={showForYou} onClose={() => setShowForYou(false)} />
      )}
    </>
  );
}

export async function getServerSideProps(context: any) {
  const query = context.query;

  const [data, session] = await pls.post(
    "https://graphql.anilist.co/",
    {
      body: JSON.stringify({
        query: `
          query ($username: String, $status: MediaListStatus) {
            MediaListCollection(userName: $username, type: ANIME, status: $status, sort: SCORE_DESC) {
              user {
                id
                name
                about (asHtml: true)
                createdAt
                avatar {
                    large
                }
                statistics {
                  anime {
                      count
                      episodesWatched
                      meanScore
                      minutesWatched
                  }
              }
                bannerImage
                mediaListOptions {
                  animeList {
                      sectionOrder
                  }
                }
              }
              lists {
                status
                name
                entries {
                  id
                  mediaId
                  status
                  progress
                  score
                  media {
                    id
                    status
                    title {
                      english
                      romaji
                    }
                    episodes
                    coverImage {
                      large
                    }
                  }
                }
              }
            }
          }
        `,
        variables: {
          username: query.user,
        },
      }),
    },
    context
  );

  const get = data?.data?.MediaListCollection;
  const sectionOrder = get?.user.mediaListOptions.animeList.sectionOrder;

  if (!sectionOrder) {
    return {
      notFound: true,
    };
  }

  // ── Profile visibility gate ──────────────────────────────────────
  // Look up the VIEWED user's app settings. When their profile is marked
  // private, only the owner (signed in as the same AniList name) may see it;
  // everyone else gets a "private profile" page (not a 404, so it's clear the
  // user exists but chose to hide their list).
  const viewedUserData = await getUser(query.user, false).catch(() => null);
  const isOwner =
    !!session?.user?.name &&
    String(session.user.name).toLowerCase() ===
      String(query.user).toLowerCase();
  if (viewedUserData?.setting?.private === true && !isOwner) {
    return { props: { isPrivate: true, viewedName: query.user } };
  }

  let userData;

  if (session) {
    userData = await getUser(session.user.name, false);
  }

  const prog = get.lists;

  function getIndex(status: string) {
    const index = sectionOrder.indexOf(status);
    return index === -1 ? sectionOrder.length : index;
  }

  prog.sort(
    (a: { name: string }, b: { name: string }) =>
      getIndex(a.name) - getIndex(b.name)
  );

  const user = get.user;

  const time = convertMinutesToDays(user.statistics.anime.minutesWatched);

  return {
    props: {
      media: prog,
      sessions: session,
      user: user,
      time: time,
      userSettings: userData?.setting || null,
    },
  };
}

function convertMinutesToDays(minutes: number) {
  const hours = minutes / 60;
  const days = hours / 24;

  if (days >= 1) {
    return days % 1 === 0
      ? { days: `${days}` }
      : { days: `${days.toFixed(1)}` };
  } else {
    return hours % 1 === 0
      ? { hours: `${hours}` }
      : { hours: `${hours.toFixed(1)}` };
  }
}
