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

/**
 * Wider and taller than Hayase's 17.5rem × 20rem. Ours has to fully cover the
 * poster it pops over — a preview with the original card peeking out around it
 * reads as a rendering glitch — and our grids run larger posters than Hayase's.
 */
const WIDTH = 364;
const HEIGHT = 424;
/** Gap kept between the card and the viewport edges. */
const MARGIN = 12;

/** Card surface. Kept in sync with the banner gradient in globals.css. */
const SURFACE = "#1a1a24";

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
  const accent = data?.coverImage?.color ?? null;

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

  const iconButton =
    "grid h-[34px] w-[34px] shrink-0 place-items-center rounded-md bg-white/[0.06] text-white/75 ring-1 ring-white/10 transition-colors hover:bg-white/[0.12] hover:text-white";

  return (
    <div
      ref={cardRef}
      data-preview-popup=""
      className="as-preview-root fixed z-[80]"
      style={{
        width: WIDTH,
        height: HEIGHT,
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        // Painted off-screen for one frame while we measure — otherwise the card
        // flashes at (0,0) before the layout effect places it.
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {/* Ambient light: the artwork blown up, blurred and over-saturated behind
          the card, spilling past its edges. It lives OUTSIDE the card because
          the card clips its own children, and behind it via z-index because the
          card surface is opaque. */}
      {banner && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={banner}
          alt=""
          aria-hidden
          draggable={false}
          className="as-preview-ambient pointer-events-none absolute -z-10"
        />
      )}

      <div
        className="as-preview-card relative h-full w-full cursor-pointer overflow-hidden rounded-card ring-1 ring-white/10"
        style={{
          // The bottom of the banner fades into this, so the gradient and the
          // card have to read the same value.
          ["--as-preview-bg" as any]: SURFACE,
          background: SURFACE,
          // The anime's own dominant colour, as a halo. AniList ships it in the
          // payload, so it costs nothing and it ties the card to the artwork.
          boxShadow: `0 20px 55px rgba(0,0,0,.62)${
            accent ? `, 0 0 46px -14px ${accent}` : ""
          }`,
        }}
      >
        <div className="as-preview-banner relative h-[45%] rounded-t-card bg-black">
          {banner && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={banner}
              alt=""
              draggable={false}
              // h-full w-full, not `size-full`: Tailwind 3.3 here, `size-*` is 3.4+.
              className={`h-full w-full rounded-t-card object-cover transition-opacity duration-300 ${
                trailerPlaying ? "opacity-0" : "opacity-100"
              }`}
            />
          )}
          {data?.trailer?.id && !hideFrame && (
            <YoutubeTrailer id={data.trailer.id} onHide={onHide} />
          )}
        </div>

        <div className="w-full px-4 font-karla" style={{ background: SURFACE }}>
          <Link
            href={`/en/anime/${id}`}
            title={title}
            className="inline-block w-full truncate pt-2.5 font-outfit text-[17px] font-bold leading-tight text-white"
          >
            {title || " "}
          </Link>

          <div className="mt-2.5 flex flex-row">
            <Link
              href={animeHref(id, "watch")}
              className="flex grow items-center justify-center gap-2 rounded-md bg-as-accent px-3 py-2 font-outfit text-[11px] font-bold uppercase tracking-[0.12em] text-white transition-opacity hover:opacity-90"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
              {playLabel}
            </Link>

            <button
              type="button"
              onClick={onFav}
              aria-label={t(fav ? "anime.removeFromFavourites" : "anime.addToFavourites")}
              title={t(fav ? "anime.removeFromFavourites" : "anime.addToFavourites")}
              className={`ml-2 ${iconButton} ${fav ? "!text-as-accent" : ""}`}
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
              className={`ml-2 ${iconButton} ${entry?.status ? "!text-white" : ""}`}
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

          <div className="as-preview-details flex overflow-clip text-ellipsis whitespace-nowrap pb-2 pt-3 text-[11px] capitalize text-white/70">
            <span className="flex items-center whitespace-nowrap">
              {data?.format ? FORMAT_LABEL[data.format] ?? data.format : "N/A"}
            </span>
            <span className="flex items-center whitespace-nowrap">{episodesCell}</span>
            {season && <span className="flex items-center whitespace-nowrap">{season}</span>}
            {data?.averageScore != null && (
              <span className="flex items-center whitespace-nowrap text-ellipsis text-as-score">
                {data.averageScore}%
              </span>
            )}
          </div>

          <div className="line-clamp-5 h-full w-full overflow-clip text-[.72rem] leading-relaxed text-white/50">
            {data?.description ?? ""}
          </div>
        </div>
      </div>
    </div>
  );
}
