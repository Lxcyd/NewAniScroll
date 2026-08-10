import Link from "next/link";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { animeHref } from "@/lib/prefs/clickTarget";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { peekLocalEntry, useLocalList } from "@/lib/list/localList";
import { toggleFavourite, useIsFavourite } from "@/lib/anilist/favouritesCache";
import { notify } from "@/lib/notifications/noticeStore";
import { fetchPreview, peekPreview, type PreviewData } from "@/lib/preview/previewStore";
import { useTranslatedText } from "@/lib/i18n/useTranslatedText";
import { genreLabel } from "@/lib/i18n/genreLabel";
import { statusLabel } from "@/components/anime/v2/helpers";
import { lockPreview, unlockPreview } from "@/lib/preview/previewLock";
import { MdInfoOutline, MdPlayArrow } from "react-icons/md";
import ListEditor from "@/components/listEditor";
import NativeTrailer from "./NativeTrailer";
import TrailerAmbient from "./TrailerAmbient";

export type AnchorRect = { top: number; left: number; width: number; height: number };

/**
 * Wider and taller than Hayase's 17.5rem × 20rem. Ours has to fully cover the
 * poster it pops over — a preview with the original card peeking out around it
 * reads as a rendering glitch — and our grids run larger posters than Hayase's.
 */
const WIDTH = 364;
/**
 * Taller than it was (424) because the meta row is now the info page's — score
 * with its rank, favourites, episodes with runtime and status — plus a chips
 * row. Those replaced a single line of "TV · 12 Episodes · Summer 2026 · 74%",
 * and they need the room.
 */
const HEIGHT = 476;
/**
 * Lines of synopsis that fit under the meta row at HEIGHT.
 *
 * Down from 5: the stats and chips took the space, and they earn it. A synopsis
 * is truncated either way on a card this size — the first three lines say what
 * the show is about about as well as five do — while the meta row is the part
 * you scan to decide, and it now says the same things the info page says.
 */
const DESC_LINES = 3;

/** Card surface. Kept in sync with the banner gradient in globals.css. */
const SURFACE = "#1a1a24";

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
  /**
   * The list editor, opened from the card and rendered over everything.
   *
   * While it is open the card holds a preview lock (see lib/preview/previewLock):
   * without it, moving the pointer toward the dialog would leave the card, the
   * provider would close the card, and the dialog — a child of the card — would
   * be unmounted mid-reach.
   */
  const [listOpen, setListOpen] = useState(false);

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
  //
  // Rounded to whole pixels, which is not cosmetic bookkeeping: a poster is
  // rarely at an integer offset, so centring on it lands the card on half
  // pixels. Everything the card clips — the rounded corners, the video's box —
  // is then antialiased against whatever sits behind it, and a half-covered row
  // of pixels along the top of the picture reads as a one-pixel outline.
  useLayoutEffect(() => {
    setPos({
      left: Math.round(rect.left + rect.width / 2 - WIDTH / 2),
      top: Math.round(rect.top + rect.height / 2 - HEIGHT / 2),
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

  /*
   * The info page's episode cell: "5/12 EP", or just "12 EP", with the runtime
   * beside it. The card used to phrase this its own way ("12 Episodes",
   * "3 / 12 Episodes") — two vocabularies for one fact, on two surfaces the
   * visitor moves between in one click.
   */
  const count = data?.episodes ?? null;
  const progress = entry?.progress ?? 0;
  const epLabel = count
    ? progress && progress !== count
      ? `${progress}/${count} EP`
      : `${count} EP`
    : "? EP";
  const durLabel = data?.duration ? `· ${data.duration}min` : "";

  const playLabel =
    entry?.status === "COMPLETED"
      ? t("preview.rewatch")
      : entry?.status === "CURRENT" ||
        entry?.status === "REPEATING" ||
        entry?.status === "PAUSED"
      ? t("preview.continue")
      : t("preview.watchNow");

  /*
   * Open the real list editor rather than silently filing the anime under
   * "Planning".
   *
   * The button used to be a one-click toggle into PLANNING, which is a guess:
   * most of the time the thing you want from a card you are hovering is
   * "watching, episode 4" or a score. This is the same editor the info page
   * opens, so the choice is the same choice in both places — and it works
   * signed out too, editing the local list.
   */
  const onOpenList = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    lockPreview();
    setListOpen(true);
  };

  const closeList = useCallback(() => {
    setListOpen(false);
    // Releasing is what lets the provider close the card again — and it closes
    // it, since the pointer left long ago. See lib/preview/previewLock.
    unlockPreview();
  }, []);

  // A card torn down while the editor is open (route change, Escape handled
  // upstream) must not leave the lock held — nothing would ever release it and
  // every later hover would refuse to close.
  useEffect(
    () => () => {
      if (listOpen) unlockPreview();
    },
    [listOpen],
  );

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
      {/* Ambient light, in two stages through ONE component: the artwork holds
          the glow from the first frame, then the trailer takes over and the
          light follows the video. Both stages go through the same projector
          stack, so the hand-off is a dissolve rather than one layer swapping
          for another.

          The clip box is the VIDEO's box, cut open on three sides: the glow may
          spill left, right and above as far as the blur reaches, and is cut dead
          at the bottom of the picture. Light coming off a screen doesn't wrap
          around to backlight the text under it. */}
      <div className="as-preview-ambient-clip pointer-events-none absolute -z-10" aria-hidden>
        <TrailerAmbient
          banner={banner}
          sourceRef={trailerVideoRef}
          playing={playing && trailerMounted}
          zoom={crop}
        />
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
          //
          // The negative spread is what removes the dark outline that used to
          // trace the rounded corners. A rounded edge is antialiased — its
          // outermost pixels are half-covered by definition, at any position and
          // any zoom — so whatever sits directly BEHIND the card shows through
          // them. With the shadow reaching the corners, that was 50 % black
          // between a bright picture and a bright page, which is exactly how a
          // one-pixel line is drawn. Pulled 12 px inside the box, the shadow no
          // longer touches any edge the eye follows; it still falls below the
          // card, which is all it was ever for.
          boxShadow: "0 18px 38px -12px rgba(0,0,0,.62)",
        }}
      >
        {/* The surface, not black, behind the picture. Nothing legitimately
            shows through here — banner and trailer both cover the box — so the
            only thing this colour ever paints is the antialiased edge where the
            rounded clip meets it, and against black that edge was a visible
            dark outline. Matching the card makes the seam the card. */}
        <div
          className="as-preview-banner relative h-[45%]"
          style={{ background: SURFACE }}
        >
          {/* Holds the slot while the payload is in flight. The endpoint is
              prefetched 30 ms before the card mounts and edge-cached for a day,
              so on a warm id this is never seen. */}
          {/* No radius on any of these: see the note in NativeTrailer — the card
              owns the corners, and a second curve at the same radius only draws
              a seam. */}
          {!banner && <div className="as-preview-skeleton h-full w-full" />}
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
              className={`h-full w-full object-cover transition-opacity duration-300 ${
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
              onClick={onOpenList}
              aria-label={t("preview.editList")}
              title={t("preview.editList")}
              className="as-preview-iconbtn ml-1"
              // Filled while the anime IS on a list, hollow otherwise — the
              // bookmark says its own state, so the button needs no label.
              style={entry?.status ? { color: "#ffffff" } : undefined}
            >
              {/* Material "bookmark" / "bookmark_border", 24px grid. */}
              <svg width="18" height="18" viewBox="0 -960 960 960" fill="currentColor">
                {entry?.status ? (
                  <path d="M200-120v-640q0-33 23.5-56.5T280-840h400q33 0 56.5 23.5T760-760v640L480-240 200-120Z" />
                ) : (
                  <path d="M200-120v-640q0-33 23.5-56.5T280-840h400q33 0 56.5 23.5T760-760v640L480-240 200-120Zm80-122 200-86 200 86v-518H280v518Zm0-518h400-400Z" />
                )}
              </svg>
            </button>

            <Link
              href={`/en/anime/${id}`}
              aria-label={t("preview.moreInfo")}
              title={t("preview.moreInfo")}
              className="as-preview-iconbtn ml-1"
            >
              <MdInfoOutline size={19} />
            </Link>
          </div>

          {/* The info page's stats row and chips, at card scale — same icons,
              same colours, same wording, and the same order (score, favourites,
              episodes). A preview OF a page that phrases its facts differently
              is two designs for one thing.

              The whole block is one link to that page: these are the numbers
              you read to decide, so reading them is the moment you'd want more,
              and a 300 px strip is a far easier target than any button on it. */}
          <Link
            href={`/en/anime/${id}`}
            title={t("preview.moreInfo")}
            className="block pb-1 pt-3 transition-opacity hover:opacity-90"
          >
            <div className="flex items-center justify-center gap-4">
              {data?.averageScore != null && (
                <>
                  <div className="flex flex-col items-center gap-1 text-center">
                    <div className="flex items-center gap-1.5">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="#f6c544">
                        <polygon points="12 2 15 9 22 9 17 14 19 21 12 17 5 21 7 14 2 9 9 9" />
                      </svg>
                      {/* AniList scores out of 100, the info page shows /10. */}
                      <span className="display text-[15px] font-bold leading-none text-[#f6c544]">
                        {(data.averageScore / 10).toFixed(2)}
                      </span>
                      <span className="text-[10px] font-medium text-white/45">/10</span>
                    </div>
                    <div className="text-[8.5px] font-semibold tracking-[0.1em] text-white/40">
                      {data.ratingRank
                        ? t("anime.rated", { rank: data.ratingRank }).toUpperCase()
                        : t("anime.average").toUpperCase()}
                    </div>
                  </div>
                  <div className="h-7 w-px bg-white/10" />
                </>
              )}

              {data?.favourites != null && (
                <>
                  <div className="flex flex-col items-center gap-1 text-center">
                    <div className="flex items-center gap-1.5">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="#ff3b5c">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                      </svg>
                      <span className="display text-[15px] font-bold leading-none text-white">
                        {data.favourites.toLocaleString()}
                      </span>
                    </div>
                    <div className="text-[8.5px] font-semibold tracking-[0.1em] text-white/40">
                      {t("preview.favourites")}
                    </div>
                  </div>
                  <div className="h-7 w-px bg-white/10" />
                </>
              )}

              <div className="flex flex-col items-center gap-1 text-center">
                <div className="flex items-center gap-1.5 text-white">
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <rect x="3" y="5" width="18" height="14" rx="2" />
                    <path d="m10 9 5 3-5 3z" fill="currentColor" />
                  </svg>
                  <span className="display text-[15px] font-bold leading-none">{epLabel}</span>
                  <span className="text-[10px] font-medium text-white/45">{durLabel}</span>
                </div>
                <div className="text-[8.5px] font-semibold tracking-[0.1em] text-white/40">
                  {statusLabel(t, data?.status ?? null).toUpperCase()}
                </div>
              </div>
            </div>

            {(data?.genres?.length || data?.studios?.length) && (
              <div className="mt-2.5 flex flex-wrap items-center justify-center gap-1.5">
                {(data?.genres || []).slice(0, 3).map((g) => (
                  <span
                    key={g}
                    className="rounded-full px-2 py-[3px] text-[10px] font-semibold"
                    style={{
                      background:
                        "color-mix(in srgb, var(--brand-primary, #ff3b5c) 12%, transparent)",
                      border:
                        "1px solid color-mix(in srgb, var(--brand-primary, #ff3b5c) 35%, transparent)",
                      color: "color-mix(in srgb, var(--brand-primary, #ff7a91) 75%, #fff)",
                    }}
                  >
                    {genreLabel(t, g)}
                  </span>
                ))}
                {(data?.studios || []).slice(0, 1).map((s) => (
                  <span
                    key={s}
                    className="max-w-[46%] truncate rounded-full px-2 py-[3px] text-[10px] font-semibold"
                    style={{
                      background: "rgba(74,143,255,0.1)",
                      border: "1px solid rgba(74,143,255,0.3)",
                      color: "#7ec8ff",
                    }}
                  >
                    {s}
                  </span>
                ))}
              </div>
            )}
          </Link>

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

      {/* The list editor, portalled to <body> rather than left inside the card.
          Inside, it would inherit the card's stacking context and its clipping,
          and a full-screen dialog cannot live inside a 364 px box that hides its
          overflow. The card still owns it — it mounts and unmounts with the
          card, and holds the preview lock for as long as it is open. */}
      {listOpen &&
        data &&
        createPortal(
          <ListEditor
            animeId={id}
            session={session}
            stats={entry?.status || undefined}
            prg={entry?.progress ?? 0}
            max={data.episodes ?? undefined}
            // The editor wants the info page's full media object; the preview
            // payload is a slice of the same AniList entry, and the fields it
            // reads (id, title, episodes, cover) are all in it.
            info={data as any}
            close={closeList}
          />,
          document.body,
        )}
    </div>
  );
}
