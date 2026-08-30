import Image from "next/image";
import Link from "next/link";
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

  /* An illustration is worn as the page's BACKGROUND — the profile is read on
     top of the picture. A banner-shaped strip stays a strip: it was composed as
     one, and there is nothing above or below its crop to reveal. */
  const mode = banner.url ? plateMode(banner.source) : "none";
  const asPage = mode === "page";

  return (
    <>
      {asPage ? (
        <div className="as-page-plate">
          <Image
            src={banner.url as string}
            alt=""
            fill
            priority
            sizes="100vw"
            className={`object-cover ${banner.fallback ? "as-hero-cover" : ""}`}
          />
          <div className="as-page-scrim" />
        </div>
      ) : null}

      <header className="relative z-10 w-full">
      <div
        className={`relative w-full overflow-hidden ${
          asPage ? "as-hero-band" : "as-hero-band-slim"
        }`}
      >
        {!asPage && banner.url ? (
          <Image
            src={banner.url}
            alt=""
            fill
            priority
            sizes="100vw"
            className="object-cover"
          />
        ) : null}
        {!banner.url ? (
          /* No list, no artwork: the site's own colour. */
          <div className="absolute inset-0 as-hero-default as-hero-weave" />
        ) : null}

        {/* The band's own scrim, weighted to the bottom so the name reads. In
            page-background mode the plate carries its own (as-page-scrim) and
            this one would double it. */}
        {!asPage ? <div className="as-hero-scrim absolute inset-0" /> : null}
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

        {/* The identity sits ON the artwork, at its foot. */}
        <div className="absolute inset-x-0 bottom-0 z-10">
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
              {/* The name overlaps the plate, which can be anything: the shadow
                  is what keeps it readable over a bright artwork. */}
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
              {subtitle ? (
                <p className="mt-1 text-xs text-white/50">{subtitle}</p>
              ) : null}
            </div>
          </div>
        </div>
      </div>

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
      </header>
    </>
  );
}
