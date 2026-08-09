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
import { useTranslatedText } from "@/lib/i18n/useTranslatedText";
import YoutubeTrailer from "./YoutubeTrailer";
import TrailerAmbient from "./TrailerAmbient";

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

/** Lines of synopsis that fit under the meta row at HEIGHT. */
const DESC_LINES = 5;
/** How far the ambient glow spills past the card; kept out of the viewport clamp. */
const AMBIENT_SPILL = 60;

/** Card surface. Kept in sync with the banner gradient in globals.css. */
const SURFACE = "#1a1a24";
/** Strength of the glow. Matched in TrailerAmbient so the hand-off is invisible. */
const AMBIENT_OPACITY = 0.85;

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
 * Artwork for the top 45 % of the card, and it is the INFO PAGE's chain, not
 * Hayase's: `bannerImage` already arrives resolved from /api/v2/preview (see
 * lib/images/heroBanner), and the cover stretches behind it when nothing wide
 * exists — exactly what the info page does.
 *
 * Two things deliberately absent. Hayase inserts the YouTube trailer thumbnail
 * between the two; it is a fine picture but it is not the one the info page
 * shows, and the card is a preview OF that page. And the grid poster we hover is
 * NOT used as a stand-in while the payload flies: it is a portrait cover in a
 * 16:9 slot, so painting it meant every card visibly swapped its banner a
 * fraction of a second after opening. Better to show nothing for that instant.
 */
function bannerUrl(data: PreviewData | null): string | null {
  if (!data) return null;
  return data.bannerImage ?? data.coverImage?.large ?? null;
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
  /** Fade in on decode rather than on mount — a half-painted banner is a flash too. */
  const [bannerReady, setBannerReady] = useState(false);
  /** Live transport state from the trailer. Artwork shows whenever it's false. */
  const [playing, setPlaying] = useState(false);
  /** Bumped when the trailer loops, so the ambient copy restarts alongside it. */
  const [cycle, setCycle] = useState(0);

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
  // Centred on the hovered card, then pulled back inside the viewport. Hovering
  // a poster that is itself half off-screen (the ends of a carousel) must not
  // put half the preview off-screen with it — the card moves, the anchor
  // doesn't. `clientWidth` rather than `innerWidth`: the latter counts the
  // scrollbar, which is not somewhere the card can be seen.
  //
  // Runs once per open. It deliberately does NOT re-run on scroll: see the
  // provider — the card stays where it was put.
  useLayoutEffect(() => {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    // The glow reaches AMBIENT_SPILL past every edge; clamping the card alone
    // would let the light get sliced by the viewport.
    const edge = MARGIN + AMBIENT_SPILL;
    const fit = (want: number, size: number, viewport: number) =>
      viewport < size + 2 * edge
        ? Math.max(MARGIN, (viewport - size) / 2)
        : Math.max(edge, Math.min(want, viewport - size - edge));
    setPos({
      left: fit(rect.left + rect.width / 2 - WIDTH / 2, WIDTH, vw),
      top: fit(rect.top + rect.height / 2 - HEIGHT / 2, HEIGHT, vh),
    });
  }, [rect]);

  const onHide = useCallback((hidden: boolean) => setHideFrame(hidden), []);
  const onPlayingChange = useCallback((next: boolean) => setPlaying(next), []);
  const onCycle = useCallback(() => setCycle((n) => n + 1), []);

  const title = data ? pickTitle(data.title, titlePref) : "";
  // Same treatment the info page gives its synopsis: translated on demand and
  // cached server-side, because AniList only ever ships English.
  const description = useTranslatedText(data?.description ?? "");
  const banner = bannerUrl(data);
  // The trailer element is mounted as soon as we have an id and it hasn't been
  // ruled unplayable; `playing` is the finer, live state.
  const trailerMounted = Boolean(data?.trailer?.id) && !hideFrame;
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
          card surface is opaque.

          Two stages. The artwork holds the glow from the first frame, then the
          trailer takes over and the light starts following the video — a still
          image can't do that, and a cross-origin embed can't be sampled, so the
          only way is a second copy of the video (see TrailerAmbient). */}
      {banner && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={banner}
          alt=""
          aria-hidden
          draggable={false}
          className="as-preview-ambient pointer-events-none absolute -z-10 blur-2xl saturate-200 transition-opacity duration-700"
          style={{ opacity: playing ? 0 : AMBIENT_OPACITY }}
        />
      )}
      {trailerMounted && data?.trailer?.id && (
        // `key` on the loop counter: the ambient copy has no API channel, so the
        // only way to restart it with the real player is to remount it.
        <TrailerAmbient key={cycle} id={data.trailer.id} playing={playing} />
      )}

      <div
        className="as-preview-card relative h-full w-full cursor-pointer overflow-hidden rounded-card ring-1 ring-white/10"
        style={{
          // The bottom of the banner fades into this, so the gradient and the
          // card have to read the same value.
          ["--as-preview-bg" as any]: SURFACE,
          background: SURFACE,
          // Kept deliberately tight. A wide black drop shadow sits exactly where
          // the ambient light is trying to land and cancels it — the card needs
          // separation from the page, not a pool of shade around it.
          boxShadow: `0 14px 34px rgba(0,0,0,.5)${
            accent ? `, 0 0 40px -16px ${accent}` : ""
          }`,
        }}
      >
        <div className="as-preview-banner relative h-[45%] rounded-t-card bg-black">
          {/* Holds the slot while the payload is in flight. The endpoint is
              prefetched 30 ms before the card mounts and edge-cached for a day,
              so on a warm id this is never seen. */}
          {!banner && <div className="as-preview-skeleton h-full w-full rounded-t-card" />}
          {banner && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={banner}
              alt=""
              draggable={false}
              // Both paths matter: `complete` covers the warm case, where the
              // banner is already in the HTTP cache (see warmImage) and the load
              // event fired before React attached a handler.
              ref={(node) => {
                if (node?.complete) setBannerReady(true);
              }}
              onLoad={() => setBannerReady(true)}
              // h-full w-full, not `size-full`: Tailwind 3.3 here, `size-*` is 3.4+.
              className={`h-full w-full rounded-t-card object-cover transition-opacity duration-300 ${
                bannerReady && !playing ? "opacity-100" : "opacity-0"
              }`}
            />
          )}
          {data?.trailer?.id && !hideFrame && (
            <YoutubeTrailer
              id={data.trailer.id}
              onHide={onHide}
              onPlayingChange={onPlayingChange}
              onCycle={onCycle}
            />
          )}
        </div>

        <div className="w-full px-4 pb-4 font-karla" style={{ background: SURFACE }}>
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

          {/* The synopsis is the biggest target on the card and it was inert;
              it goes where the title goes. */}
          <Link
            href={`/en/anime/${id}`}
            // DESC_LINES, not a bare line-clamp: the ellipsis only appears when
            // the clamp is what truncates. Left to overflow the card's fixed
            // height instead, the text was simply sliced mid-word by
            // `overflow: hidden` and no "…" was ever drawn. The explicit height
            // makes the clamp the binding constraint.
            className="block w-full overflow-hidden text-[.72rem] leading-[1.45] text-white/50 transition-colors hover:text-white/75"
            style={{
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: DESC_LINES,
              maxHeight: `calc(${DESC_LINES} * 1.45 * .72rem)`,
            } as any}
          >
            {description}
          </Link>
        </div>
      </div>
    </div>
  );
}
