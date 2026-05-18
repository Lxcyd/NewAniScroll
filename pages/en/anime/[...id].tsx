import Head from "next/head";
import { useEffect, useState } from "react";
import Modal from "@/components/modal";

import { signIn, useSession } from "next-auth/react";
import AniList from "@/components/media/aniList";
import ListEditor from "@/components/listEditor";

import { useAniList } from "@/lib/anilist/useAnilist";
import Footer from "@/components/shared/footer";
import { mediaInfoQuery } from "@/lib/graphql/query";
import MobileNav from "@/components/shared/MobileNav";

import pls from "@/utils/request/index";

import { redis } from "@/lib/redis";
import { primeMediaCache } from "@/lib/anilist/getMediaMeta";
import { getCachedAnime } from "@/lib/db/anime";
import { loadFanarts, FanartPayload } from "@/lib/db/fanarts";
import { resolveSeasonChain } from "@/lib/anilist/seasonChain";
import { toast } from "sonner";
import { Navbar } from "@/components/shared/NavBar";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import InfoPage from "@/components/anime/v2/InfoPage";
import { pickTitleImage, slugifyTitle, SeasonInfo } from "@/components/anime/v2/helpers";

type InfoTypes = {
  info: AniListInfoTypes;
  color: string;
  api: string;
  chapterNotFound: string;
  fanarts: FanartPayload | null;
  /** Clearart/logo URL picked at SSR time so the <img> is in the
   *  initial HTML and starts streaming with the document. */
  initialTitleImage: { url: string; kind: "clearart" | "logo" } | null;
  /** S<n> of N — resolved by walking PREQUEL/SEQUEL chains at SSR. */
  seasonInfo: SeasonInfo;
};

// Bump when the shape of `info` changes — or when a SSR-side computation
// it influences (e.g. seasonInfo) gets a non-backwards-compatible fix.
// Past payloads remain in Redis under the old key and naturally expire.
//
// v3 — season detection rewrite: title-based extraction + franchise-
//      sanity filter on PREQUEL/SEQUEL walks. Without bumping, anime
//      cached under v2 would keep serving the old (often wrong) S<n>
//      label.
const CACHE_VERSION = "v3";

export default function Info({
  info,
  chapterNotFound,
  fanarts,
  initialTitleImage,
  seasonInfo,
}: InfoTypes) {
  const { data: session }: any = useSession();
  const { getUserLists, toggleFavourite } = useAniList(session);

  const [progress, setProgress] = useState<number>(0);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [domainUrl, setDomainUrl] = useState("");
  const [fav, setFav] = useState<boolean>(false);

  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (chapterNotFound) {
      toast.error("Source not found");
      const cleanUrl = window.location.origin + window.location.pathname;
      window.history.replaceState(null, "", cleanUrl);
    }
  }, [chapterNotFound]);

  // Rewrite the URL to include a human-readable slug after the AniList
  // id (e.g. /en/anime/108511/that-time-i-got-reincarnated-as-a-slime).
  // The catch-all route (`[...id]`) already accepts and ignores extra
  // segments, so the page itself doesn't need to change — we just
  // decorate the URL via history.replaceState so it's nice to share.
  // Anything after the hash (#episodes etc.) is preserved.
  useEffect(() => {
    if (!info?.id) return;
    const slug = slugifyTitle(info.title);
    if (!slug) return;
    const expected = `/en/anime/${info.id}/${slug}`;
    const current = window.location.pathname;
    if (current === expected) return;
    // Only rewrite when the current path is the bare /en/anime/{id}
    // form — don't touch URLs that already carry some other segment
    // the user typed manually.
    if (current === `/en/anime/${info.id}` || current === `/en/anime/${info.id}/`) {
      const search = window.location.search || "";
      const hash = window.location.hash || "";
      window.history.replaceState(null, "", expected + search + hash);
    }
  }, [info?.id, info?.title]);

  useEffect(() => {
    handleClose();
    setDomainUrl(window.location.origin);
    async function fetchData() {
      if (!info?.id) return;
      setProgress(0);
      setStatusLabel(null);
      setFav(false);
      if (session?.user?.name) {
        try {
          const res = await getUserLists(info.id);
          const media = res?.data?.Media;
          const entry = media?.mediaListEntry;
          if (entry) {
            setProgress(entry.progress || 0);
            setStatusLabel(entry.status || null);
          }
          // AniList returns isFavourite outside mediaListEntry — it's
          // a property of Media itself, true even for anime that
          // haven't been added to any list.
          if (typeof media?.isFavourite === "boolean") {
            setFav(media.isFavourite);
          }
        } catch (error) {
          console.error(error);
        }
      }
    }
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.id, session?.user?.name]);

  /* Optimistic favourite toggle. Flips the heart immediately so the
     click feels instant; if the AniList mutation fails we roll back
     and surface a toast. Requires the user to be signed in. */
  const handleToggleFav = async () => {
    if (!session?.user?.name) {
      handleOpen(); // opens the login modal that the list-editor uses
      return;
    }
    const previous = fav;
    setFav(!previous);
    try {
      const res = await toggleFavourite(info.id);
      if (res?.errors?.length) throw new Error(res.errors[0]?.message);
    } catch (e: any) {
      setFav(previous);
      toast.error(`Couldn't update favourite: ${e?.message || "unknown"}`);
    }
  };

  function handleOpen() {
    if (!session) {
      setOpen(true);
      document.body.style.overflow = "hidden";
      return;
    }
    setOpen(true);
    document.body.style.overflow = "hidden";
  }

  function handleClose() {
    setOpen(false);
    if (typeof document !== "undefined") document.body.style.overflow = "auto";
  }

  const title = info?.title?.english || info?.title?.romaji || "Anime";
  const watchUrl = info
    ? `/en/anime/watch/${info.id}/megaplay?id=megaplay-${info.id}-${
        Math.max(1, progress + 1)
      }&num=${Math.max(1, progress + 1)}`
    : undefined;

  return (
    <>
      <Head>
        <title>{info ? title : "Retrieving Data..."}</title>
        <meta
          name="title"
          content={info?.title?.romaji}
          data-title-romaji={info?.title?.romaji}
          data-title-english={info?.title?.english || ""}
          data-title-native={info?.title?.native || ""}
        />
        <meta name="description" content={info?.description?.slice(0, 220) || ""} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={`AniScroll - ${title}`} />
        <meta
          name="twitter:description"
          content={`${info?.description?.slice(0, 180) || ""}...`}
        />
        <meta
          name="twitter:image"
          content={`${domainUrl}/api/og?title=${encodeURIComponent(title)}&image=${
            info?.bannerImage || info?.coverImage?.extraLarge || ""
          }`}
        />
        {/* Fonts used by the V2 design — Inter already loaded globally;
            Space Grotesk + JetBrains Mono are only needed on this page. */}
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        {/* High-priority preload for the central hero artwork. Picked at
            SSR time so the browser starts fetching it during HTML parsing,
            well before React hydrates. */}
        {initialTitleImage?.url && (
          <link
            rel="preload"
            as="image"
            href={initialTitleImage.url}
            fetchPriority="high"
          />
        )}
        {info?.bannerImage && (
          <link
            rel="preload"
            as="image"
            href={info.bannerImage}
            fetchPriority="high"
          />
        )}
      </Head>

      <Navbar info={info} />

      <Modal open={open} onClose={() => handleClose()}>
        <div>
          {!session && (
            <div className="flex-center flex-col gap-5 px-10 py-5 bg-secondary rounded-md">
              <div className="text-md font-extrabold font-karla">Edit your list</div>
              <button
                className="flex items-center bg-[#363642] rounded-md text-white p-1"
                onClick={() => signIn("AniListProvider")}
              >
                <h1 className="px-1 font-bold font-karla">Login with AniList</h1>
                <div className="scale-[60%] pb-[1px]">
                  <AniList />
                </div>
              </button>
            </div>
          )}
          {session && info && (
            <ListEditor
              animeId={info.id}
              session={session}
              stats={statusLabel || undefined}
              prg={progress}
              max={info?.episodes ?? undefined}
              info={info}
              close={handleClose}
            />
          )}
        </div>
      </Modal>

      <MobileNav hideProfile={true} />

      <main>
        <InfoPage
          info={info}
          initialFanarts={fanarts}
          initialTitleImage={initialTitleImage}
          seasonInfo={seasonInfo}
          statusLabel={statusLabel}
          fav={fav}
          progress={progress}
          watchUrl={watchUrl}
          onOpenListEditor={handleOpen}
          onToggleFav={handleToggleFav}
        />
      </main>

      <Footer />
    </>
  );
}

export async function getServerSideProps(ctx: any) {
  const { id, notfound } = ctx.query;

  let API_URI;
  API_URI = process.env.API_URI || null;
  if (API_URI && API_URI.endsWith("/")) {
    API_URI = API_URI.slice(0, -1);
  }

  let cache: string | null = null;
  let chapterNotFound: string | null = null;

  if (notfound) {
    chapterNotFound = Math.random().toString(36).substring(7);
  }

  const cacheKey = `anime:${CACHE_VERSION}:${id}`;

  if (redis) {
    cache = await redis.get(cacheKey);
  }

  const animeIdNum = Number(id?.[0]);

  if (cache) {
    const { info, color } = JSON.parse(cache);
    // Fanarts are loaded fresh every request (cheap single-row Turso read).
    // They evolve more often than AniList metadata so caching them
    // alongside `info` would mean stale clearart for hours.
    // Season chain walk benefits from getMediaMeta's three-tier cache,
    // so it's near-free on a warm DB. Failures fall back to "no season
    // info" silently — the watch button just reads "EP NN" then.
    const [fanarts, seasonInfo] = await Promise.all([
      loadFanarts(animeIdNum).catch(() => null),
      resolveSeasonChain(animeIdNum).catch(() => ({ number: null, total: null })),
    ]);
    const initialTitleImage = pickTitleImage(fanarts);
    return {
      props: {
        info,
        color,
        api: API_URI,
        chapterNotFound: chapterNotFound || null,
        fanarts,
        initialTitleImage,
        seasonInfo,
      },
    };
  }

  let data: any = null;
  const simulateDown = process.env.ANILIST_SIMULATE_DOWN === "1";
  try {
    if (simulateDown) throw new Error("simulated AniList outage");
    const [resp] = await pls.post("https://graphql.anilist.co/", {
      body: JSON.stringify({
        query: mediaInfoQuery,
        variables: { id: id?.[0] },
      }),
    });
    data = resp?.data?.Media || null;
  } catch (e: any) {
    console.warn(`[anime SSR] AniList fetch failed for ${id?.[0]}:`, e?.message);
  }

  if (data) {
    primeMediaCache(animeIdNum, data);
  } else {
    try {
      const cached = await getCachedAnime(animeIdNum);
      if (cached?.data) {
        console.log(
          `[anime SSR] using DB cache for ${id?.[0]} (stale=${cached.isStale})`
        );
        data = cached.data;
      }
    } catch (e: any) {
      console.warn(`[anime SSR] DB fallback failed:`, e?.message);
    }
  }

  const cacheTime = data?.nextAiringEpisode?.episode ? 60 * 10 : 60 * 60 * 24 * 30;

  if (!data) {
    return { notFound: true };
  }

  const textColor = setTxtColor(data?.coverImage?.color);
  const color = {
    backgroundColor: `${data?.coverImage?.color || "#ffff"}`,
    color: textColor,
  };

  // Run the fanart + season-chain reads concurrently with the Redis write
  // below. Both ship as small inline payloads in the HTML response.
  const fanartsP = loadFanarts(animeIdNum).catch(() => null);
  const seasonInfoP = resolveSeasonChain(animeIdNum).catch(
    () => ({ number: null, total: null })
  );

  if (redis) {
    await redis.set(
      cacheKey,
      JSON.stringify({ info: data, color }),
      "EX",
      cacheTime
    );
  }

  const [fanarts, seasonInfo] = await Promise.all([fanartsP, seasonInfoP]);
  const initialTitleImage = pickTitleImage(fanarts);

  return {
    props: {
      info: data,
      color,
      api: API_URI,
      chapterNotFound: chapterNotFound || null,
      fanarts,
      initialTitleImage,
      seasonInfo,
    },
  };
}

function getBrightness(hexColor: { match: (arg0: RegExp) => any[] } | null) {
  if (!hexColor) return 200;
  const rgb = hexColor
    .match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i)
    .slice(1)
    .map((x: string) => parseInt(x, 16));
  return (299 * rgb[0] + 587 * rgb[1] + 114 * rgb[2]) / 1000;
}

function setTxtColor(hexColor: { match: (arg0: RegExp) => any[] } | null) {
  const brightness = getBrightness(hexColor);
  return brightness < 150 ? "#fff" : "#000";
}
