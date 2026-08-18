import { ReactNode, useEffect, useState } from "react";
import { useAniList } from "../../../lib/anilist/useAnilist";
import Skeleton from "react-loading-skeleton";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import { SessionTypes } from "pages/en";
import Link from "next/link";
import Image from "next/image";
import { StarIcon, ChevronDownIcon } from "@heroicons/react/24/solid";
import { useTranslation } from "react-i18next";
import { statusLabel, parseDescription } from "@/components/anime/v2/helpers";
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

  // Same treatment as the info page's Overview: strip the "(Source: …)" tail
  // out of the body and show it as an attribution line, rather than leaving
  // it mid-paragraph.
  const parsed = parseDescription(description);
  // Auto-translate the synopsis into the active UI language (server-cached).
  const localizedDesc = useTranslatedText(parsed.text);
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
    // `relative z-10`: the player's ambient glow is a positioned layer that
    // overflows well past the player box. A non-positioned sibling paints
    // UNDER it, which is what veiled the add-to-list button — the glow was
    // literally on top of it. Giving the card its own positioned layer puts
    // the light back where it belongs, behind the controls.
    <div className="relative z-10 flex flex-col gap-4">
      <div className="flex flex-col gap-5 sm:flex-row">
        {/* The box carries the size, not the <Image>. next/image renders an
            <img> with width=1000, so without a sized parent it stretches to
            the row's full width — object-cover then shows a wide band of the
            portrait cover (it reads as a banner) and the blown-up flex item
            pushes the rest of the card over the episode column. */}
        <div className="h-[190px] w-[132px] shrink-0 overflow-hidden rounded-poster shadow-poster">
          {info ? (
            <Link href={`/en/anime/${info.id}`}>
              <Image
                src={info.coverImage.extraLarge}
                alt="Anime Cover"
                width={1000}
                height={1000}
                className="h-[190px] w-[132px] object-cover duration-300 ease-out hover:scale-[1.03]"
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

          {/* Same chip vocabulary as the info page's hero (Hero.tsx
              hStyles.genreChip / studioChip): brand-tinted pills for genres,
              a blue one for the studio. Two pages describing the same anime
              shouldn't spell it two different ways. */}
          <div className="flex flex-wrap items-center gap-2">
            {studio && (
              <span className="rounded-full border border-[rgba(74,143,255,0.3)] bg-[rgba(74,143,255,0.1)] px-[11px] py-[5px] text-xs font-semibold text-[#7ec8ff]">
                {studio}
              </span>
            )}
            {info?.genres?.map((item, index) => (
              <span
                key={index}
                className="rounded-full border border-action/[0.35] bg-action/[0.12] px-[11px] py-[5px] text-xs font-semibold text-[color-mix(in_srgb,var(--brand-primary,#ff7a91)_75%,#fff)]"
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
            className={`w-full rounded-[11px] px-5 py-3.5 text-[15px] font-semibold transition-colors ${
              onList
                ? "border border-[#2f3447] bg-white/[0.04] text-[#c4c8d4]"
                : "border border-action bg-action text-white hover:brightness-110"
            }`}
          >
            {onList ? t("anime.inYourList") : `+ ${t("anime.addToList")}`}
          </button>
          {actions}
        </div>
      </div>

      {/* Synopsis — info-page typography (14px / 1.65, --txt-1) on the same
          panel treatment as the rest of the card. */}
      <div className="relative rounded-xl bg-as-card/60 ring-1 ring-white/[0.06]">
        {info && (
          <>
            <div className="p-5">
              <p
                className="m-0 text-sm leading-[1.65] text-[#c4c8d4]"
                style={{ textWrap: "pretty" } as any}
                dangerouslySetInnerHTML={{
                  __html: showDesc
                    ? localizedDesc
                    : localizedDesc?.length > 420
                    ? truncatedDesc
                    : localizedDesc
                }}
              />
              {parsed.source && showDesc && (
                <div className="mt-2.5 text-[11px] text-[#5e6478]">
                  <em>
                    {t("anime.source")} · {parsed.source}
                  </em>
                </div>
              )}
            </div>
            {!showDesc && localizedDesc?.length > 120 && (
              <span
                onClick={() => setShowDesc((prev) => !prev)}
                className="absolute inset-0 flex h-full w-full cursor-pointer items-end justify-center rounded-xl bg-gradient-to-t from-as-card to-transparent pb-5 font-karla font-semibold hover:from-20%"
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
