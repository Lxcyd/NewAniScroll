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
import { MdPlayArrow } from "react-icons/md";
import NativeTrailer from "./NativeTrailer";
import TrailerAmbient from "./TrailerAmbient";

export type AnchorRect = { top: number; left: number; width: number; height: number };

/**
 * Wider and taller than Hayase's 17.5rem × 20rem. Ours has to fully cover the
 * poster it pops over — a preview with the original card peeking out around it
 * reads as a rendering glitch — and our grids run larger posters than Hayase's.
 */
const WIDTH = 364;
const HEIGHT = 424;
/** Lines of synopsis that fit under the meta row at HEIGHT. */
const DESC_LINES = 5;

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
  /** The crop measured for this trailer, shared so the glow is framed like the picture. */
  const [crop, setCrop] = useState(1);
  /*
   * The glow mounts WITH the player, not after it.
   *
   * Deferring it until the player was buffered looked like the obvious saving —
   * two elements pulling one file, and the one nobody looks at directly was
   * taking bandwidth from the one they do. It was a bad trade. A layer that
   * mounts while `playing` is already true is born at full opacity, because a
   * CSS transition does not run on the initial render, and it is born before it
   * has decoded a frame: a black blurred rectangle appearing in one step,
   * off-register with the card and behind the picture's clock. Starting both
   * together is what makes the fade-in a fade and the two copies agree.
   */
  /**
   * The playing trailer. The ambient glow paints its frames straight out of it.
   *
   * Lives here rather than inside the trailer because two siblings need it. It
   * also replaces the old loop counter: looping used to mean remounting the
   * ambient iframe on every cycle, since a decorative embed had no channel to
   * be told anything — and a second copy of a video is exactly what could fall
   * out of step with the first. There is one video now, read twice.
   */
  const trailerVideoRef = useRef<HTMLVideoElement>(null);

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

  // Centred on the hovered card, and that is all.
  //
  // No viewport clamping: a poster half off the edge of a carousel gets a
  // preview half off the edge too. That is what Hayase does — the popup is
  // anchored to the card, and pulling it back in would make it point at a
  // neighbour instead. `rect` is refreshed by the provider on scroll, so this
  // re-runs and the card travels with the page like any other element.
  useLayoutEffect(() => {
    setPos({
      left: rect.left + rect.width / 2 - WIDTH / 2,
      top: rect.top + rect.height / 2 - HEIGHT / 2,
    });
  }, [rect]);

  const onHide = useCallback((hidden: boolean) => setHideFrame(hidden), []);
  const onPlayingChange = useCallback((next: boolean) => setPlaying(next), []);
  const onCrop = useCallback((zoom: number) => setCrop(zoom), []);

  const title = data ? pickTitle(data.title, titlePref) : "";
  // Same treatment the info page gives its synopsis: translated on demand and
  // cached server-side, because AniList only ever ships English.
  const description = useTranslatedText(data?.description ?? "");
  const banner = bannerUrl(data);
  // The trailer element is mounted as soon as we have an id and it hasn't been
  // ruled unplayable; `playing` is the finer, live state.
  const trailerMounted = Boolean(data?.trailer?.id) && !hideFrame;

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

  // Lifted from components/anime/v2/Hero.tsx (`hStyles`): the secondary action
  // there is rgba(255,255,255,.04) on a #2f3447 hairline at radius 11, and the
  // CTA is the brand gradient with its own glow. Hard-coded rather than read
  // from `--line-2`, which is declared inside the info page's CSS module and so
  // doesn't exist for a popup portalled to <body>.
  // The shape lives in globals.css (`.as-preview-iconbtn`): an inline
  // `background` beats any `:hover` rule, and these need one. The "on" state
  // travels as a data attribute for the same reason.

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
      {/* Ambient light, in two stages: the artwork holds the glow from the first
          frame, then the trailer takes over and the light follows the video. A
          still image can't do that and a cross-origin embed can't be sampled, so
          the second stage is a second copy of the video (see TrailerAmbient).

          The clip box is the VIDEO's box, cut open on three sides: the glow may
          spill left, right and above as far as the blur reaches, and is cut dead
          at the bottom of the picture. Light coming off a screen doesn't wrap
          around to backlight the text under it. */}
      <div className="as-preview-ambient-clip pointer-events-none absolute -z-10" aria-hidden>
        {banner && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={banner}
            alt=""
            draggable={false}
            className="as-preview-ambient absolute blur-2xl saturate-200 transition-opacity duration-700"
            style={{ opacity: playing ? 0 : AMBIENT_OPACITY }}
          />
        )}
        {trailerMounted && data?.trailer?.id && (
          <TrailerAmbient playing={playing} sourceRef={trailerVideoRef} zoom={crop} />
        )}
      </div>

      <div
        className="as-preview-card relative h-full w-full cursor-pointer overflow-hidden rounded-card ring-1 ring-white/10"
        style={{
          // The bottom of the banner fades into this, so the gradient and the
          // card have to read the same value.
          ["--as-preview-bg" as any]: SURFACE,
          background: SURFACE,
          // Drop shadow ONLY, and a tight one.
          //
          // There used to be a second shadow here in the anime's dominant
          // colour. It looked like ambient light and it was not: a box-shadow
          // wraps all four sides, so it lit the card from underneath the
          // synopsis as much as from behind the video — which is exactly the
          // "glow all around the window" that the real ambient layer is clipped
          // to avoid. One source of light per card.
          boxShadow: "0 14px 34px rgba(0,0,0,.5)",
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
            <NativeTrailer
              id={data.trailer.id}
              videoRef={trailerVideoRef}
              onHide={onHide}
              onPlayingChange={onPlayingChange}
              onCrop={onCrop}
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
              className="flex grow items-center justify-center gap-2 font-outfit text-[11px] font-bold uppercase tracking-[0.12em] text-white transition-opacity hover:opacity-90"
              style={{
                borderRadius: 11,
                padding: "9px 14px",
                background:
                  "linear-gradient(135deg, var(--brand-primary, #ff3b5c) 0%, color-mix(in srgb, var(--brand-primary, #e8294b) 82%, #000) 100%)",
                boxShadow:
                  "0 10px 24px -12px color-mix(in srgb, var(--brand-primary, #ff3b5c) 70%, transparent), inset 0 1px 0 rgba(255,255,255,0.2)",
              }}
            >
              <MdPlayArrow size={16} />
              {playLabel}
            </Link>

            <button
              type="button"
              onClick={onFav}
              aria-label={t(fav ? "anime.removeFromFavourites" : "anime.addToFavourites")}
              title={t(fav ? "anime.removeFromFavourites" : "anime.addToFavourites")}
              className="as-preview-iconbtn ml-2"
              data-on={fav ? "true" : "false"}
            >
              {/* The info page's heart, path for path — same silhouette in both
                  places or the same action reads as two different features. */}
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill={fav ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth={2}
                style={{ transition: "fill .2s ease" }}
              >
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
              </svg>
            </button>

            <button
              type="button"
              onClick={onBookmark}
              aria-label={t(entry?.status ? "preview.removeFromList" : "preview.addToPlanning")}
              title={t(entry?.status ? "preview.removeFromList" : "preview.addToPlanning")}
              className="as-preview-iconbtn ml-1"
              style={entry?.status ? { color: "#ffffff" } : undefined}
            >
              {/* QueueButton's playlist glyphs (components/anime/v2/QueueButton):
                  this button does the same thing, so it wears the same icon. */}
              <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
                {entry?.status ? (
                  <path d="M14 10H2v2h12v-2zm0-4H2v2h12V6zM2 16h8v-2H2v2zm19.5-4.5L23 13l-6.99 7-4.51-4.5L13 14l3.01 3 5.49-5.5z" />
                ) : (
                  <path d="M14 10H2v2h12v-2zm0-4H2v2h12V6zM2 16h8v-2H2v2zm15-2v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4z" />
                )}
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
