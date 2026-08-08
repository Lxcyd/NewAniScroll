import Link from "next/link";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { animeHref } from "@/lib/prefs/clickTarget";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import {
  peekLocalEntry,
  removeLocalEntry,
  upsertLocalEntry,
  useLocalList,
} from "@/lib/list/localList";
import { toggleFavourite, useIsFavourite } from "@/lib/anilist/favouritesCache";
import { notify } from "@/lib/notifications/noticeStore";
import { fetchPreview, peekPreview, type PreviewData } from "@/lib/preview/previewStore";
import YoutubeTrailer from "./YoutubeTrailer";

export type AnchorRect = { top: number; left: number; width: number; height: number };

/** 17.5rem × 20rem — Hayase's preview card, to the pixel. */
const WIDTH = 280;
const HEIGHT = 320;
/** Gap kept between the card and the viewport edges. */
const MARGIN = 12;

const FORMAT_LABEL: Record<string, string> = {
  TV: "TV Series",
  TV_SHORT: "TV Short",
  MOVIE: "Movie",
  SPECIAL: "Special",
  OVA: "OVA",
  ONA: "ONA",
  MUSIC: "Music",
};

/**
 * Poster for the top 45 % of the card. Hayase's `banner()`: the AniList banner
 * first, then YouTube's own thumbnail for the trailer (which is a real 16:9
 * still, unlike the portrait cover), then the cover as a last resort.
 */
function bannerUrl(data: PreviewData | null, poster: string | null): string | null {
  if (!data) return poster;
  if (data.bannerImage) return data.bannerImage;
  if (data.trailer?.id) return `https://i.ytimg.com/vi/${data.trailer.id}/maxresdefault.jpg`;
  return data.coverImage?.large ?? poster;
}

export default function PreviewCard({
  id,
  rect,
  poster,
}: {
  id: number;
  rect: AnchorRect;
  poster: string | null;
}) {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const token = (session as any)?.user?.token ?? null;
  const titlePref = useTitlePref();

  const cardRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<PreviewData | null>(() => peekPreview(id) ?? null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  /** null = trailer not started, true = unplayable (keep the banner), false = playing. */
  const [hideFrame, setHideFrame] = useState<boolean | null>(null);

  // Local list state drives the play-button label and the bookmark fill, the
  // same way Hayase reads its auth aggregator.
  useLocalList();
  const entry = peekLocalEntry(id);
  const fav = useIsFavourite(id, token);

  useEffect(() => {
    let cancelled = false;
    fetchPreview(id).then((d) => {
      if (!cancelled && d) setData(d);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Centred on the hovered card, clamped inside the viewport. The card has a
  // fixed size, so this never needs to re-run for content.
  useLayoutEffect(() => {
    const left = Math.max(
      MARGIN,
      Math.min(rect.left + rect.width / 2 - WIDTH / 2, window.innerWidth - WIDTH - MARGIN),
    );
    const top = Math.max(
      MARGIN,
      Math.min(rect.top + rect.height / 2 - HEIGHT / 2, window.innerHeight - HEIGHT - MARGIN),
    );
    setPos({ top, left });
  }, [rect]);

  const onHide = useCallback((hidden: boolean) => setHideFrame(hidden), []);

  const title = data ? pickTitle(data.title, titlePref) : "";
  const banner = bannerUrl(data, poster);
  const trailerPlaying = hideFrame === false;

  // "N Episodes" / "3 / 12 Episodes", falling back to the runtime for movies and
  // single-episode entries — Hayase's `of() ?? duration() ?? 'N/A'`.
  const count = data?.episodes ?? null;
  const progress = entry?.progress ?? 0;
  const episodesCell =
    count && count > 1
      ? progress && progress !== count
        ? t("preview.episodeProgress", { progress, count })
        : t("preview.episodeCount", { count })
      : data?.duration
      ? t("preview.minutes", { count: data.duration })
      : "N/A";

  const season = [
    data?.season?.toLowerCase(),
    data?.seasonYear ?? undefined,
  ]
    .filter(Boolean)
    .join(" ");

  const playLabel =
    entry?.status === "COMPLETED"
      ? t("preview.rewatch")
      : entry?.status === "CURRENT" ||
        entry?.status === "REPEATING" ||
        entry?.status === "PAUSED"
      ? t("preview.continue")
      : t("preview.watchNow");

  const onBookmark = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (entry?.status) {
      removeLocalEntry(id);
      notify.success(t("preview.removedFromList"));
    } else {
      upsertLocalEntry(id, {
        status: "PLANNING",
        title: data?.title ?? undefined,
        coverImage: data?.coverImage?.large ?? poster ?? null,
        total: data?.episodes ?? null,
      });
      notify.success(t("preview.addedToPlanning"));
    }
  };

  const onFav = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!token) {
      notify.error(t("preview.signInForFavourites"));
      return;
    }
    await toggleFavourite(id, token);
  };

  return (
    <div
      ref={cardRef}
      data-preview-popup=""
      className="as-preview-card fixed z-[80] cursor-pointer overflow-hidden rounded-md bg-[var(--as-preview-bg)] shadow-2xl shadow-black/60"
      style={{
        // The bottom of the banner fades into this, so the gradient and the card
        // have to read the same value.
        ["--as-preview-bg" as any]: "#16171b",
        width: WIDTH,
        height: HEIGHT,
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        // Painted off-screen for one frame while we measure — otherwise the card
        // flashes at (0,0) before the layout effect places it.
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <div className="as-preview-banner relative h-[45%] rounded-t bg-black">
        {banner && (
          <>
            {/* Blurred, over-saturated copy bleeding out behind the card. Dropped
                once the trailer plays, because the trailer brings its own. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={banner}
              alt=""
              aria-hidden
              className={`absolute -z-10 size-full object-cover blur-2xl saturate-200 ${
                trailerPlaying ? "hidden" : ""
              }`}
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={banner}
              alt=""
              draggable={false}
              className="size-full rounded-t object-cover"
            />
          </>
        )}
        {data?.trailer?.id && !hideFrame && (
          <YoutubeTrailer id={data.trailer.id} onHide={onHide} />
        )}
      </div>

      <div className="w-full bg-[var(--as-preview-bg)] px-4 font-karla">
        <Link
          href={`/en/anime/${id}`}
          title={title}
          className="inline-block w-full truncate pt-2 text-lg font-bold text-white"
        >
          {title || " "}
        </Link>

        <div className="flex flex-row">
          <Link
            href={animeHref(id, "watch")}
            className="flex grow items-center justify-center gap-2 rounded-md bg-white px-3 py-1.5 text-xs font-bold text-black transition-opacity hover:opacity-90"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
            {playLabel}
          </Link>

          <button
            type="button"
            onClick={onFav}
            aria-label={t(fav ? "anime.removeFromFavourites" : "anime.addToFavourites")}
            title={t(fav ? "anime.removeFromFavourites" : "anime.addToFavourites")}
            className="ml-2 grid h-[30px] w-[30px] shrink-0 place-items-center rounded-md text-white/80 transition-colors hover:bg-white/10 hover:text-white"
          >
            {/* lucide heart */}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill={fav ? "currentColor" : "transparent"}
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
            </svg>
          </button>

          <button
            type="button"
            onClick={onBookmark}
            aria-label={t(entry?.status ? "preview.removeFromList" : "preview.addToPlanning")}
            title={t(entry?.status ? "preview.removeFromList" : "preview.addToPlanning")}
            className="ml-2 grid h-[30px] w-[30px] shrink-0 place-items-center rounded-md text-white/80 transition-colors hover:bg-white/10 hover:text-white"
          >
            {/* lucide bookmark */}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill={entry?.status ? "currentColor" : "transparent"}
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
            </svg>
          </button>
        </div>

        <div className="as-preview-details flex overflow-clip text-ellipsis whitespace-nowrap pb-2 pt-3 text-[11px] capitalize text-white">
          <span className="flex items-center whitespace-nowrap">
            {data?.format ? FORMAT_LABEL[data.format] ?? data.format : "N/A"}
          </span>
          <span className="flex items-center whitespace-nowrap">{episodesCell}</span>
          {season && <span className="flex items-center whitespace-nowrap">{season}</span>}
          {data?.averageScore != null && (
            <span className="flex items-center whitespace-nowrap text-ellipsis">
              {data.averageScore}%
            </span>
          )}
        </div>

        <div className="line-clamp-4 size-full overflow-clip text-[.7rem] leading-snug text-white/55">
          {data?.description ?? ""}
        </div>
      </div>
    </div>
  );
}
