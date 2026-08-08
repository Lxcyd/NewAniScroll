import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { animeHref } from "@/lib/prefs/clickTarget";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { toggleQueue, useIsQueued } from "@/lib/list/queue";
import { notify } from "@/lib/notifications/noticeStore";
import { fetchPreview, peekPreview, type PreviewData } from "@/lib/preview/previewStore";

export type AnchorRect = { top: number; left: number; width: number; height: number };

/** Card width in px. Wide enough for three lines of synopsis at 13px. */
const WIDTH = 360;
/** Gap kept between the card and the viewport edges. */
const MARGIN = 12;
/**
 * How long the card must stay open before we embed YouTube. The card can appear
 * and vanish in under a second while the pointer travels; loading the player for
 * that would cost a third-party frame per card crossed.
 */
const TRAILER_DELAY = 700;

const MUTED_KEY = "aniscroll:preview:muted";

const FORMAT_LABEL: Record<string, string> = {
  TV: "TV Series",
  TV_SHORT: "TV Short",
  MOVIE: "Movie",
  SPECIAL: "Special",
  OVA: "OVA",
  ONA: "ONA",
  MUSIC: "Music",
};

const SEASON_LABEL: Record<string, string> = {
  WINTER: "Winter",
  SPRING: "Spring",
  SUMMER: "Summer",
  FALL: "Fall",
};

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
  const titlePref = useTitlePref();
  const queued = useIsQueued(id);

  const cardRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<PreviewData | null>(() => peekPreview(id) ?? null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPreview(id).then((d) => {
      if (!cancelled && d) setData(d);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Position against the hovered card, centred on it and clamped inside the
  // viewport. Runs again once `data` lands because the synopsis changes the
  // card's height, and the vertical clamp depends on it.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    const left = Math.max(
      MARGIN,
      Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - MARGIN),
    );
    const top = Math.max(
      MARGIN,
      Math.min(rect.top + rect.height / 2 - h / 2, window.innerHeight - h - MARGIN),
    );
    setPos({ top, left });
  }, [rect, data]);

  // Empty (not "Untitled") until the payload lands — the title row renders a
  // skeleton in the meantime.
  const title = data ? pickTitle(data.title, titlePref) : "";
  const backdrop = data?.bannerImage || poster || data?.coverImage?.large || null;

  const meta = [
    data?.format ? FORMAT_LABEL[data.format] ?? data.format : null,
    data?.episodes ? t("preview.episodeCount", { count: data.episodes }) : null,
    data?.season && data?.seasonYear
      ? `${SEASON_LABEL[data.season] ?? data.season} ${data.seasonYear}`
      : data?.seasonYear
      ? String(data.seasonYear)
      : null,
    data?.averageScore != null ? `${data.averageScore}%` : null,
  ].filter(Boolean) as string[];

  return (
    <div
      ref={cardRef}
      data-preview-popup=""
      className="as-preview-card fixed z-[80] overflow-hidden rounded-xl bg-[#16171b] shadow-2xl shadow-black/60 ring-1 ring-white/10"
      style={{
        width: WIDTH,
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        // Painted off-screen for one frame while we measure it — otherwise the
        // card flashes at (0,0) before the layout effect moves it.
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <Media
        trailerId={data?.trailer?.id ?? null}
        backdrop={backdrop}
        color={data?.coverImage?.color ?? null}
      />

      <div className="flex flex-col gap-2.5 p-3.5 font-karla">
        {title ? (
          <Link
            href={`/en/anime/${id}`}
            title={title}
            className="line-clamp-1 text-[17px] font-bold text-white transition-colors hover:text-[var(--accent)]"
          >
            {title}
          </Link>
        ) : (
          <span className="h-4 w-2/3 animate-pulse rounded bg-white/10" />
        )}

        <div className="flex items-center gap-2">
          <Link
            href={animeHref(id, "watch")}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-white px-3 py-2 text-sm font-bold text-black transition-transform duration-150 hover:scale-[1.02]"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
            {t("preview.watchNow")}
          </Link>
          <button
            type="button"
            onClick={() => {
              const now = toggleQueue({
                mediaId: id,
                title: data?.title ?? undefined,
                coverImage: data?.coverImage?.large ?? poster ?? null,
              });
              notify.success(now ? t("queue.added") : t("queue.removed"));
            }}
            aria-label={queued ? t("queue.remove") : t("queue.add")}
            title={queued ? t("queue.remove") : t("queue.add")}
            className={`grid h-[38px] w-[38px] shrink-0 place-items-center rounded-md border transition-colors ${
              queued
                ? "border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]"
                : "border-white/15 bg-white/[0.04] text-white/80 hover:text-white"
            }`}
          >
            {/* Material "bookmark" / "bookmark_border" */}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              {queued ? (
                <path d="M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2z" />
              ) : (
                <path d="M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2zm0 15-5-2.18L7 18V5h10v13z" />
              )}
            </svg>
          </button>
        </div>

        {meta.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-1.5 text-[12px] font-semibold text-white/70">
            {meta.map((m, i) => (
              <span key={m} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-white/30">•</span>}
                {m}
              </span>
            ))}
          </div>
        )}

        {data ? (
          data.description && (
            <p className="line-clamp-3 text-[12.5px] leading-snug text-white/55">
              {data.description}
            </p>
          )
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className="h-2.5 w-full animate-pulse rounded bg-white/10" />
            <span className="h-2.5 w-4/5 animate-pulse rounded bg-white/10" />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The 16:9 header: poster/banner first, YouTube on top of it once the card has
 * survived {@link TRAILER_DELAY}.
 *
 * The iframe is `pointer-events: none` on purpose — a cross-origin frame
 * swallows the pointer events the provider relies on to know it is still being
 * hovered, so the card would close the moment the pointer entered the trailer.
 * Play/pause and mute are our own overlay buttons, driven through the YouTube
 * iframe API's postMessage protocol (`enablejsapi=1`), which needs no SDK script.
 */
function Media({
  trailerId,
  backdrop,
  color,
}: {
  trailerId: string | null;
  backdrop: string | null;
  color: string | null;
}) {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [showTrailer, setShowTrailer] = useState(false);
  const [frameReady, setFrameReady] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [muted, setMuted] = useState(true);

  useEffect(() => {
    try {
      setMuted(window.localStorage.getItem(MUTED_KEY) !== "false");
    } catch {
      /* default stays muted */
    }
  }, []);

  useEffect(() => {
    if (!trailerId) return;
    const id = setTimeout(() => setShowTrailer(true), TRAILER_DELAY);
    return () => clearTimeout(id);
  }, [trailerId]);

  const command = (func: string, args: any[] = []) => {
    frameRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func, args }),
      "*",
    );
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    try {
      window.localStorage.setItem(MUTED_KEY, String(next));
    } catch {
      /* best-effort */
    }
    command(next ? "mute" : "unMute");
    // Autoplay started muted; un-muting a frame the browser paused for policy
    // reasons needs an explicit nudge.
    if (!next) command("playVideo");
  };

  const togglePlay = () => {
    const next = !playing;
    setPlaying(next);
    command(next ? "playVideo" : "pauseVideo");
  };

  // `mute=1` is not optional: without it Chrome blocks the autoplay outright.
  // loop=1 needs `playlist` set to the same id — that is how the iframe API
  // loops a single video.
  const src = trailerId
    ? `https://www.youtube-nocookie.com/embed/${trailerId}?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0&playsinline=1&loop=1&playlist=${trailerId}&enablejsapi=1&iv_load_policy=3&disablekb=1`
    : null;

  return (
    <div
      className="group/media relative aspect-video w-full overflow-hidden"
      style={{ background: color || "#1e1f24" }}
    >
      {backdrop && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={backdrop}
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}

      {showTrailer && src && (
        <iframe
          ref={frameRef}
          src={src}
          title="trailer"
          allow="autoplay; encrypted-media"
          // 16:9 video inside a 16:9 box still gets YouTube's own padding —
          // the scale crops it out so the trailer fills the header edge to edge.
          // Crossfade in rather than cutting from the poster to a black frame
          // while YouTube boots.
          className={`pointer-events-none absolute inset-0 h-full w-full scale-[1.35] border-0 transition-opacity duration-500 ${
            frameReady ? "opacity-100" : "opacity-0"
          }`}
          onLoad={() => setFrameReady(true)}
        />
      )}

      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#16171b] via-transparent to-transparent" />

      {/* Only once the player is actually up — a mute button that silently
          drops its postMessage would be worse than no button. */}
      {frameReady && (
        <>
          <button
            type="button"
            onClick={toggleMute}
            aria-label={muted ? t("preview.unmute") : t("preview.mute")}
            title={muted ? t("preview.unmute") : t("preview.mute")}
            className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-colors hover:bg-black/70"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              {muted ? (
                <path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.94 8.94 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z" />
              ) : (
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
              )}
            </svg>
          </button>

          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? t("preview.pause") : t("preview.play")}
            className="absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-200 group-hover/media:opacity-100"
          >
            <span className="grid h-12 w-12 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                {playing ? (
                  <path d="M6 5h4v14H6zm8 0h4v14h-4z" />
                ) : (
                  <path d="M8 5v14l11-7z" />
                )}
              </svg>
            </span>
          </button>
        </>
      )}
    </div>
  );
}
