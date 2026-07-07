import Link from "next/link";
import React, { useState, useRef, useEffect, Fragment } from "react";
import Image from "next/image";
import { MdChevronRight } from "react-icons/md";
import {
  ChevronRightIcon,
  ArrowRightCircleIcon,
} from "@heroicons/react/24/outline";

import { ChevronLeftIcon } from "@heroicons/react/20/solid";
import { ExclamationCircleIcon, PlayIcon } from "@heroicons/react/24/solid";
import { useRouter } from "next/router";
import HistoryOptions from "./content/historyOptions";
import { notify } from "@/lib/notifications/noticeStore";
import { truncateImgUrl } from "@/utils/imageUtils";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { animeHref, useClickTarget } from "@/lib/prefs/clickTarget";
import { useTranslation } from "react-i18next";
import { sectionLabel } from "@/lib/i18n/sectionLabel";

type ContentProps = {
  ids: string;
  section: string;
  data?: any;
  userData?: UserDataTypes[];
  og?: any;
  userName?: string;
  setRemoved?: any;
  type?: string;
};

type UserDataTypes = {
  id: string;
  aniId?: string;
  title?: string;
  aniTitle?: string;
  image?: string;
  cover?: string;
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
};

interface SlicedDataTypes {
  id: string | number;
  slug?: string;
  nextAiringEpisode?: any;
  currentEpisode?: number;
  idMal: number;
  status: string;
  title: Title;
  bannerImage: string;
  coverImage: CoverImage | string;
  image?: string;
  episodeNumber?: number;
  description: string;
}

interface Title {
  romaji: string;
  english: string;
  native: string;
}

interface CoverImage {
  extraLarge: string;
  large: string;
  medium: string;
  color?: string;
}

export default function Content({
  ids,
  section,
  data,
  userData,
  og,
  userName,
  setRemoved,
  type = "anime",
}: ContentProps) {
  const titlePref = useTitlePref();
  const clickTarget = useClickTarget();
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null!);

  // Native drag-to-scroll. We rolled our own (instead of
  // react-use-draggable-scroll, which scrolled in jerky steps and let
  // text/images get selected mid-drag). On mousedown we attach mousemove/
  // mouseup listeners to `document` so the drag keeps tracking even when the
  // cursor leaves the track, and we set scrollLeft directly so the content
  // follows the pointer pixel-for-pixel. The dependency-free approach (no
  // pointer capture, no per-pixel React state) avoids the re-render churn
  // that made the previous version stutter.
  const DRAG_THRESHOLD = 8;
  // True between a real drag and the click it produces, so we can swallow
  // that one click (otherwise the drag would also navigate).
  const dragMovedRef = useRef(false);
  // True while a touch interaction is in flight (and briefly after). Touch
  // scrolling makes the browser synthesize mousedown/mousemove/mouseup, which
  // used to arm dragMovedRef and get the following tap swallowed by
  // onClickCapture — cards became untappable on mobile. We gate the mouse
  // drag logic off whenever a touch is/was just active.
  const touchActiveRef = useRef(false);

  // Attach the drag-to-scroll listeners imperatively in an effect. Doing it
  // on the real DOM node (rather than React synthetic handlers) lets us bind
  // mousemove as a NON-passive listener so preventDefault actually works, and
  // guarantees we operate on the same element we set scrollLeft on.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let isDown = false;
    let startX = 0;
    let startScroll = 0;
    let touchReleaseTimer: ReturnType<typeof setTimeout> | undefined;

    // Touch is handled by native overflow scrolling; flag it so the mouse
    // drag handlers ignore the synthetic mouse events touch emits.
    const onTouchStart = () => {
      touchActiveRef.current = true;
      if (touchReleaseTimer) clearTimeout(touchReleaseTimer);
    };
    const onTouchEnd = () => {
      // Keep the flag up briefly: the synthetic mouse* + click burst fires
      // just after touchend, and we want all of it ignored.
      if (touchReleaseTimer) clearTimeout(touchReleaseTimer);
      touchReleaseTimer = setTimeout(() => {
        touchActiveRef.current = false;
      }, 500);
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (touchActiveRef.current) return; // synthetic mouse from touch — ignore
      isDown = true;
      startX = e.pageX;
      startScroll = el.scrollLeft;
      dragMovedRef.current = false;
      // Stop the browser starting a native link/image drag, which would
      // swallow the mousemove stream and make the carousel jump a whole
      // card on release instead of scrolling.
      e.preventDefault();
    };
    const onMove = (e: MouseEvent) => {
      if (!isDown) return;
      e.preventDefault();
      const dx = e.pageX - startX;
      if (Math.abs(dx) > DRAG_THRESHOLD) dragMovedRef.current = true;
      el.scrollLeft = startScroll - dx;
    };
    const onUp = () => {
      isDown = false;
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove, { passive: false });
    window.addEventListener("mouseup", onUp);
    return () => {
      if (touchReleaseTimer) clearTimeout(touchReleaseTimer);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const onClickCapture = (e: React.MouseEvent) => {
    // Never swallow a tap: touch scrolling is native and must always navigate.
    if (touchActiveRef.current) return;
    if (dragMovedRef.current) {
      e.preventDefault();
      e.stopPropagation();
      // Reset right after — a follow-up click on the same card should fire.
      dragMovedRef.current = false;
    }
  };

  const router = useRouter();

  const [clicked, setClicked] = useState(false);

  useEffect(() => {
    const click = localStorage.getItem("clicked");

    if (click) {
      setClicked(JSON.parse(click));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [scrollLeft, setScrollLeft] = useState(false);
  const [scrollRight, setScrollRight] = useState(true);

  const slideLeft = () => {
    if (ref.current) {
      ref.current.classList.add("scroll-smooth");
      var slider = document.getElementById(ids);
      if (slider?.scrollLeft) {
        slider.scrollLeft = slider.scrollLeft - 500;
      }
      ref.current.classList.remove("scroll-smooth");
    }
  };
  const slideRight = () => {
    if (ref.current) {
      ref.current.classList.add("scroll-smooth");
      var slider = document.getElementById(ids);
      if (slider?.scrollLeft) {
        slider.scrollLeft = slider.scrollLeft + 500;
      }
      ref.current.classList.remove("scroll-smooth");
    }
  };

  const handleScroll = (e: any) => {
    const scrollLeft = e.target.scrollLeft > 31;
    const scrollRight =
      e.target.scrollLeft < e.target.scrollWidth - e.target.clientWidth;
    setScrollLeft(scrollLeft);
    setScrollRight(scrollRight);
  };

  function handleAlert(e: string) {
    if (localStorage.getItem("clicked")) {
      const existingDataString = localStorage.getItem("clicked");
      const existingData = existingDataString
        ? JSON.parse(existingDataString)
        : {};

      existingData[e] = true;

      const updatedDataString = JSON.stringify(existingData);

      localStorage.setItem("clicked", updatedDataString);
    } else {
      const newData = {
        [e]: true,
      };

      const newDataString = JSON.stringify(newData);

      localStorage.setItem("clicked", newDataString);
    }
  }

  const array = data;
  // Drop nulls AND de-duplicate by id — some sources (AniList recommendations
  // especially) return the same anime twice, which rendered as duplicate cards
  // and triggered React duplicate-key warnings.
  const dedupeSeen = new Set<any>();
  let filteredData = array?.filter((item: any) => {
    if (item == null) return false;
    const id = item.id ?? item.aniId ?? item.watchId;
    if (id != null) {
      if (dedupeSeen.has(id)) return false;
      dedupeSeen.add(id);
    }
    return true;
  });
  const slicedData: SlicedDataTypes[] =
    filteredData?.length > 15 ? filteredData?.slice(0, 15) : filteredData;

  const goToPage = () => {
    if (section === "Recently Watched") {
      router.push(`/en/anime/recently-watched`);
    }
    if (section === "New Episodes") {
      router.push(`/en/anime/recent`);
    }
    if (section === "Trending Now") {
      router.push(`/en/anime/trending`);
    }
    if (section === "Popular Anime") {
      router.push(`/en/anime/popular`);
    }
    if (section === "This Season") {
      router.push(`/en/search/anime?sort=POPULARITY_DESC&season=current`);
    }
    if (section === "Popular Movies") {
      router.push(`/en/search/anime?sort=POPULARITY_DESC&format=MOVIE`);
    }
    if (section === "Your Plan") {
      router.push(`/en/profile/${userName}/#planning`);
    }
    if (section === "On-Going Anime" || section === "Your Watch List") {
      router.push(`/en/profile/${userName}/#current`);
    }
  };

  const removeItem = async (id: string, aniId: string) => {
    if (userName) {
      // remove from database
      const res = await fetch(`/api/user/update/episode`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: userName,
          id,
          aniId,
        }),
      });
      const data = await res.json();

      if (id) {
        // remove from local storage
        const artplayerSettings =
          JSON.parse(localStorage.getItem("artplayer_settings") || "{}") || {};
        if (artplayerSettings[id]) {
          delete artplayerSettings[id];
          localStorage.setItem(
            "artplayer_settings",
            JSON.stringify(artplayerSettings)
          );
        }
      }
      if (aniId) {
        const currentData =
          JSON.parse(localStorage.getItem("artplayer_settings") || "{}") || {};

        const updatedData: { [key: string]: any } = {};

        for (const key in currentData) {
          const item = currentData[key];
          if (item.aniId !== aniId) {
            updatedData[key] = item;
          }
        }

        localStorage.setItem("artplayer_settings", JSON.stringify(updatedData));
      }

      // update client
      setRemoved(id || aniId);

      if (data?.message === "Episode deleted") {
        notify.success(t("home.episodeRemoved"));
      }
    } else {
      if (id) {
        // remove from local storage
        const artplayerSettings =
          JSON.parse(localStorage.getItem("artplayer_settings") || "{}") || {};
        if (artplayerSettings[id]) {
          delete artplayerSettings[id];
          localStorage.setItem(
            "artplayer_settings",
            JSON.stringify(artplayerSettings)
          );
        }
        setRemoved(id);
      }
      if (aniId) {
        const currentData =
          JSON.parse(localStorage.getItem("artplayer_settings") || "{}") || {};

        // Create a new object to store the updated data
        const updatedData: { [key: string]: any } = {};

        // Iterate through the current data and copy items with different aniId to the updated object
        for (const key in currentData) {
          const item = currentData[key];
          if (item.aniId !== aniId) {
            updatedData[key] = item;
          }
        }

        // Update localStorage with the filtered data
        localStorage.setItem("artplayer_settings", JSON.stringify(updatedData));
        setRemoved(aniId);
      }
    }
  };

  // Don't render anything for an empty Recently Watched section — the
  // user has watched nothing on this device yet, no point showing a
  // header + empty carousel.
  if (
    ids === "recentlyWatched" &&
    (!userData ||
      userData.length === 0 ||
      !userData.some((i: any) => i?.watchId || i?.aniId))
  ) {
    return null;
  }

  return (
    <div>
      <div
        className={`flex items-center justify-between lg:justify-normal lg:gap-3 px-5 z-40 ${
          section === "Recommendations" ? "" : "cursor-pointer"
        }`}
        onClick={goToPage}
      >
        <h1 className="font-karla text-[20px] font-bold">{sectionLabel(t, section)}</h1>
        <ChevronRightIcon className="w-5 h-5" />
      </div>
      <div className="relative flex items-center lg:gap-2">
        <div
          onClick={slideLeft}
          className={`flex items-center mb-5 cursor-pointer hover:text-action absolute left-0 bg-gradient-to-r from-[#0c0d10] z-40 h-full hover:opacity-100 ${
            scrollLeft ? "lg:visible" : "invisible"
          }`}
        >
          <ChevronLeftIcon className="w-7 h-7 stroke-2" />
        </div>
        <div
          id={ids}
          className="flex h-full w-full select-none overflow-x-scroll overflow-y-hidden scrollbar-hide lg:gap-8 gap-4 lg:p-10 py-8 px-5 z-30 lg:cursor-grab lg:active:cursor-grabbing"
          onScroll={handleScroll}
          onClickCapture={onClickCapture}
          ref={ref}
        >
          {ids !== "recentlyWatched"
            ? slicedData?.map((anime) => {
                const progress = og?.find((i: any) => i.mediaId === anime.id);

                let image;
                if (typeof anime.coverImage === "string") {
                  image = truncateImgUrl(anime.coverImage);
                } else if (anime.coverImage) {
                  image = anime.coverImage.extraLarge || anime.coverImage.large;
                }

                if (!image && anime.image) {
                  image = anime.image;
                }

                return (
                  <div
                    key={anime.id}
                    className="flex flex-col gap-3 shrink-0 cursor-pointer"
                  >
                    <Link
                      href={
                        ids === "listManga"
                          ? `/en/manga/${anime.id}`
                          : ids === "recentAdded"
                          ? anime?.slug
                            ? `/en/anime/watch/${
                                anime.id
                              }/gogoanime?id=${encodeURIComponent(
                                anime?.slug?.replace('/', '')
                              )}&num=${anime.currentEpisode}`
                            : `/en/${type}/${anime.id}`
                          : type.toLowerCase() === "anime"
                          ? animeHref(anime.id, clickTarget)
                          : `/en/${type}/${anime.id}`
                      }
                      className="hover:scale-105 hover:shadow-lg duration-300 ease-out group relative"
                      draggable={false}
                      onDragStart={(e) => e.preventDefault()}
                    >
                      {ids === "onGoing" && (
                        <div className="h-[190px] lg:h-[265px] w-[135px] lg:w-[185px] bg-gradient-to-b from-transparent to-black/90 absolute z-40 rounded-md whitespace-normal font-karla group">
                          <div className="flex flex-col items-center h-full justify-end text-center pb-5">
                            <h1 className="line-clamp-1 w-[70%] text-[10px]">
                              {pickTitle(anime.title, titlePref)}
                            </h1>
                            {checkProgress(progress) &&
                              !clicked?.hasOwnProperty(anime.id) && (
                                <ExclamationCircleIcon className="w-7 h-7 absolute z-40 text-white -top-3 -right-3" />
                              )}
                            {checkProgress(progress) && (
                              <div
                                onClick={() => handleAlert(String(anime.id))}
                                className="group-hover:visible invisible absolute top-0 bg-black bg-opacity-20 w-full h-full z-20 text-center"
                              >
                                <h1 className="text-[12px] lg:text-sm pt-28 lg:pt-44 font-bold opacity-100">
                                  {checkProgress(progress)}
                                </h1>
                              </div>
                            )}
                            {anime.nextAiringEpisode && (
                              <div className="flex gap-1 text-[13px] lg:text-base">
                                <h1>
                                  Episode {anime.nextAiringEpisode.episode} in
                                </h1>
                                <h1 className="font-bold">
                                  {convertSecondsToTime(
                                    anime?.nextAiringEpisode?.timeUntilAiring
                                  )}
                                </h1>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                      <div className="h-[190px] w-[135px] lg:h-[265px] lg:w-[185px] rounded-md z-30">
                        {ids === "recentAdded" && (
                          <div className="absolute bg-gradient-to-b from-black/30 to-transparent from-5% to-30% top-0 z-30 w-full h-full rounded" />
                        )}
                        {image && (
                          <Image
                            draggable={false}
                            src={image}
                            alt={pickTitle(anime.title, titlePref)}
                            width={500}
                            height={300}
                            className="z-20 h-[190px] w-[135px] lg:h-[265px] lg:w-[185px] object-cover rounded-md brightness-90"
                          />
                        )}
                      </div>
                      {ids === "recentAdded" && (
                        <Fragment>
                          <Image
                            src="/svg/episode-badge.svg"
                            alt="episode-badge"
                            width={200}
                            height={100}
                            className="w-24 lg:w-32 absolute top-1 -right-[12px] lg:-right-[17px] z-40"
                          />
                          <p className="absolute z-40 text-center w-[86px] lg:w-[110px] top-1 -right-2 lg:top-[5.5px] lg:-right-2 font-karla text-sm lg:text-base">
                            Episode{" "}
                            <span className="text-white">
                              {anime?.currentEpisode || anime?.episodeNumber}
                            </span>
                          </p>
                        </Fragment>
                      )}
                    </Link>
                    {ids !== "onGoing" && (
                      <Link
                        href={
                          ids === "listManga"
                            ? `/en/manga/${anime.id}`
                            : type.toLowerCase() === "anime"
                            ? animeHref(anime.id, clickTarget)
                            : `/en/${type.toLowerCase()}/${anime.id}`
                        }
                        className="w-[135px] lg:w-[185px] line-clamp-2"
                        draggable={false}
                        onDragStart={(e) => e.preventDefault()}
                      >
                        <h1 className="font-karla font-semibold xl:text-base text-[15px]">
                          {anime.status === "RELEASING" ||
                          ids === "recentAdded" ? (
                            <span className="dots bg-green-500" />
                          ) : anime.status === "NOT_YET_RELEASED" ? (
                            <span className="dots bg-red-500" />
                          ) : null}
                          {pickTitle(anime.title, titlePref)}
                        </h1>
                      </Link>
                    )}
                  </div>
                );
              })
            : (() => {
                const seenAniIds = new Set<string>();
                const seenTitles = new Set<string>();
                return userData
                  ?.filter((i) => {
                    if (i.aniId) {
                      const key = String(i.aniId);
                      if (seenAniIds.has(key)) return false;
                      seenAniIds.add(key);
                      return true;
                    }
                    const titleKey = String(i.aniTitle || "").toLowerCase().trim();
                    if (!titleKey || seenTitles.has(titleKey)) return false;
                    seenTitles.add(titleKey);
                    return true;
                  })
                  ?.slice(0, 10)
                  .map((i) => {
                  const time = i.timeWatched;
                  const duration = i.duration;
                  let prog = time && duration ? (time / duration) * 100 : 0;
                  if (prog > 90) prog = 100;

                  // Landscape card. Prefer the episode thumbnail (16:9). If
                  // there's none, use the portrait cover — which, with
                  // object-cover, still fills the whole 16:9 box (cropped)
                  // rather than leaving a black band like a wide banner does.
                  const cardImage = i.image || i.cover;

                  return (
                    <div
                      key={i.watchId}
                      className="flex flex-col gap-2 shrink-0 cursor-pointer relative group/item"
                    >
                      <div className="absolute flex flex-col gap-1 z-40 top-1 right-1 transition-all duration-200 ease-out opacity-0 group-hover/item:opacity-100 scale-90 group-hover/item:scale-100 group-hover/item:visible invisible ">
                        <HistoryOptions
                          remove={removeItem}
                          watchId={i.watchId}
                          aniId={i.aniId}
                        />
                        {i?.nextId && (
                          <button
                            type="button"
                            className="flex flex-col items-center group/next relative"
                            onClick={() => {
                              router.push(
                                `/en/anime/watch/${i.aniId}/${
                                  i.provider
                                }?id=${encodeURIComponent(
                                  i?.nextId || ""
                                )}&num=${i?.nextNumber}${
                                  i?.dub ? `&dub=${i?.dub}` : ""
                                }`
                              );
                            }}
                          >
                            <ChevronRightIcon className="w-6 h-6 shrink-0 bg-primary p-1 rounded-full hover:text-action scale-100 hover:scale-105 transition-all duration-200 ease-out" />
                            <span className="absolute font-karla bg-secondary shadow-black shadow-2xl py-1 px-2 whitespace-nowrap text-white text-sm rounded-md right-7 -bottom-[2px] z-40 duration-300 transition-all ease-out group-hover/next:visible group-hover/next:scale-100 group-hover/next:translate-x-0 group-hover/next:opacity-100 opacity-0 translate-x-10 scale-50 invisible">
                              {t("home.playNext")}
                            </span>
                          </button>
                        )}
                      </div>
                      <Link
                        className="relative w-[320px] aspect-video rounded-md overflow-hidden group bg-secondary"
                        href={`/en/anime/watch/${i.aniId}/${
                          i.provider
                        }?id=${encodeURIComponent(i.watchId)}&num=${i.episode}${
                          i?.dub ? `&dub=${i?.dub}` : ""
                        }`}
                        draggable={false}
                        onDragStart={(e) => e.preventDefault()}
                      >
                        <div className="w-full h-full bg-gradient-to-t from-black/70 from-20% to-transparent group-hover:to-black/40 transition-all duration-300 ease-out absolute z-30" />
                        <div className="absolute bottom-3 left-0 mx-2 text-white flex gap-2 items-center w-[80%] z-30">
                          <PlayIcon className="w-5 h-5 shrink-0" />
                          <h1
                            className="font-semibold font-karla line-clamp-1"
                            title={i?.title || i?.aniTitle}
                          >
                            {i?.title === i.aniTitle
                              ? `Episode ${i.episode}`
                              : i?.title || i?.aniTitle}
                          </h1>
                        </div>
                        <span
                          className={`absolute bottom-0 left-0 h-[2px] bg-red-600 z-30`}
                          style={{
                            width: `${prog}%`,
                          }}
                        />

                        {cardImage && (
                          <Image
                            src={cardImage}
                            width={320}
                            height={180}
                            alt="Episode Thumbnail"
                            // h-full + object-cover so the image fills the
                            // whole 16:9 card regardless of the source ratio
                            // (thumbnail OR cover) — no black band.
                            className="absolute inset-0 h-full w-full object-cover group-hover:scale-[1.02] duration-300 ease-out z-10"
                          />
                        )}
                      </Link>

                      <Link
                        className="flex flex-col font-karla w-full"
                        href={`/en/anime/watch/${i.aniId}/${
                          i.provider
                        }?id=${encodeURIComponent(i.watchId)}&num=${i.episode}`}
                        draggable={false}
                        onDragStart={(e) => e.preventDefault()}
                      >
                        <p className="flex items-center gap-1 text-sm text-gray-400 w-[320px]">
                          <span
                            className="text-white"
                            style={{
                              display: "inline-block",
                              maxWidth: "220px",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={i.aniTitle}
                          >
                            {i.aniTitle}
                          </span>{" "}
                          | {t("common.episode")} {i.episode}
                        </p>
                      </Link>
                    </div>
                  );
                })
              })()}
          {userData &&
            userData?.filter((i) => i.aniId !== null)?.length >= 10 &&
            section !== "Recommendations" && (
              <div
                key={section}
                className="flex flex-col cursor-pointer"
                onClick={goToPage}
              >
                <div className="w-[320px] aspect-video overflow-hidden object-cover rounded-md border-secondary border-2 flex flex-col gap-2 items-center text-center justify-center text-[#6a6a6a] hover:text-[#9f9f9f] hover:border-[#757575] transition-colors duration-200">
                  <h1 className="whitespace-pre-wrap text-sm">
                    {t("home.moreOn", { section: sectionLabel(t, section) })}
                  </h1>
                  <ArrowRightCircleIcon className="w-5 h-5" />
                </div>
              </div>
            )}
          {filteredData?.length >= 10 && section !== "Recommendations" && (
            <div
              key={section}
              className="flex cursor-pointer"
              onClick={goToPage}
            >
              <div className="h-[190px] w-[135px] lg:h-[265px] lg:w-[185px] object-cover rounded-md border-secondary border-2 flex flex-col gap-2 items-center text-center justify-center text-[#6a6a6a] hover:text-[#9f9f9f] hover:border-[#757575] transition-colors duration-200">
                <h1 className="whitespace-pre-wrap text-sm">
                  {t("home.moreOn", { section: sectionLabel(t, section) })}
                </h1>
                <ArrowRightCircleIcon className="w-5 h-5" />
              </div>
            </div>
          )}
        </div>
        <MdChevronRight
          onClick={slideRight}
          size={30}
          className={`hidden md:block mb-5 cursor-pointer hover:text-action absolute right-0 bg-gradient-to-l from-[#0c0d10] z-40 h-full hover:opacity-100 hover:bg-gradient-to-l ${
            scrollRight ? "visible" : "hidden"
          }`}
        />
      </div>
    </div>
  );
}

function convertSecondsToTime(sec: number) {
  let days = Math.floor(sec / (3600 * 24));
  let hours = Math.floor((sec % (3600 * 24)) / 3600);
  let minutes = Math.floor((sec % 3600) / 60);

  let time = "";

  if (days > 0) {
    time += `${days}d `;
    time += `${hours}h`;
  } else {
    time += `${hours}h `;
    time += `${minutes}m`;
  }

  return time.trim();
}

function checkProgress(entry: { progress: any; media: any }) {
  const { progress, media } = entry;
  const { episodes, nextAiringEpisode } = media;

  if (nextAiringEpisode !== null) {
    const { episode } = nextAiringEpisode;

    if (episode - progress > 1) {
      const missedEpisodes = episode - progress - 1;
      return `${missedEpisodes} episode${missedEpisodes > 1 ? "s" : ""} behind`;
    }
  }

  return;
}
