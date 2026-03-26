import { useEffect, useState } from "react";
import { FlagIcon, ShareIcon } from "@heroicons/react/24/solid";
import Details from "@/components/watch/primary/details";
import EpisodeLists from "@/components/watch/secondary/episodeLists";
import { getServerSession } from "next-auth";
import { useWatchProvider } from "@/lib/context/watchPageProvider";
import { authOptions } from "../../../api/auth/[...nextauth]";
import { getRemovedMedia } from "@/prisma/removed";
import { createList, createUser, getEpisode } from "@/prisma/user";
import Link from "next/link";
import MobileNav from "@/components/shared/MobileNav";
import { Navbar } from "@/components/shared/NavBar";
import Modal from "@/components/modal";
import AniList from "@/components/media/aniList";
import { signIn } from "next-auth/react";
import BugReportForm from "@/components/shared/bugReport";
import Skeleton from "react-loading-skeleton";
import Head from "next/head";
import { useRouter } from "next/router";
import { Spinner } from "@vidstack/react";
import RateModal from "@/components/shared/RateModal";

// ─────────────────────────────────────────────────────────────
// SSR
// ─────────────────────────────────────────────────────────────
export async function getServerSideProps(context) {
  let userData = null;
  const session = await getServerSession(context.req, context.res, authOptions);
  const accessToken = session?.user?.token || null;

  const query = context?.query;
  if (!query) return { notFound: true };

  let proxy = process.env.PROXY_URI || null;
  if (proxy && proxy.endsWith("/")) proxy = proxy.slice(0, -1);
  const disqus = process.env.DISQUS_SHORTNAME || null;

  const [aniId, provider] = query?.info;
  const watchId   = query?.id;
  const epiNumber = query?.num;
  const dub       = query?.dub;

  const removed   = await getRemovedMedia();
  const isRemoved = removed?.find((i) => +i?.aniId === +aniId);
  if (isRemoved) {
    return { redirect: { destination: "/en/removed", permanent: false } };
  }

  const ress = await fetch(`https://graphql.anilist.co`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
    },
    body: JSON.stringify({
      query: `query ($id: Int) {
        Media (id: $id) {
          mediaListEntry { progress status customLists repeat }
          id idMal
          title { romaji english native }
          status genres episodes
          studios { edges { node { id name } } }
          bannerImage description
          coverImage { extraLarge color }
          synonyms
        }
      }`,
      variables: { id: aniId },
    }),
  });
  const data = await ress.json();

  try {
    if (session) {
      await createUser(session.user.name);
      await createList(session.user.name, watchId);
      const epData = await getEpisode(session.user.name, watchId);
      userData = JSON.parse(
        JSON.stringify(epData, (key, value) =>
          key === "createdDate" ? String(value) : value
        )
      );
    }
  } catch (error) {
    console.error(error);
  }

  return {
    props: {
      sessions:   session,
      provider:   provider || null,
      watchId:    watchId  || null,
      epiNumber:  epiNumber || null,
      dub:        dub || null,
      userData:   userData?.[0] || null,
      info:       data?.data?.Media || null,
      proxy,
      disqus,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Page component
// ─────────────────────────────────────────────────────────────
export default function Watch({
  info,
  watchId,
  disqus,
  proxy,
  dub,
  userData,
  sessions,
  provider,
  epiNumber,
}) {
  const [artStorage,        setArtStorage]        = useState(null);
  const [episodeNavigation, setEpisodeNavigation] = useState(null);
  const [episodesList,      setepisodesList]      = useState();
  const [mapEpisode,        setMapEpisode]        = useState(null);
  const [open,              setOpen]              = useState(false);
  const [isOpen,            setIsOpen]            = useState(false);
  const [onList,            setOnList]            = useState(false);

  const router = useRouter();

  const {
    theaterMode,
    setAutoNext,
    setAutoPlay,
    setMarked,
    setPlayerState,
    setTrack,
    aspectRatio,
    setDataMedia,
    ratingModalState,
    setRatingModalState,
  } = useWatchProvider();

  // ── Episode list + navigation ────────────────────────────────
  useEffect(() => {
    async function getInfo() {
      if (info.mediaListEntry) setOnList(true);
      setDataMedia(info);

      const response = await fetch(
        `/api/v2/episode/${info.id}?releasing=${
          info.status === "RELEASING" ? "true" : "false"
        }${dub ? "&dub=true" : ""}`
      ).then((res) => res.json());

      const getMap  = response.find((i) => i?.map === true) || response[0];
      let   episodes = response;

      if (getMap) {
        setMapEpisode(getMap?.episodes);
      }

      if (episodes) {
        // Match by URL provider, or fallback to first available provider
        const getProvider = episodes?.find((i) => i.providerId === provider)
          || episodes?.[0];
        const episodeList = getProvider?.episodes.slice(
          0,
          getMap?.episodes?.length ?? getProvider?.episodes?.length
        );
        const playingData = getMap?.episodes.find(
          (i) => i.number === Number(epiNumber)
        );

        if (getProvider && episodeList?.length > 0) {
          setepisodesList(episodeList);
          const epNum = parseInt(epiNumber);
          const currentEpisode  = episodeList?.find((i) => i.number === epNum)
            || { id: `megaplay-${info.id}-${epNum}`, number: epNum };
          const nextEpisode     = episodeList?.find((i) => i.number === epNum + 1);
          const previousEpisode = episodeList?.find((i) => i.number === epNum - 1);

          const vidNav = {
            prev: previousEpisode,
            playing: {
              id:          currentEpisode.id,
              title:       playingData?.title || info?.title?.romaji,
              description: playingData?.description,
              img:         playingData?.img   || playingData?.image,
              number:      currentEpisode.number,
            },
            next: nextEpisode,
          };
          setEpisodeNavigation(vidNav);
        }
      }

      setArtStorage(JSON.parse(localStorage.getItem("artplayer_settings")));
    }

    getInfo();
    return () => setEpisodeNavigation(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions?.user?.name, epiNumber, dub]);

  // ── Auto-next / auto-play + skip data ───────────────────────
  useEffect(() => {
    const autoNext = localStorage.getItem("autoNext");
    const autoPlay = localStorage.getItem("autoplay");
    if (autoNext) setAutoNext(autoNext);
    if (autoPlay) setAutoPlay(autoPlay);

    // Megaplay streams via iframe — no JSON source needed.
    // We still fetch skip-times so future players can use them.
    async function fetchSkip() {
      if (!info?.idMal) return;
      try {
        const skip = await fetch(
          `https://api.aniskip.com/v2/skip-times/${info.idMal}/${parseInt(
            epiNumber
          )}?types[]=ed&types[]=mixed-ed&types[]=mixed-op&types[]=op&types[]=recap&episodeLength=`
        ).then((res) => (res.ok ? res.json() : null));

        const getOp = skip?.results?.find((item) => item.skipType === "op") || null;
        const getEd = skip?.results?.find((item) => item.skipType === "ed") || null;

        const skipData = [
          getOp ? { startTime: Math.round(getOp.interval.startTime), endTime: Math.round(getOp.interval.endTime), text: "Opening" } : null,
          getEd ? { startTime: Math.round(getEd.interval.startTime), endTime: Math.round(getEd.interval.endTime), text: "Ending"  } : null,
        ].filter(Boolean);

        setTrack({ skip: skipData });
      } catch (e) {
        console.error("Skip fetch error:", e);
      }
    }

    fetchSkip();

    return () => {
      setPlayerState({ currentTime: 0, isPlaying: false });
      setMarked(0);
      setTrack(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, watchId, info?.id]);

  // ── Media Session (OS-level now playing) ────────────────────
  useEffect(() => {
    const mediaSession = navigator.mediaSession;
    if (!mediaSession) return;

    const now    = episodeNavigation?.playing;
    const poster = now?.img || info?.bannerImage;
    const title  = now?.title || info?.title?.romaji;

    mediaSession.metadata = new MediaMetadata({
      title,
      artist: `Moopa ${
        title === info?.title?.romaji
          ? "- Episode " + epiNumber
          : `- ${info?.title?.romaji || info?.title?.english}`
      }`,
      artwork: poster ? [{ src: poster, sizes: "512x512", type: "image/jpeg" }] : undefined,
    });
  }, [episodeNavigation, info, epiNumber]);

  // ── Share ────────────────────────────────────────────────────
  const handleShareClick = async () => {
    try {
      if (navigator.share) {
        await navigator.share({
          title: `Watch Now - ${info?.title?.english || info.title.romaji}`,
          url: window.location.href,
        });
      } else {
        alert("Web Share API is not supported in this browser.");
      }
    } catch (error) {
      console.error("Error sharing:", error);
    }
  };

  function handleOpen()  { setOpen(true);  document.body.style.overflow = "hidden"; }
  function handleClose() { setOpen(false); document.body.style.overflow = "auto";   }

  // ── Player ───────────────────────────────────────────────────
  // Always uses megaplay.buzz iframe via AniList id + episode number.
  function Player({ id }) {
    if (!episodeNavigation) {
      return (
        <div className="flex-center aspect-video w-full h-full relative">
          <SpinLoader />
        </div>
      );
    }

    return (
      <iframe
        key={`megaplay-${info.id}-${epiNumber}-${dub ? "dub" : "sub"}`}
        src={`https://megaplay.buzz/stream/ani/${info.id}/${epiNumber}/${
          dub ? "dub" : "sub"
        }`}
        className="aspect-video w-full h-full"
        frameBorder="0"
        scrolling="no"
        allowFullScreen
        allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
      />
    );
  }

  // ── Render ───────────────────────────────────────────────────
  return (
    <>
      <Head>
        <title>
          {episodeNavigation?.playing?.title ||
            `${info?.title?.romaji} - Episode ${epiNumber}`}
        </title>
        <meta
          name="title"
          data-title-romaji={info?.title?.romaji}
          data-title-english={info?.title?.english}
          data-title-native={info?.title?.native}
        />
        <meta name="twitter:card"    content="summary_large_image" />
        <meta name="description"     content={episodeNavigation?.playing?.description || info?.description} />
        <meta name="keywords"        content="anime, anime streaming, anime streaming website, anime streaming free" />
        <meta name="robots"          content="index, follow" />
        <meta property="og:type"     content="website" />
        <meta property="og:title"    content={`Watch - ${episodeNavigation?.playing?.title || info?.title?.english}`} />
        <meta property="og:description" content={episodeNavigation?.playing?.description || info?.description} />
        <meta property="og:image"    content={episodeNavigation?.playing?.img || info?.bannerImage} />
        <meta property="og:site_name" content="Moopa" />
        <meta name="twitter:image"   content={episodeNavigation?.playing?.img || info?.bannerImage} />
        <meta name="twitter:title"   content={`Watch - ${episodeNavigation?.playing?.title || info?.title?.english}`} />
        <meta name="twitter:description" content={episodeNavigation?.playing?.description || info?.description} />
      </Head>

      {/* AniList login modal */}
      <Modal open={open} onClose={() => handleClose()}>
        {!sessions && (
          <div className="flex-center flex-col gap-5 px-10 py-5 bg-secondary rounded-md">
            <h1 className="text-md font-extrabold font-karla">Edit your list</h1>
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
      </Modal>

      <BugReportForm isOpen={isOpen} setIsOpen={setIsOpen} />

      <main className="w-screen h-full">
        {!ratingModalState.isFullscreen && (
          <RateModal
            toggle={ratingModalState.isOpen}
            setToggle={setRatingModalState}
            position="bottom"
            session={sessions}
          />
        )}

        <Navbar
          scrollP={20}
          withNav={true}
          shrink={true}
          paddingY={`py-2 ${theaterMode ? "" : "lg:py-4"}`}
        />
        <MobileNav hideProfile={true} sessions={sessions} />

        <div className={`mx-auto pt-16 ${theaterMode ? "lg:pt-16" : "lg:pt-20"}`}>

          {/* Theater mode player */}
          {theaterMode && (
            <div
              className="bg-black w-full max-h-[84dvh] h-full flex-center rounded-md"
              style={{ aspectRatio }}
            >
              <Player id={`${info.id}-${epiNumber}-theater`} />
            </div>
          )}

          <div
            id="default"
            className={`${
              theaterMode ? "lg:max-w-[95%] xl:max-w-[80%]" : "lg:max-w-[95%]"
            } w-full flex flex-col lg:flex-row mx-auto`}
          >
            {/* ── Primary column ── */}
            <div id="primary" className="w-full">

              {/* Default (non-theater) player */}
              {!theaterMode && (
                <div
                  className={`bg-black w-full flex-center rounded-md overflow-hidden ${
                    aspectRatio === "4/3" ? "aspect-video" : ""
                  }`}
                >
                  <Player id={`${info.id}-${epiNumber}-default`} />
                </div>
              )}

              {/* Details row */}
              <div id="details" className="flex flex-col gap-5 w-full px-3 lg:px-0">
                <div className="flex items-end justify-between pt-3 border-b-2 border-secondary pb-2">
                  <div className="w-[55%]">
                    <div className="flex font-outfit font-semibold text-lg lg:text-2xl text-white line-clamp-1">
                      <Link
                        href={`/en/anime/${info?.id}`}
                        className="hover:underline line-clamp-1"
                      >
                        {(episodeNavigation?.playing?.title || info.title.romaji) ?? "Loading..."}
                      </Link>
                    </div>
                    <h3 className="font-karla">
                      {episodeNavigation?.playing?.number ? (
                        `Episode ${episodeNavigation?.playing?.number}`
                      ) : (
                        <Skeleton width={120} height={16} />
                      )}
                    </h3>
                  </div>

                  <div className="flex gap-2 text-sm">
                    <button
                      type="button"
                      onClick={handleShareClick}
                      className="flex items-center gap-2 px-3 py-1 ring-[1px] ring-white/20 rounded overflow-hidden"
                    >
                      <ShareIcon className="w-5 h-5" />
                      <span className="hidden lg:block">share</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsOpen(true)}
                      className="flex items-center gap-2 px-3 py-1 ring-[1px] ring-white/20 rounded overflow-hidden"
                    >
                      <FlagIcon className="w-5 h-5" />
                      <span className="hidden lg:block">report</span>
                    </button>
                  </div>
                </div>

                <Details
                  info={info}
                  session={sessions}
                  description={info?.description}
                  epiNumber={epiNumber}
                  id={info}
                  onList={onList}
                  setOnList={setOnList}
                  handleOpen={() => handleOpen()}
                  disqus={disqus}
                />
              </div>
            </div>

            {/* ── Secondary column (episode list) ── */}
            <div
              id="secondary"
              className={`relative ${theaterMode ? "pt-5" : "pt-4 lg:pt-0"}`}
            >
              <EpisodeLists
                info={info}
                session={sessions}
                map={mapEpisode}
                providerId={provider}
                watchId={watchId}
                episode={episodesList}
                artStorage={artStorage}
                track={episodeNavigation}
                dub={dub}
              />
            </div>
          </div>
        </div>
      </main>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function SpinLoader() {
  return (
    <div className="pointer-events-none absolute inset-0 z-50 flex h-full w-full items-center justify-center">
      <Spinner.Root className="text-white animate-spin opacity-100" size={84}>
        <Spinner.Track className="opacity-25" width={8} />
        <Spinner.TrackFill className="opacity-75" width={8} />
      </Spinner.Root>
    </div>
  );
}