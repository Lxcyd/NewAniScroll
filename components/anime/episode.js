import { useEffect, useState, Fragment } from "react";
import { ChevronDownIcon } from "@heroicons/react/20/solid";
import ViewSelector from "./viewSelector";
import ThumbnailOnly from "./viewMode/thumbnailOnly";
import ThumbnailDetail from "./viewMode/thumbnailDetail";
import ListMode from "./viewMode/listMode";
import { toast } from "sonner";

const ITEMS_PER_PAGE = 13;
const DEFAULT_VIEW = 3;

const fetchEpisodes = async (info, isDub, refresh = false) => {
  const response = await fetch(
    `/api/v2/episode/${info.id}?releasing=${
      info.status === "RELEASING" ? "true" : "false"
    }${isDub ? "&dub=true" : ""}${refresh ? "&refresh=true" : ""}`
  ).then((res) => res.json());

  const providers = filterProviders(response);
  return providers;
};

const filterProviders = (response) => {
  const providersWithMap = response.find((i) => i?.map === true);
  let providers = response;

  if (providersWithMap) {
    providers = response.filter((i) => {
      if (i?.providerId === "gogoanime" && i?.map !== true) {
        return null;
      }
      return i;
    });
  }

  return providers;
};

const setDefaultProvider = (providers, setProviderId) => {
  if (providers.length > 0) {
    const defaultProvider = providers.find(
      (x) => x.providerId === "gogoanime" || x.providerId === "9anime"
    );
    setProviderId(defaultProvider?.providerId || providers[0].providerId);
  }
};

// Build a megaplay watch URL from AniList id + episode number
function buildMegaplayUrl(aniId, episodeNumber, isDub) {
  return `/en/anime/watch/${aniId}/gogoanime?id=megaplay-${aniId}-${episodeNumber}&num=${episodeNumber}${
    isDub ? "&dub=true" : ""
  }`;
}

export default function AnimeEpisode({
  info,
  session,
  progress,
  setProgress,
  setWatch,
}) {
  const [providerId, setProviderId] = useState();
  const [currentPage, setCurrentPage] = useState(1);
  const [visible, setVisible] = useState(false);

  const [loading, setLoading] = useState(true);
  const [artStorage, setArtStorage] = useState(null);
  const [view, setView] = useState(3);
  const [isDub, setIsDub] = useState(false);

  const [providers, setProviders] = useState(null);

  const itemsPerPage = 13;

  useEffect(() => {
    setLoading(true);
    const fetchData = async () => {
      let providers = [];
      try {
        providers = await fetchEpisodes(info, isDub);
        setDefaultProvider(providers, setProviderId);
      } catch (e) {
        console.error("Episode fetch error:", e);
      }
      setView(Number(localStorage.getItem("view")) || DEFAULT_VIEW);
      setArtStorage(JSON.parse(localStorage.getItem("artplayer_settings")));
      setProviders(providers);
      setLoading(false);
    };
    fetchData();

    return () => {
      setCurrentPage(1);
      setProviders(null);
    };
  }, [info.id, isDub]);

  const episodes =
    providers?.find((provider) => provider.providerId === providerId)
      ?.episodes || [];

  const lastEpisodeIndex = currentPage * itemsPerPage;
  const firstEpisodeIndex = lastEpisodeIndex - itemsPerPage;
  let currentEpisodes = episodes?.slice(firstEpisodeIndex, lastEpisodeIndex);

  const totalPages = Math.ceil(episodes.length / itemsPerPage);

  const handleChange = (event) => {
    setProviderId(event.target.value);
  };

  const handlePageChange = (pageNumber) => {
    setCurrentPage(pageNumber);
  };

  useEffect(() => {
    if (
      !currentEpisodes ||
      currentEpisodes?.every(
        (item) =>
          item?.img?.includes("https://s4.anilist.co/") ||
          item?.image?.includes("https://s4.anilist.co/") ||
          item?.img === null
      )
    ) {
      setView(3);
    }
  }, [providerId, episodes]);

  useEffect(() => {
    // Always set a watch URL using megaplay, regardless of provider data
    const startEpisode = info?.nextAiringEpisode
      ? Math.max(1, (progress || 0) + 1)
      : 1;

    if (episodes && episodes.length > 0) {
      const getEpi = info?.nextAiringEpisode
        ? episodes.find((i) => i.number === (progress || 0) + 1) || episodes[0]
        : episodes[0];

      if (getEpi) {
        const watchUrl = `/en/anime/watch/${
          info.id
        }/${providerId}?id=${encodeURIComponent(getEpi.id)}&num=${
          getEpi.number
        }${isDub ? `&dub=${isDub}` : ""}`;
        setWatch(watchUrl);
        return;
      }
    }

    // Fallback: use megaplay directly with episode 1 (or next unwatched)
    setWatch(buildMegaplayUrl(info.id, startEpisode, isDub));
  }, [episodes, providerId]);

  useEffect(() => {
    if (artStorage) {
      const currentData =
        JSON.parse(localStorage.getItem("artplayer_settings")) || {};
      const updatedData = {};

      for (const key in currentData) {
        const item = currentData[key];
        if (Number(item.aniId) === info.id && item.provider === providerId) {
          updatedData[key] = item;
        }
      }

      if (!session?.user?.name) {
        const maxWatchedEpisode = Object.keys(updatedData).reduce(
          (maxEpisode, key) => {
            const episodeData = updatedData[key];
            if (episodeData.timeWatched >= episodeData.duration * 0.9) {
              return Math.max(maxEpisode, episodeData.episode);
            }
            return maxEpisode;
          },
          0
        );
        setProgress(maxWatchedEpisode);
      }
    }
  }, [providerId, artStorage, info.id, session?.user?.name]);

  let debounceTimeout;

  const handleRefresh = async () => {
    try {
      setLoading(true);
      clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(async () => {
        const providers = await fetchEpisodes(info, isDub, true);
        setDefaultProvider(providers, setProviderId);
        setView(Number(localStorage.getItem("view")) || DEFAULT_VIEW);
        setArtStorage(JSON.parse(localStorage.getItem("artplayer_settings")));
        setProviders(providers);
        setLoading(false);
      }, 5000);
    } catch (err) {
      console.log(err);
      toast.error("Something went wrong");
    }
  };

  // Build a simple episode list from total episodes if providers return nothing
  const fallbackEpisodes = !loading && (!episodes || episodes.length === 0)
    ? Array.from({ length: info?.episodes || 0 }, (_, i) => ({
        id: `megaplay-${info.id}-${i + 1}`,
        number: i + 1,
        title: `Episode ${i + 1}`,
        img: null,
        description: null,
      }))
    : null;

  const displayEpisodes = episodes?.length > 0 ? episodes : fallbackEpisodes || [];
  const displayCurrentEpisodes = displayEpisodes.slice(firstEpisodeIndex, lastEpisodeIndex);
  const displayTotalPages = Math.ceil(displayEpisodes.length / itemsPerPage);

  return (
    <>
      <div className="flex flex-col gap-5 px-3">
        <div className="flex lg:flex-row flex-col gap-5 lg:gap-0 justify-between">
          <div className="flex justify-between">
            <div className="flex items-center gap-4 md:gap-5">
              {info && (
                <h1 className="text-[20px] lg:text-2xl font-bold font-karla">
                  Episodes
                </h1>
              )}
              {info?.status !== "NOT_YET_RELEASED" && (
                <button
                  type="button"
                  onClick={() => {
                    handleRefresh();
                    setProviders(null);
                  }}
                  className="relative flex flex-col items-center w-5 h-5 group"
                >
                  <span className="absolute pointer-events-none z-40 opacity-0 -translate-y-8 group-hover:-translate-y-10 group-hover:opacity-100 font-karla shadow-tersier shadow-md whitespace-nowrap bg-secondary px-2 py-1 rounded transition-all duration-200 ease-out">
                    Refresh Episodes
                  </span>
                  <svg
                    fill="currentColor"
                    viewBox="0 0 20 20"
                    xmlns="http://www.w3.org/2000/svg"
                    aria-hidden="true"
                  >
                    <path
                      clipRule="evenodd"
                      fillRule="evenodd"
                      d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z"
                    />
                  </svg>
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <div
                onClick={() => setIsDub((prev) => !prev)}
                className="flex lg:hidden flex-col items-center relative rounded-md bg-secondary py-1.5 px-3 font-karla text-sm hover:ring-1 ring-action cursor-pointer group"
              >
                {isDub ? "Dub" : "Sub"}
                <span className="absolute pointer-events-none z-40 opacity-0 -translate-y-8 group-hover:-translate-y-10 group-hover:opacity-100 font-karla shadow-tersier shadow-md whitespace-nowrap bg-secondary px-2 py-1 rounded transition-all duration-200 ease-out">
                  Switch to {isDub ? "Sub" : "Dub"}
                </span>
              </div>
              <div
                className="lg:hidden bg-secondary p-1 rounded-md cursor-pointer"
                onClick={() => setVisible(!visible)}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  className="w-6 h-6"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M6.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0zM12.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0zM18.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0z"
                  />
                </svg>
              </div>
            </div>
          </div>

          <div
            className={`flex lg:flex gap-3 items-center justify-between ${
              visible ? "" : "hidden"
            }`}
          >
            {providers && (
              <div
                onClick={() => setIsDub((prev) => !prev)}
                className="hidden lg:flex flex-col items-center relative rounded-[3px] bg-secondary py-1 px-3 font-karla text-sm hover:ring-1 ring-action cursor-pointer group"
              >
                {isDub ? "Dub" : "Sub"}
                <span className="absolute pointer-events-none z-40 opacity-0 -translate-y-8 group-hover:-translate-y-10 group-hover:opacity-100 font-karla shadow-tersier shadow-md whitespace-nowrap bg-secondary px-2 py-1 rounded transition-all duration-200 ease-out">
                  Switch to {isDub ? "Sub" : "Dub"}
                </span>
              </div>
            )}

            {providers && providers.length > 0 && (
              <div className="flex gap-3">
                <div className="relative flex gap-2 items-center group">
                  <select
                    title="Providers"
                    onChange={handleChange}
                    value={providerId}
                    className="flex items-center text-sm gap-5 rounded-[3px] bg-secondary py-1 px-3 pr-8 font-karla appearance-none cursor-pointer outline-none focus:ring-1 focus:ring-action group-hover:ring-1 group-hover:ring-action"
                  >
                    {providers.map((provider) => (
                      <option key={provider.providerId} value={provider.providerId}>
                        {provider.providerId}
                      </option>
                    ))}
                  </select>
                  <ChevronDownIcon className="absolute right-2 top-1/2 transform -translate-y-1/2 w-5 h-5 pointer-events-none" />
                </div>

                {displayTotalPages > 1 && (
                  <div className="relative flex gap-2 items-center">
                    <select
                      title="Pages"
                      onChange={(e) => handlePageChange(Number(e.target.value))}
                      className="flex items-center text-sm gap-5 rounded-[3px] bg-secondary py-1 px-3 pr-8 font-karla appearance-none cursor-pointer outline-none focus:ring-1 focus:ring-action hover:ring-1 hover:ring-action"
                    >
                      {[...Array(displayTotalPages)].map((_, i) => (
                        <option key={i} value={i + 1}>
                          {i + 1}
                        </option>
                      ))}
                    </select>
                    <ChevronDownIcon className="absolute right-2 top-1/2 transform -translate-y-1/2 w-5 h-5 pointer-events-none" />
                  </div>
                )}
              </div>
            )}

            <ViewSelector
              view={view}
              setView={setView}
              episode={displayCurrentEpisodes}
            />
          </div>
        </div>

        {/* Episodes */}
        {!loading ? (
          <div
            className={`${
              view === 1
                ? "grid md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-5 lg:gap-8 place-items-center"
                : view === 2
                ? "flex flex-col gap-3"
                : `flex flex-col odd:bg-secondary even:bg-primary`
            } py-2`}
          >
            {displayEpisodes.length > 0 ? (
              displayCurrentEpisodes.map((episode, index) => (
                <Fragment key={index}>
                  {view === 1 && (
                    <ThumbnailOnly
                      index={index}
                      info={info}
                      providerId={providerId || "gogoanime"}
                      episode={episode}
                      artStorage={artStorage}
                      progress={progress}
                      dub={isDub}
                    />
                  )}
                  {view === 2 && (
                    <ThumbnailDetail
                      index={index}
                      epi={episode}
                      provider={providerId || "gogoanime"}
                      info={info}
                      artStorage={artStorage}
                      progress={progress}
                      dub={isDub}
                    />
                  )}
                  {view === 3 && (
                    <ListMode
                      info={info}
                      episode={episode}
                      artStorage={artStorage}
                      providerId={providerId || "gogoanime"}
                      progress={progress}
                      dub={isDub}
                    />
                  )}
                </Fragment>
              ))
            ) : (
              <div className="h-[20vh] lg:w-full flex-center flex-col gap-5">
                <p className="text-center font-karla font-bold lg:text-lg">
                  Oops!<br />It looks like this anime is not available.
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="flex justify-center">
            <div className="lds-ellipsis">
              <div></div>
              <div></div>
              <div></div>
              <div></div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}