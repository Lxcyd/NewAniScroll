import { ReactNode, useEffect, useState } from "react";
import { useAniList } from "../../../lib/anilist/useAnilist";
import Skeleton from "react-loading-skeleton";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import { SessionTypes } from "pages/en";
import Link from "next/link";
import Image from "next/image";
import { StarIcon, ChevronDownIcon } from "@heroicons/react/24/solid";
import { useTranslation } from "react-i18next";
import { statusLabel } from "@/components/anime/v2/helpers";
import { genreLabel } from "@/lib/i18n/genreLabel";
import { useTranslatedText } from "@/lib/i18n/useTranslatedText";

type DetailsProps = {
  info: AniListInfoTypes;
  session: SessionTypes;
  epiNumber: number;
  description: string;
  id: string;
  onList: boolean;
  setOnList: (value: boolean) => void;
  handleOpen: () => void;
  /** Title shown at the top of the card — the page owns it because it also
   *  knows the episode being played. */
  title?: ReactNode;
  /** Secondary action buttons (party / share / report) rendered under the
   *  add-to-list CTA. The page keeps their handlers; we only place them. */
  actions?: ReactNode;
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
  title,
  actions,
}: DetailsProps) {
  const { markPlanning } = useAniList(session);
  const { t } = useTranslation();

  const [showDesc, setShowDesc] = useState(false);

  // Auto-translate the synopsis into the active UI language (server-cached).
  const localizedDesc = useTranslatedText(description);
  const truncatedDesc = truncateText(localizedDesc, 420);

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

  // "#278" — AniList's all-time RATED position. Only shown when AniList
  // actually ranks the entry; a computed rank would be a fabrication.
  const rank = info?.rankings?.find(
    (r: any) => r.type === "RATED" && r.allTime,
  )?.rank;
  const score = info?.averageScore ? (info.averageScore / 10).toFixed(2) : null;
  const studio = info?.studios?.edges?.[0]?.node?.name;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-5 sm:flex-row">
        <div className="shrink-0">
          {info ? (
            <Link href={`/en/anime/${info.id}`}>
              <Image
                src={info.coverImage.extraLarge}
                alt="Anime Cover"
                width={1000}
                height={1000}
                className="aspect-[9/13] h-[190px] rounded-poster object-cover shadow-poster duration-300 ease-out hover:scale-[1.03]"
              />
            </Link>
          ) : (
            <Skeleton height={190} width={132} />
          )}
        </div>

        <div className="flex min-w-0 grow flex-col gap-3">
          {title}

          {/* Stats line — score · rank · popularity · run length · status. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-karla text-sm text-white/60">
            {score && (
              <span className="flex items-center gap-1">
                <StarIcon className="h-4 w-4 text-as-score" />
                <span className="font-semibold text-white">{score}</span>
                <span className="text-xs text-white/35">/10</span>
                {rank && <span className="text-xs text-white/35">· #{rank}</span>}
              </span>
            )}
            {info?.popularity != null && (
              <span className="flex items-center gap-1 border-l border-white/10 pl-3">
                <ChevronDownIcon className="h-3.5 w-3.5 text-as-accent" />
                <span className="tabular-nums">
                  {info.popularity.toLocaleString()}
                </span>
              </span>
            )}
            <span className="flex flex-wrap items-center gap-x-1.5 border-l border-white/10 pl-3 text-xs">
              {info?.episodes && (
                <span>
                  {info.episodes} {t("anime.formatEpisodes").toLowerCase()}
                </span>
              )}
              {info?.duration && <span>· {t("home.minutesShort", { count: info.duration })}</span>}
              {info?.status && <span>· {statusLabel(t, info.status)}</span>}
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            {studio && (
              <span className="rounded-md bg-white/[0.05] px-2 py-1 font-karla text-xs text-white/60 ring-1 ring-white/[0.07]">
                {studio}
              </span>
            )}
            {info?.genres?.map((item, index) => (
              <span
                key={index}
                className="rounded-md border border-action/70 px-2 py-1 font-karla text-xs text-gray-100"
              >
                {genreLabel(t, item)}
              </span>
            ))}
          </div>
        </div>

        {/* Action column — the add-to-list CTA is the one thing a viewer is
            here to do besides watching, so it gets the full-width button. */}
        <div className="flex w-full shrink-0 flex-col gap-2 sm:w-[210px]">
          <button
            type="button"
            onClick={() => (session ? handlePlan() : handleOpen())}
            className={`w-full rounded-lg px-4 py-2.5 font-karla text-sm font-semibold transition-colors ${
              onList
                ? "bg-white/[0.06] text-white/70 ring-1 ring-white/10"
                : "bg-action text-white shadow-glow hover:brightness-110"
            }`}
          >
            {onList ? t("anime.inYourList") : `+ ${t("anime.addToList")}`}
          </button>
          {actions}
        </div>
      </div>

      <div className="relative rounded-md bg-secondary">
        {info && (
          <>
            <p
              dangerouslySetInnerHTML={{
                __html: showDesc
                  ? localizedDesc
                  : localizedDesc?.length > 420
                  ? truncatedDesc
                  : localizedDesc
              }}
              className={`p-5 text-sm font-light font-roboto text-[#e4e4e4] `}
            />
            {!showDesc && localizedDesc?.length > 120 && (
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
