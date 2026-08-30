import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { PhotoIcon } from "@heroicons/react/24/outline";
import { animeHref, useClickTarget } from "@/lib/prefs/clickTarget";
import { useNavBackdrop } from "@/lib/color/navContrast";
import { watchTime } from "@/lib/profile/sources";
import { plateMode } from "@/lib/profile/types";
import type { BannerOption, ProfileStats } from "@/lib/profile/types";

/**
 * The top of a profile: the plate, the identity, the numbers.
 *
 * The plate is decided upstream (lib/profile/banner.ts + the favourite-anime
 * rule) and arrives resolved; this component only knows the three shapes it can
 * take — an artwork, a blurred cover, or the site's own accent colour when
 * there is no list to draw from. Every profile route renders THIS, so a guest,
 * an AniScroll account and an AniList account look like the same page.
 */

export type HeroBanner = {
  url: string | null;
  animeId: number | null;
  title: string | null;
  /** What kind of art this is — decides page-background vs strip. */
  source?: BannerOption["source"] | null;
  /** The plate is a portrait cover — blur and over-scale it. */
  fallback?: boolean;
};

/**
 * The four numbers under the name, formatted. Lives here rather than in the
 * page so the public profile and /en/profile/me cannot label them differently.
 * A source that doesn't know a figure gets an em dash, never an invented one.
 */
export function heroStats(
  t: (key: string, opts?: any) => string,
  stats: ProfileStats,
): HeroStat[] {
  const time = stats.minutes != null ? watchTime(stats.minutes) : null;
  return [
    { key: "anime", label: t("profile.statAnime"), value: String(stats.count) },
    {
      key: "episodes",
      label: t("profile.statEpisodes"),
      value: String(stats.episodes),
    },
    {
      key: "time",
      label: t("profile.statWatched"),
      value: time?.days
        ? `${time.days}${t("profile.unitDays")}`
        : time?.hours
          ? `${time.hours}${t("profile.unitHours")}`
          : "—",
    },
    {
      key: "mean",
      label: t("profile.statMeanScore"),
      value: stats.meanScore != null ? String(stats.meanScore) : "—",
      accent: true,
    },
  ];
}

export type HeroStat = {
  key: string;
  label: string;
  value: string;
  /** Small line under the value (best streak, score format…). */
  hint?: string;
  /** Painted in the accent instead of white — one highlight, not five. */
  accent?: boolean;
};

type Props = {
  name: string;
  tag?: string | null;
  avatar?: string | null;
  /** Shown as a badge when the account is linked to AniList. */
  anilistName?: string | null;
  /** Epoch ms; renders "member since". */
  createdAt?: number | null;
  banner: HeroBanner;
  stats: HeroStat[];
  isOwner?: boolean;
  onEditBanner?: () => void;
  /** Free-form line under the name (e.g. "local profile, this device only"). */
  subtitle?: string | null;
};

export default function ProfileHero({
  name,
  tag,
  avatar,
  anilistName,
  createdAt,
  banner,
  stats,
  isOwner,
  onEditBanner,
  subtitle,
}: Props) {
  const { t } = useTranslation();
  const clickTarget = useClickTarget();
  /* The navbar floats transparent over this plate, and a profile's artwork is
     picked by its owner — nothing stops it being a white one. Same measurement
     the info page's hero declares (lib/color/navContrast.ts). */
  useNavBackdrop(banner.url);

  /* An illustration is worn as the page's WALLPAPER — fixed to the window, the
     profile scrolling over it. A banner-shaped strip stays a strip: it was
     composed as one, and there is nothing above or below its crop to reveal.
     Stretching one across the window is the "zoom" this measurement exists to
     prevent — a 1000x185 fanart banner loses 62% of itself that way.

     The declared source is only the FIRST guess, used so the first paint is not
     a guess-free blank: it is a label, and labels go stale. A banner pinned
     before the kind was stored alongside the URL comes back as "background" and
     would be worn as a wallpaper. The picture's own proportions cannot go
     stale, so once it has loaded they decide. Nothing is downloaded twice —
     next/image has already fetched this exact URL, so the probe reads the cache. */
  const [ratio, setRatio] = useState<number | null>(null);
  useEffect(() => {
    setRatio(null);
    if (!banner.url) return;
    const probe = new window.Image();
    probe.onload = () => {
      if (probe.naturalHeight) setRatio(probe.naturalWidth / probe.naturalHeight);
    };
    probe.src = banner.url;
  }, [banner.url]);

  const mode = !banner.url
    ? "none"
    : banner.fallback
      ? "page" /* a portrait cover: blurred wallpaper, never a strip */
      : ratio == null
        ? plateMode(banner.source)
        : ratio > 3
          ? "band"
          : "page";
  const asPage = mode === "page";

  /* A strip is shown WHOLE or it is not shown honestly. Guessing its shape is
     how the last crop happened: the band was cut to 4.75:1, the ratio AniList
     authors its own banners in, and a 1000x185 fanart banner (5.4:1) still lost
     its edges to `object-cover`. Since the picture has already been measured,
     the band simply takes the picture's own proportions and there is nothing
     left to crop. Capped, because a very long strip on a narrow window would
     otherwise be a hairline; `object-contain` then letterboxes rather than
     cuts, which is the whole point. */
  const bandStyle =
    !asPage && ratio
      ? { height: `min(calc(100vw / ${ratio.toFixed(3)}), 46vh)` }
      : undefined;

  /* A strip carries a composition — a logo, a character, a title — and the
     avatar and the name were landing right on top of it: exactly the picture we
     had just gone to the trouble of not cropping. So under a strip the identity
     steps OFF it and sits below, the avatar overlapping the edge just enough to
     tie the two together. Over a wallpaper it stays where it was: there, being
     read on the picture IS the design, and the artwork has room to spare. */
  const onArtwork = mode !== "band";

  const identity = (
    <div className="mx-auto flex w-full max-w-screen-lg items-end gap-4 px-4 pb-5 md:gap-6 md:pb-7">
      <div className="shrink-0 rounded-[1.35rem] bg-gradient-to-br from-as-accent to-as-accent2 p-[3px] shadow-glow">
        {avatar ? (
          <Image
            src={avatar}
            alt={name}
            width={128}
            height={128}
            priority
            className="h-20 w-20 rounded-[1.2rem] object-cover md:h-28 md:w-28"
          />
        ) : (
          <div className="flex h-20 w-20 items-center justify-center rounded-[1.2rem] bg-primary text-3xl font-bold text-white/80 md:h-28 md:w-28 md:text-4xl">
            {name.charAt(0).toUpperCase()}
          </div>
        )}
      </div>

      <div className="min-w-0 pb-1">
        {/* The name can overlap a plate that is anything at all: the shadow is
            what keeps it readable over a bright artwork. */}
        <h1
          className="truncate font-outfit text-3xl font-bold leading-tight md:text-5xl"
          style={{ textShadow: "0 2px 18px rgba(0,0,0,0.75)" }}
        >
          {name}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
          {tag ? (
            <span className="rounded-md bg-black/40 px-2 py-1 font-mono text-white/60 ring-1 ring-white/10 backdrop-blur-sm">
              #{tag}
            </span>
          ) : null}
          {anilistName ? (
            <a
              href={`https://anilist.co/user/${anilistName}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-md bg-[#02a9ff]/20 px-2 py-1 font-bold text-[#5ac8ff] ring-1 ring-[#02a9ff]/30 backdrop-blur-sm transition-colors hover:bg-[#02a9ff]/30"
            >
              AniList · {anilistName}
            </a>
          ) : null}
          {createdAt ? (
            <span className="px-1 py-1 text-white/50">
              {t("profile.memberSince", {
                date: new Date(createdAt).toLocaleDateString(undefined, {
                  month: "long",
                  year: "numeric",
                }),
              })}
            </span>
          ) : null}
        </div>
        {subtitle ? <p className="mt-1 text-xs text-white/50">{subtitle}</p> : null}
      </div>
    </div>
  );

  return (
    <div className="relative w-full">
      {asPage ? (
        <div className="as-page-plate">
          {/* Two copies of the ONE picture, and no second request: the sharp one
              is `contain`, so the artwork is shown entire — cropping it was the
              whole complaint — and the blurred one underneath fills the bars
              that leaves. An empty letterbox would announce that the picture
              does not fit; this way the frame is made of the picture itself. */}
          <Image
            src={banner.url as string}
            alt=""
            fill
            priority
            sizes="100vw"
            className="as-page-fill"
          />
          <Image
            src={banner.url as string}
            alt=""
            fill
            priority
            sizes="100vw"
            className="object-contain"
          />
          <div className="as-page-scrim" />
        </div>
      ) : null}

      <header className="relative z-10 w-full">
      <div
        className={`relative w-full overflow-hidden ${
          asPage ? "as-hero-band" : "as-hero-band-slim"
        }`}
        style={bandStyle}
      >
        {!asPage && banner.url ? (
          <Image
            src={banner.url}
            alt=""
            fill
            priority
            sizes="100vw"
            className={ratio ? "object-contain" : "object-cover"}
          />
        ) : null}
        {!banner.url ? (
          /* No list, no artwork: the site's own colour. */
          <div className="absolute inset-0 as-hero-default as-hero-weave" />
        ) : null}

        {/* The heavy scrim exists to make a name readable over a plate, so it
            belongs only where a name is: on the flat-colour plate. A wallpaper
            carries its own (as-page-scrim), and a strip no longer has anything
            written on it — darkening its lower third into black would just be
            damaging the artwork for nothing. It gets a foot fade instead, to
            meet the page. */}
        {mode === "none" ? <div className="as-hero-scrim absolute inset-0" /> : null}
        {mode === "band" ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 as-strip-foot" />
        ) : null}
        <div className="pointer-events-none absolute inset-x-0 -bottom-24 h-48 as-hero-glow" />

        {/* Where the plate comes from — and, for the owner, the way to change
            it. Pinned under the navbar so it never crowds the name below. */}
        <div className="absolute right-3 top-[4.75rem] z-10 flex flex-wrap items-center justify-end gap-2 md:right-6">
          {banner.title && banner.animeId ? (
            <Link
              href={animeHref(banner.animeId, clickTarget)}
              className="rounded-full bg-black/45 px-3 py-1.5 text-[11px] font-medium text-white/75 ring-1 ring-white/10 backdrop-blur-md transition-colors hover:bg-black/70 hover:text-white"
            >
              {t("profile.bannerFrom", { title: banner.title })}
            </Link>
          ) : null}
          {isOwner && onEditBanner ? (
            <button
              type="button"
              onClick={onEditBanner}
              className="inline-flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-1.5 text-[11px] font-bold text-white/85 ring-1 ring-white/15 backdrop-blur-md transition-colors hover:bg-action hover:text-white hover:ring-action"
            >
              <PhotoIcon className="h-4 w-4" />
              {t("profile.changeBanner")}
            </button>
          ) : null}
        </div>

        {/* On a wallpaper, the identity is read on the picture. */}
        {onArtwork ? (
          <div className="absolute inset-x-0 bottom-0 z-10">{identity}</div>
        ) : null}
      </div>

      {/* Under a strip: below it, the avatar overlapping the edge. */}
      {!onArtwork ? (
        <div className="relative z-10 -mt-12 md:-mt-14">{identity}</div>
      ) : null}

      {stats.length > 0 ? (
        <dl className="mx-auto mt-5 grid w-full max-w-screen-lg grid-cols-2 gap-2.5 px-4 sm:grid-cols-4 md:gap-3">
          {stats.map((s) => (
            <div
              key={s.key}
              className="as-stat-card rounded-xl px-3.5 py-3 ring-1 ring-white/10"
            >
              <dt className="text-[10px] font-bold uppercase tracking-wider text-white/40">
                {s.label}
              </dt>
              <dd
                className={`mt-0.5 font-outfit text-2xl font-bold leading-none ${
                  s.accent ? "text-action" : "text-white"
                }`}
              >
                {s.value}
              </dd>
              {s.hint ? (
                <p className="mt-1 text-[10px] text-white/35">{s.hint}</p>
              ) : null}
            </div>
          ))}
        </dl>
      ) : null}

      {/* Wallpaper mode ends on a fade into the page's own colour, drawn here —
          in the flow — so it stays glued to the top of the list instead of to
          the window the picture is pinned to. */}
      {asPage ? <div className="as-page-seam mt-6" /> : null}
      </header>
    </div>
  );
}
