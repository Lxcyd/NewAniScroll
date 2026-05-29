import { aniListData, aniListHomepageBatch } from "@/lib/anilist/AniList";
import { useState, useEffect, Fragment } from "react";
import Head from "next/head";
import Link from "next/link";
import Footer from "@/components/shared/footer";
import Image from "next/image";
import Content from "@/components/home/content";

import { motion, AnimatePresence } from "framer-motion";

import { signOut, useSession } from "next-auth/react";
import Genres from "@/components/home/genres";
import Schedule from "@/components/home/schedule";
import getUpcomingAnime from "@/lib/anilist/getUpcomingAnime";

import GetMedia from "@/lib/anilist/getMedia";
import MobileNav from "@/components/shared/MobileNav";
import { getGreetings } from "@/utils/getGreetings";
import { redis } from "@/lib/redis";
import { Navbar } from "@/components/shared/NavBar";
import UserRecommendation from "@/components/home/recommendation";
import { useRouter } from "next/router";
import { loadFanarts } from "@/lib/db/fanarts";
import { pickTitleImage, TitleImage } from "@/components/anime/v2/helpers";

export async function getServerSideProps(ctx: any) {
  // Edge-cache the home page aggressively. The response is identical for
  // every visitor (anonymous AND logged-in — the personalised carousels
  // hydrate client-side, the SSR'd content is trending/popular/genre
  // which is anonymous data). Split headers so browsers keep a short
  // cache (1 min — fresh on hard refresh) while Vercel's edge holds it
  // for 2 h + 24 h stale-while-revalidate. Trending/popular only really
  // shifts once a day so 2 h fresh is plenty.
  ctx?.res?.setHeader?.("Cache-Control", "public, max-age=60");
  ctx?.res?.setHeader?.(
    "CDN-Cache-Control",
    "public, s-maxage=7200, stale-while-revalidate=86400",
  );
  let cachedData;

  if (redis) {
    cachedData = await redis.get("index_server");
  }

  // Resolve the hero entries (clearart/logo for the top trending titles)
  // outside the Redis branch — fanart is cheap (single Turso row each) and
  // keeping it out of the homepage cache lets us swap in new clearart as
  // fanart entries are reviewed without waiting 2 h for the cache to expire.
  const resolveHeroEntries = async (
    items: any[],
  ): Promise<Array<HeroEntry>> => {
    if (!Array.isArray(items)) return [];
    // Top 5 visible in the rail (first feature + 4 side previews).
    const slice = items.slice(0, 5);
    return Promise.all(
      slice.map(async (it) => {
        const fanarts = await loadFanarts(Number(it?.id)).catch(() => null);
        return {
          id: it?.id,
          title: it?.title || { english: null, romaji: null },
          coverImage: it?.coverImage || null,
          bannerImage: it?.bannerImage || null,
          description: it?.description || "",
          status: it?.status || null,
          titleImage: pickTitleImage(fanarts),
        };
      }),
    );
  };

  if (cachedData) {
    const { genre, detail, populars, firstTrend } = JSON.parse(cachedData);
    const [upComing, heroEntries] = await Promise.all([
      getUpcomingAnime(),
      resolveHeroEntries(detail?.data || []),
    ]);
    return {
      props: {
        genre,
        detail,
        populars,
        upComing,
        firstTrend,
        heroEntries,
      },
    };
  } else {
    // Single batched GraphQL request fetches trending+popular+genre in ONE
    // AniList token cost (was: 3 separate requests = 3× rate-limit consumption).
    const [batch, upComing] = await Promise.all([
      aniListHomepageBatch(),
      Promise.race([
        getUpcomingAnime().catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
      ]),
    ]);
    const trendingDetail = batch.trending;
    const popularDetail = batch.popular;
    const genreDetail = batch.genre;

    if (redis) {
      await redis.set(
        "index_server",
        JSON.stringify({
          genre: genreDetail.props,
          detail: trendingDetail.props,
          populars: popularDetail.props,
          firstTrend: trendingDetail.props.data?.[0] || null,
        }), // set cache for 2 hours
        "EX",
        60 * 60 * 2
      );
    }

    const heroEntries = await resolveHeroEntries(
      trendingDetail.props.data || [],
    );

    return {
      props: {
        genre: genreDetail.props,
        detail: trendingDetail.props,
        populars: popularDetail.props,
        upComing,
        firstTrend: trendingDetail.props.data?.[0] || null,
        heroEntries,
      },
    };
  }
}

type HeroEntry = {
  id: number;
  title: { english: string | null; romaji: string | null };
  coverImage: { extraLarge?: string; color?: string } | null;
  bannerImage: string | null;
  description: string;
  status: string | null;
  titleImage: TitleImage | null;
};

type HomeProps = {
  genre: any;
  detail: any;
  populars: any;
  upComing: any;
  firstTrend: any;
  heroEntries: HeroEntry[];
};

/* ── Cinematic hero ──────────────────────────────────────────────────
   Full-bleed banner background, HD clearart/logo overlay, side preview
   thumbnails of the next four trending titles. Hovering / clicking a
   side thumb swaps focus; auto-advances every 7 s otherwise.
   Mobile collapses to a poster-on-the-side card so it doesn't dominate
   the small viewport — preserves prior behaviour on phones.            */
const HERO_AUTO_INTERVAL_MS = 8000;
const STATUS_TAG: Record<string, { label: string; dot: string }> = {
  RELEASING: { label: "AIRING", dot: "bg-emerald-400" },
  FINISHED: { label: "FINISHED", dot: "bg-zinc-400" },
  NOT_YET_RELEASED: { label: "SOON", dot: "bg-sky-400" },
  CANCELLED: { label: "CANCELLED", dot: "bg-red-400" },
  HIATUS: { label: "HIATUS", dot: "bg-amber-400" },
};

function HeroBanner({
  entries,
  firstTrend,
  onPlay,
  stripDescription,
}: {
  entries: HeroEntry[];
  firstTrend: any;
  onPlay: (id: number) => void;
  stripDescription: (s: string) => string;
}) {
  // Stable list: SSR-provided entries, falling back to a single entry
  // synthesised from firstTrend when the fanart fetch returned empty.
  const list: HeroEntry[] =
    entries && entries.length > 0
      ? entries
      : firstTrend
        ? [
            {
              id: firstTrend.id,
              title: firstTrend.title,
              coverImage: firstTrend.coverImage,
              bannerImage: firstTrend.bannerImage || null,
              description: firstTrend.description || "",
              status: firstTrend.status || null,
              titleImage: null,
            },
          ]
        : [];

  const [idx, setIdx] = useState(0);
  // Pause auto-advance while the user is hovering or focused so we don't
  // swap the card under their cursor mid-click.
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (hovered || list.length < 2) return;
    const t = window.setInterval(() => {
      setIdx((i) => (i + 1) % list.length);
    }, HERO_AUTO_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, [hovered, list.length]);

  if (list.length === 0) return null;
  const active = list[idx % list.length];
  const otherEntries = list.filter((_, i) => i !== idx % list.length).slice(0, 4);

  const title =
    active.title?.english || active.title?.romaji || "Untitled";
  const statusInfo = active.status ? STATUS_TAG[active.status] : null;
  // Fall back to coverImage when there's no banner (rare for top trending
  // but happens on brand-new entries). Cover stretched is uglier but still
  // gives us something to layer the gradient on.
  const bg = active.bannerImage || active.coverImage?.extraLarge || null;
  const accent = active.coverImage?.color || "#E94560";

  return (
    <div
      className="hidden lg:block relative w-full overflow-hidden"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Background banner. Keyed on the entry id so React swaps the <img>
          cleanly between frames and the framer-motion fade reuses the
          composited bitmap rather than fading a blank canvas. */}
      <div className="relative aspect-[21/9] max-h-[680px] min-h-[420px] w-full">
        <AnimatePresence mode="wait">
          <motion.div
            key={`bg-${active.id}`}
            initial={{ opacity: 0, scale: 1.04 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.7, ease: "easeOut" }}
            className="absolute inset-0"
          >
            {bg ? (
              <Image
                src={bg}
                alt=""
                fill
                priority={idx === 0}
                sizes="100vw"
                quality={90}
                className="object-cover object-center"
              />
            ) : (
              <div
                className="absolute inset-0"
                style={{ backgroundColor: accent }}
              />
            )}
          </motion.div>
        </AnimatePresence>

        {/* Cinematic gradients. Bottom fade hides the seam against the
            next section; left fade boosts text contrast on the logo + CTA
            stack. Both are pure CSS so they cost nothing per frame. */}
        <div className="absolute inset-0 bg-gradient-to-r from-primary via-primary/60 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-t from-primary via-primary/20 to-transparent" />
        {/* Subtle vignette anchor so the logo never sits on a hot pixel
            spot when the banner is bright (white sky, etc.). */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_left,rgba(0,0,0,0.55),transparent_60%)]" />

        {/* Content column */}
        <div className="absolute inset-0 flex">
          <div className="flex w-full xl:w-[60%] lg:w-[65%] flex-col justify-end gap-5 pb-16 pl-[8%] pr-8">
            <AnimatePresence mode="wait">
              <motion.div
                key={`stack-${active.id}`}
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -16 }}
                transition={{ duration: 0.45, ease: "easeOut" }}
                className="flex flex-col gap-5"
              >
                {/* HD clearart / logo. Falls back to a stylised text
                    title when no fanart is available. Keeps the same
                    drop-shadow so both variants feel like the same
                    layer. */}
                {active.titleImage ? (
                  <Image
                    src={active.titleImage.url}
                    alt={title}
                    width={640}
                    height={260}
                    quality={95}
                    priority={idx === 0}
                    className="h-auto w-auto max-h-[180px] max-w-[60%] object-contain drop-shadow-[0_8px_24px_rgba(0,0,0,0.65)]"
                  />
                ) : (
                  <h1 className="font-outfit font-extrabold text-white text-5xl xl:text-6xl leading-[1.05] max-w-[80%] drop-shadow-[0_4px_16px_rgba(0,0,0,0.7)]">
                    {title}
                  </h1>
                )}

                {/* Metadata row */}
                <div className="flex items-center gap-3 flex-wrap">
                  {statusInfo && (
                    <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-karla font-semibold tracking-wider text-white/90 backdrop-blur-sm">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${statusInfo.dot}`}
                      />
                      {statusInfo.label}
                    </span>
                  )}
                  <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-karla font-semibold tracking-wider text-white/90 backdrop-blur-sm">
                    TRENDING
                  </span>
                  <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-karla font-semibold tracking-wider text-white/90 backdrop-blur-sm">
                    #{idx + 1}
                  </span>
                </div>

                {/* Description (2 lines) */}
                <p className="font-roboto font-light text-base xl:text-lg line-clamp-2 max-w-[90%] text-white/80">
                  {stripDescription(active.description || "")}
                </p>

                {/* CTAs */}
                <div className="flex items-center gap-3 mt-2">
                  <button
                    onClick={() => onPlay(active.id)}
                    className="inline-flex items-center gap-2 rounded-full bg-action px-6 py-3 font-karla font-semibold text-white text-sm tracking-wider shadow-lg shadow-action/30 transition-all hover:bg-action/90 hover:scale-[1.02]"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      className="h-4 w-4"
                    >
                      <path d="M8 5v14l11-7z" />
                    </svg>
                    WATCH NOW
                  </button>
                  <Link
                    href={`/en/anime/${active.id}`}
                    className="inline-flex items-center gap-2 rounded-full bg-white/10 px-6 py-3 font-karla font-semibold text-white text-sm tracking-wider backdrop-blur-sm transition-colors hover:bg-white/20"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      className="h-4 w-4"
                    >
                      <path d="M11 17h2v-6h-2v6zm1-15C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zM11 9h2V7h-2v2z" />
                    </svg>
                    MORE INFO
                  </Link>
                </div>
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Right rail with arrows + side thumbnails */}
          <div className="hidden lg:flex w-[35%] xl:w-[40%] flex-col items-end justify-between pt-10 pb-12 pr-[6%]">
            {/* Prev / next arrows. Sit at the top so the slider control
                is reachable without crossing into the artwork. */}
            <div className="flex gap-2">
              <button
                type="button"
                aria-label="Previous trending"
                onClick={() =>
                  setIdx((i) => (i - 1 + list.length) % list.length)
                }
                className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white backdrop-blur-sm transition-colors hover:bg-white/20"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className="h-5 w-5"
                >
                  <path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
                </svg>
              </button>
              <button
                type="button"
                aria-label="Next trending"
                onClick={() => setIdx((i) => (i + 1) % list.length)}
                className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white backdrop-blur-sm transition-colors hover:bg-white/20"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className="h-5 w-5"
                >
                  <path d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
                </svg>
              </button>
            </div>

            {/* Side preview thumbnails — clicking a thumb jumps focus. */}
            {otherEntries.length > 0 && (
              <div className="flex items-end gap-3">
                {otherEntries.map((e) => {
                  const realIdx = list.findIndex((x) => x.id === e.id);
                  return (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => setIdx(realIdx)}
                      className="group relative h-[170px] w-[120px] overflow-hidden rounded-lg border border-white/10 shadow-lg transition-transform hover:scale-[1.04] hover:border-white/30"
                    >
                      {e.coverImage?.extraLarge ? (
                        <Image
                          src={e.coverImage.extraLarge}
                          alt={
                            e.title?.english ||
                            e.title?.romaji ||
                            "thumbnail"
                          }
                          fill
                          sizes="120px"
                          className="object-cover"
                        />
                      ) : (
                        <div className="absolute inset-0 bg-white/5" />
                      )}
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-2">
                        <span className="block truncate text-[11px] font-karla font-semibold text-white">
                          {e.title?.english || e.title?.romaji || ""}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Progress dots — visual cue for the auto-cycle position. */}
        <div className="absolute bottom-6 left-[8%] flex gap-1.5">
          {list.map((_, i) => (
            <span
              key={i}
              className={`h-1 rounded-full transition-all ${
                i === idx % list.length
                  ? "w-8 bg-action"
                  : "w-4 bg-white/30"
              }`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export interface SessionTypes {
  name: string;
  picture: Picture;
  sub: string;
  token: string;
  id: number;
  image: Image;
  list: string[];
  version: string;
  iat: number;
  exp: number;
  jti: string;
}

interface Picture {
  large: string;
  medium: string;
}

interface Image {
  large: string;
  medium: string;
}

export default function Home({
  detail,
  populars,
  upComing,
  firstTrend,
  heroEntries,
}: HomeProps) {
  const { data: sessions }: any = useSession();
  const userSession: SessionTypes = sessions?.user;

  const {
    anime: currentAnime,
    recommendations,
  }: {
    anime: CurrentMediaTypes[];
    recommendations: CurrentMediaTypes[];
  } = GetMedia(sessions, {
    stats: "CURRENT",
  });
  const { anime: plan }: { anime: CurrentMediaTypes[] } = GetMedia(sessions, {
    stats: "PLANNING",
  });
  const { anime: release } = GetMedia(sessions);

  const router = useRouter();

  const [schedules, setSchedules] = useState(null);
  const [anime, setAnime] = useState([]);

  const [recentAdded, setRecentAdded] = useState([]);

  async function getRecent() {
    const data = await fetch(`/api/v2/etc/recent/1`)
      .then((res) => res.json())
      .catch((err) => console.log(err));

    setRecentAdded(data?.results);
  }

  useEffect(() => {
    if (userSession?.version) {
      if (userSession?.version !== "1.0.1") {
        signOut({ redirect: true });
      }
    }
  }, [userSession?.version]);

  useEffect(() => {
    getRecent();
  }, []);

  const update = () => {
    setAnime((prevAnime) => prevAnime.slice(1));
  };

  useEffect(() => {
    if (upComing && upComing.length > 0) {
      setAnime(upComing);
    }
  }, [upComing]);

  const [releaseData, setReleaseData] = useState<any[]>([]);

  useEffect(() => {
    function getRelease() {
      let releasingAnime: any[] = [];
      let progress: any[] = [];
      let seenIds = new Set<number>(); // Create a Set to store the IDs of seen anime
      (release as any[]).forEach((list: any) => {
        list.entries.forEach((entry: any) => {
          if (
            entry.media.status === "RELEASING" &&
            !seenIds.has(entry.media.id)
          ) {
            releasingAnime.push(entry.media);
            seenIds.add(entry.media.id); // Add the ID to the Set
          }
          progress.push(entry);
        });
      });
      setReleaseData(releasingAnime);
      if (progress.length > 0) setProg(progress);
    }
    getRelease();
  }, [release]);

  const [listAnime, setListAnime] = useState<any[] | null>();
  const [planned, setPlanned] = useState<any[] | null>(null);
  const [user, setUser] = useState<any[] | null>(null);
  const [removed, setRemoved] = useState();

  const [prog, setProg] = useState<any[] | null>();

  const popular = populars?.data;

  useEffect(() => {
    async function userData() {
      try {
        if (userSession?.name) {
          await fetch(`/api/user/profile`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              name: sessions.user.name,
            }),
          });
        }
      } catch (error) {
        console.log(error);
      }
      let data: UserDataType | null = null;
      try {
        if (userSession?.name) {
          const res = await fetch(
            `/api/user/profile?name=${sessions.user.name}`
          );
          if (!res.ok) {
            switch (res.status) {
              case 404: {
                console.log("user not found");
                break;
              }
              case 500: {
                console.log("server error");
                break;
              }
              default: {
                console.log("unknown error");
                break;
              }
            }
          } else {
            data = await res.json();
            // Do something with the data
          }
        }
      } catch (error) {
        console.error(error);
        // Handle the error here
      }
      if (!data) {
        // The previous version called Object.keys() on the raw localStorage
        // string, which silently produced numeric character indices rather
        // than the actual entry keys. Parsing first fixes that and lets
        // the Recently Watched carousel actually populate for anonymous /
        // Prisma-less sessions.
        let parsed: Record<string, any> | null = null;
        try {
          const raw = localStorage.getItem("artplayer_settings");
          parsed = raw ? JSON.parse(raw) : null;
        } catch {}
        if (parsed && typeof parsed === "object") {
          const arr = Object.values(parsed) as any[];
          const newFirst = arr.sort(
            (a: any, b: any) =>
              new Date(b?.createdAt || 0).getTime() -
              new Date(a?.createdAt || 0).getTime(),
          );

          const uniqueTitles = new Set<string>();
          const filteredData = newFirst.filter((entry: any) => {
            if (!entry?.aniTitle) return false;
            if (uniqueTitles.has(entry.aniTitle)) return false;
            uniqueTitles.add(entry.aniTitle);
            return true;
          });

          if (filteredData.length) setUser(filteredData);
        }
      } else {
        // Create a Set to store unique aniTitles
        const uniqueTitles = new Set();

        // Filter out duplicates and store unique entries
        const filteredData = data?.WatchListEpisode.filter((entry) => {
          if (uniqueTitles.has(entry.aniTitle)) {
            return false;
          }
          uniqueTitles.add(entry.aniTitle);
          return true;
        });
        setUser(filteredData);
      }
      // const data = await res.json();
    }
    userData();
  }, [userSession?.name, removed]);

  useEffect(() => {
    async function userData() {
      if (!userSession?.name) return;

      const getMedia =
        currentAnime.find((item) => item.status === "CURRENT") || null;
      const listAnime = getMedia?.entries
        .map(({ media }) => media)
        .filter((media) => media);

      const planned = plan?.[0]?.entries
        .map(({ media }) => media)
        .filter((media) => media);

      if (listAnime) {
        setListAnime(listAnime);
      }
      if (planned) {
        setPlanned(planned);
      }
    }
    userData();

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userSession?.name, currentAnime, plan]);

  function removeHtmlTags(text: string): string {
    return text?.replace(/<[^>]+>/g, "");
  }

  return (
    <Fragment>
      <Head>
        <title>AniScroll • Beta</title>
        <meta charSet="UTF-8"></meta>
        <link rel="icon" type="image/png" href="/logo.png" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta
          name="description"
          content="Discover your new favorite anime or manga title! AniScroll offers a vast library of high-quality content, accessible on multiple devices and without any interruptions. Start using AniScroll today!"
        />
        <meta
          name="keywords"
          content="anime, anime streaming, anime streaming website, anime streaming free, anime streaming website free, anime streaming website free english subbed, anime streaming website free english dubbed, anime streaming website free english subbed and dubbed, anime streaming webs
          ite free english subbed and dubbed download, anime streaming website free english subbed and dubbed"
        />
        <meta name="robots" content="index, follow" />

        <meta property="og:type" content="website" />
        <meta
          property="og:title"
          content="AniScroll - Free Anime and Manga Streaming"
        />
        <meta
          property="og:description"
          content="Discover your new favorite anime or manga title! AniScroll offers a vast library of high-quality content, accessible on multiple devices and without any interruptions. Start using AniScroll today!"
        />
        <meta property="og:image" content="/logo.png" />
        <meta property="og:site_name" content="AniScroll" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta
          name="twitter:title"
          content="AniScroll - Free Anime and Manga Streaming"
        />
        <meta
          name="twitter:description"
          content="Discover your new favorite anime or manga title! AniScroll offers a vast library of high-quality content, accessible on multiple devices and without any interruptions. Start using AniScroll today!"
        />
        <meta name="twitter:image" content="/logo.png" />
      </Head>
      <MobileNav hideProfile={true} />

      <Navbar withNav={true} home={true} />
      <div className="h-auto w-screen bg-primary text-[#dbdcdd]">
        <HeroBanner
          entries={heroEntries}
          firstTrend={firstTrend}
          onPlay={(id) => router.push(`/en/anime/${id}`)}
          stripDescription={removeHtmlTags}
        />


        {sessions && (
          <div className="flex items-center justify-center lg:bg-none mt-4 lg:mt-0 w-screen">
            <div className="lg:w-[85%] w-screen px-5 lg:px-0 lg:text-4xl flex items-center gap-3 text-2xl font-bold font-karla">
              {getGreetings() && (
                <>
                  {getGreetings()},
                  <h1 className="lg:hidden">{sessions?.user.name}</h1>
                </>
              )}
              <button
                onClick={() => signOut()}
                className="hidden text-center relative lg:flex justify-center group"
              >
                {sessions?.user.name}
                <span className="absolute text-sm z-50 w-20 text-center bottom-11 text-white shadow-lg opacity-0 bg-secondary p-1 rounded-md font-karla font-light invisible group-hover:visible group-hover:opacity-100 duration-300 transition-all">
                  Sign Out
                </span>
              </button>
            </div>
          </div>
        )}

        <div className="lg:mt-16 mt-5 flex flex-col items-center">
          <motion.div
            className="w-screen flex-none lg:w-[95%] xl:w-[87%]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, staggerChildren: 0.2 }} // Add staggerChildren prop
          >
            {user && user?.length > 0 && user?.some((i) => i?.watchId) && (
              <motion.section // Add motion.div to each child component
                key="recentlyWatched"
                initial={{ y: 20, opacity: 0 }}
                whileInView={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.5 }}
                viewport={{ once: true }}
              >
                <Content
                  ids="recentlyWatched"
                  section="Recently Watched"
                  userData={user}
                  userName={userSession?.name}
                  setRemoved={setRemoved}
                />
              </motion.section>
            )}

            {sessions && releaseData?.length > 0 && (
              <motion.section // Add motion.div to each child component
                key="onGoing"
                initial={{ y: 20, opacity: 0 }}
                whileInView={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.5 }}
                viewport={{ once: true }}
              >
                <Content
                  ids="onGoing"
                  section="On-Going Anime"
                  data={releaseData}
                  og={prog}
                  userName={userSession?.name}
                />
              </motion.section>
            )}

            {sessions && listAnime && listAnime?.length > 0 && (
              <motion.section // Add motion.div to each child component
                key="listAnime"
                initial={{ y: 20, opacity: 0 }}
                whileInView={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.5 }}
                viewport={{ once: true }}
              >
                <Content
                  ids="listAnime"
                  section="Your Watch List"
                  data={listAnime}
                  og={prog}
                  userName={userSession?.name}
                />
              </motion.section>
            )}

            {recommendations.length > 0 && (
              <div className="space-y-4 lg:space-y-5 mb-5 lg:mb-10">
                <div className="px-5">
                  <p className="text-sm lg:text-base">
                    Based on Your List
                    <br />
                    <span className="font-karla text-[20px] lg:text-3xl font-bold">
                      Recommendations
                    </span>
                  </p>
                </div>
                <UserRecommendation data={recommendations} />
              </div>
            )}

            {/* SECTION 2 */}
            {sessions && planned && planned?.length > 0 && (
              <motion.section // Add motion.div to each child component
                key="plannedAnime"
                initial={{ y: 20, opacity: 0 }}
                whileInView={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.5 }}
                viewport={{ once: true }}
              >
                <Content
                  ids="plannedAnime"
                  section="Your Plan"
                  data={planned}
                  userName={userSession?.name}
                />
              </motion.section>
            )}
          </motion.div>

          <motion.div
            className="w-screen flex-none lg:w-[95%] xl:w-[87%]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, staggerChildren: 0.2 }} // Add staggerChildren prop
          >
            {/* SECTION 3 */}
            {recentAdded?.length > 0 && (
              <motion.section // Add motion.div to each child component
                key="recentAdded"
                initial={{ y: 20, opacity: 0 }}
                transition={{ duration: 0.5 }}
                whileInView={{ y: 0, opacity: 1 }}
                viewport={{ once: true }}
              >
                <Content
                  ids="recentAdded"
                  section="Freshly Added"
                  data={recentAdded}
                />
              </motion.section>
            )}

            {/* SECTION 4 */}
            {detail && (
              <motion.section // Add motion.div to each child component
                key="trendingAnime"
                initial={{ y: 20, opacity: 0 }}
                transition={{ duration: 0.5 }}
                whileInView={{ y: 0, opacity: 1 }}
                viewport={{ once: true }}
              >
                <Content
                  ids="trendingAnime"
                  section="Trending Now"
                  data={detail.data}
                />
              </motion.section>
            )}
            {/* <div className="w-full h-[150px] bg-white flex-center my-5 text-black">
              ad banner
            </div> */}

            {/* Schedule */}
            {anime.length > 0 && (
              <motion.section // Add motion.div to each child component
                key="schedule"
                initial={{ y: 20, opacity: 0 }}
                whileInView={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.5 }}
                viewport={{ once: true }}
              >
                <Schedule
                  data={anime[0]}
                  anime={anime}
                  update={update}
                  scheduleData={schedules}
                />
              </motion.section>
            )}

            {/* SECTION 5 */}
            {popular && (
              <motion.section // Add motion.div to each child component
                key="popularAnime"
                initial={{ y: 20, opacity: 0 }}
                whileInView={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.5 }}
                viewport={{ once: true }}
              >
                <Content
                  ids="popularAnime"
                  section="Popular Anime"
                  data={popular}
                />
              </motion.section>
            )}

            <motion.section // Add motion.div to each child component
              key="Genres"
              initial={{ y: 20, opacity: 0 }}
              whileInView={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.5 }}
              viewport={{ once: true }}
            >
              <Genres />
            </motion.section>
          </motion.div>
        </div>
      </div>
      <Footer />
    </Fragment>
  );
}

export interface CurrentMediaTypes {
  status?: string;
  name: string;
  entries: Entry[];
}

export interface Entry {
  id: number;
  mediaId: number;
  status: string;
  progress: number;
  score: number;
  media: Media;
}

export interface Media {
  id: number;
  status: string;
  nextAiringEpisode: any;
  title: Title;
  episodes: number;
  coverImage: CoverImage;
}

export interface Title {
  english: string;
  romaji: string;
}

export interface CoverImage {
  large: string;
}

export interface UserDataType {
  id: string;
  name: string;
  setting: Setting;
  WatchListEpisode: WatchListEpisode[];
}

export interface Setting {
  CustomLists: boolean;
}

export interface WatchListEpisode {
  id: string;
  aniId?: string;
  title?: string;
  aniTitle?: string;
  image?: string;
  episode?: number;
  timeWatched?: number;
  duration?: number;
  provider?: string;
  nextId?: string;
  nextNumber?: number;
  dub?: boolean;
  createdDate: string;
  userProfileId: string;
  watchId: string;
}
