import { useEffect, useState } from "react";
import { useAniList } from "../../../lib/anilist/useAnilist";
import Skeleton from "react-loading-skeleton";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import { SessionTypes } from "pages/en";
import Link from "next/link";
import Image from "next/image";
import { useTranslation } from "react-i18next";
import { statusLabel } from "@/components/anime/v2/helpers";

type DetailsProps = {
  info: AniListInfoTypes;
  session: SessionTypes;
  epiNumber: number;
  description: string;
  id: string;
  onList: boolean;
  setOnList: (value: boolean) => void;
  handleOpen: () => void;
};

export default function Details({
  info,
  session,
  epiNumber,
  description,
  id,
  onList,
  setOnList,
  handleOpen,
}: DetailsProps) {
  const { markPlanning } = useAniList(session);
  const { t } = useTranslation();

  const [showDesc, setShowDesc] = useState(false);

  const truncatedDesc = truncateText(description, 420);

  function handlePlan() {
    if (onList === false) {
      markPlanning(info.id);
      setOnList(true);
    }
  }

  useEffect(() => {
    // Reset the "Read more" expansion when the episode changes — keeps
    // the description collapsed on a new entry.
    return () => {
      setShowDesc(false);
    };
  }, [id]);

  return (
    <div className="flex flex-col gap-2">
      {/* <div className="px-4 pt-7 pb-4 h-full flex"> */}
      <div className="pb-4 h-full flex">
        <div className="aspect-[9/13] h-[240px]">
          {info ? (
            <Link
              className="hover:scale-105 hover:shadow-lg duration-300 ease-out"
              href={`/en/anime/${info.id}`}
            >
              <Image
                src={info.coverImage.extraLarge}
                alt="Anime Cover"
                width={1000}
                height={1000}
                className="object-cover aspect-[9/13] h-[240px] rounded-md"
              />
            </Link>
          ) : (
            <Skeleton height={240} />
          )}
        </div>
        <div
          className="grid w-full pl-5 gap-3 h-[240px]"
          data-episode={info?.episodes || "0"}
        >
          <div className="grid grid-cols-2 gap-1 items-center">
            <h2 className="text-sm font-light font-roboto text-[#878787]">
              {t("anime.detailStudios")}
            </h2>
            <div className="row-start-2">
              {info ? (
                /* Some not-yet-aired entries land on AniList without a
                   studio. Guard against an empty `edges` array so we
                   don't crash with "Cannot read 'node' of undefined". */
                info.studios?.edges?.[0]?.node?.name ?? "N/A"
              ) : (
                <Skeleton width={80} />
              )}
            </div>
            <div className="hidden xxs:grid col-start-2 place-content-end relative">
              <div>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  onClick={() => {
                    session ? handlePlan() : handleOpen();
                  }}
                  className={`w-8 h-8 hover:fill-white text-white hover:cursor-pointer ${
                    onList ? "fill-white" : ""
                  }`}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z"
                  />
                </svg>
              </div>
            </div>
          </div>
          <div className="grid gap-1 items-center">
            <h2 className="text-sm font-light font-roboto text-[#878787]">
              {t("anime.detailStatus")}
            </h2>
            <div>{info ? statusLabel(t, info.status) : <Skeleton width={75} />}</div>
          </div>
          <div className="grid gap-1 items-center overflow-y-hidden">
            <h2 className="text-sm font-light font-roboto text-[#878787]">
              {t("anime.titles")}
            </h2>
            <div className="grid grid-flow-dense grid-cols-2 gap-2 h-full w-full">
              {info ? (
                <>
                  <div className="title-rm line-clamp-3">
                    {info.title?.romaji || ""}
                  </div>
                  <div className="title-en line-clamp-3">
                    {info.title?.english || ""}
                  </div>
                  <div className="title-nt line-clamp-3">
                    {info.title?.native || ""}
                  </div>
                </>
              ) : (
                <Skeleton width={200} height={50} />
              )}
            </div>
          </div>
        </div>
      </div>
      {/* <div className="flex flex-wrap gap-3 px-4 pt-3"> */}
      <div className="flex flex-wrap gap-3 pt-3">
        {info &&
          info.genres?.map((item, index) => (
            <div
              key={index}
              className="border border-action text-gray-100 py-1 px-2 rounded-md font-karla text-sm"
            >
              {item}
            </div>
          ))}
      </div>
      {/* <div className={`bg-secondary rounded-md mt-3 mx-3`}> */}
      <div className={`relative bg-secondary rounded-md mt-3`}>
        {info && (
          <>
            <p
              dangerouslySetInnerHTML={{
                __html: showDesc
                  ? description
                  : description?.length > 420
                  ? truncatedDesc
                  : description
              }}
              className={`p-5 text-sm font-light font-roboto text-[#e4e4e4] `}
            />
            {!showDesc && description?.length > 120 && (
              <span
                onClick={() => setShowDesc((prev) => !prev)}
                className="flex justify-center items-end rounded-md pb-5 font-semibold font-karla cursor-pointer w-full h-full bg-gradient-to-t from-secondary hover:from-20% to-transparent absolute inset-0"
              >
                {t("anime.readMore")}
              </span>
            )}
          </>
        )}
      </div>
      {/* Comments removed — Disqus showed a hard-to-debug "moderator" error
          for visitors and added a third-party tracker we don't need. */}
    </div>
  );
}

function truncateText(txt: string, length: number) {
  if (!txt) return "";
  const text = txt.replace(/(<([^>]+)>)/gi, "");
  return text.length > length ? text.slice(0, length) + "..." : text;
}
