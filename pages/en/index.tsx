import { aniListData, aniListHomepageBatch } from "@/lib/anilist/AniList";
import { useState, useEffect, Fragment } from "react";
import Head from "next/head";
import Link from "next/link";
import Footer from "@/components/shared/footer";
import Image from "next/image";
import Content from "@/components/home/content";
import CarouselSkeleton from "@/components/home/CarouselSkeleton";
import { useTranslation } from "react-i18next";
import { useTranslatedText, prefetchTranslations } from "@/lib/i18n/useTranslatedText";

import { motion, AnimatePresence } from "framer-motion";

import { signOut, useSession } from "next-auth/react";
import Genres from "@/components/home/genres";
import Schedule from "@/components/home/schedule";
import getUpcomingAnime from "@/lib/anilist/getUpcomingAnime";

import GetMedia from "@/lib/anilist/getMedia";
import MobileNav from "@/components/shared/MobileNav";
import { getGreetingKey } from "@/utils/getGreetings";
import { redis } from "@/lib/redis";
import { Navbar } from "@/components/shared/NavBar";
import { useRouter } from "next/router";
import { loadFanarts } from "@/lib/db/fanarts";
import {
  pickHeroLogo,
  tmdbTitleImage,
  TitleImage,
} from "@/components/anime/v2/helpers";
import { getTmdbAnimeImages } from "@/lib/tmdb/animeImages";
import { useFanartSrc, onFanartError } from "@/lib/images/fanartFallback";

/* Which titles get the hero, and in what order — Hayase's algorithm
   (hayase-app/interface, src/lib/components/ui/banner/full-banner.svelte,
   `shuffleAndFilter`), extended from their 5 slots to our 8.

   TWO HALVES, and the pool matters more than the sort. The pool is built by
   `heroPool` in lib/anilist/AniList.js — the CURRENT SEASON's best-scored
   titles, which is Hayase's own query, not the trending list. Ranking the
   trending list is what kept One Piece and Bleach welded to the front; they
   are permanently trending and never leave. Scoping to the season is what
   actually rotates the hero, because the season itself rotates.

   Then the sort: a Knuth multiplicative hash of the id
   (`id * 2654435761 >>> 0`, the 32-bit golden-ratio constant). A stable
   pseudo-random permutation — unrelated to score, identical for every visitor
   and every render, so a title ranked 12th by score can open the carousel.
   Verified 2026-08-08 against Hayase's live output: with this pool and this
   sort, THE GHOST IN THE SHELL (AniList 177699) lands first, exactly as it
   does in their app.

   Determinism is the point, not a limitation — SSR and hydration must agree,
   and a `Math.random()` order would swap the hero under the visitor's cursor
   on every re-render.

   `id * 2654435761` reaches ~5.6e14 for a 6-digit AniList id — comfortably
   inside 2^53, so the multiplication is exact before `>>> 0` folds it to
   uint32. No overflow to guard against.

   The `bannerImage ?? trailer?.id` filter is theirs too: an entry with neither
   has no artwork to put behind the hero. Our homepage query doesn't request
   `trailer`, so today it reads as "has a banner" — kept in full so it stays
   correct if that field is ever added. NOT_YET_RELEASED is our own filter and
   stays: a "BIENTÔT" entry in the hero can't be watched, and the dedicated
   Upcoming section is where those belong. */
const HERO_SLOTS = 8;

function heroHash(id: number): number {
  return (id * 2654435761) >>> 0;
}

export function pickHeroRotation(items: any[]): any[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((it) => it?.status !== "NOT_YET_RELEASED")
    .filter((it) => it?.bannerImage ?? it?.trailer?.id)
    .slice()
    .sort((a, b) => heroHash(Number(a?.id)) - heroHash(Number(b?.id)))
    .slice(0, HERO_SLOTS);
}

export async function getServerSideProps(ctx: any) {
  // Edge-cache the home page aggressively. The response is identical for
  // every visitor (anonymous AND logged-in — the personalised carousels
  // hydrate client-side, the SSR'd content is trending/popular/genre
  // which is anonymous data). Split headers so browsers keep a short
  // cache (1 min — fresh on hard refresh) while Vercel's edge holds it
  // for 2 h + 24 h stale-while-revalidate. Trending/popular only really
  // shifts once a day so 2 h fresh is plenty.
  ctx?.res?.setHeader?.("Cache-Control", "public, max-age=60");
  ctx?.res?.setHeader?.(
    "CDN-Cache-Control",
    "public, s-maxage=7200, stale-while-revalidate=86400",
  );
  let cachedData;

  // A dead/unreachable Redis (e.g. a rotated REDIS_URL an older deployment
  // never picked up) must NOT take the whole homepage down — swallow the error
  // and treat it as a cache miss so we fall through to a live AniList fetch.
  if (redis) {
    cachedData = await redis.get("index_server_v3").catch(() => null);
  }

  // Resolve the hero entries (HD logo for the top trending titles) outside
  // the Redis branch — fanart is cheap (single Turso row each) and keeping
  // it out of the homepage cache lets us swap in new logos as fanart
  // entries are reviewed without waiting 2 h for the cache to expire.
  // We deliberately pull LOGO only (pickHeroLogo) — clearart character
  // cut-outs fight the banner behind them; the stylised title text reads
  // cleanly on top of any background.
  const resolveHeroEntries = async (
    items: any[],
  ): Promise<Array<HeroEntry>> => {
    if (!Array.isArray(items)) return [];
    const slice = pickHeroRotation(items);
    return Promise.all(
      slice.map(async (it) => {
        const id = Number(it?.id);
        // Both are per-title lookups with their own cache, so run them
        // together rather than serially: fanart is one Turso row, TMDB is one
        // Turso row warm / one HTTP call cold (30-day TTL).
        const [fanarts, tmdb] = await Promise.all([
          loadFanarts(id).catch(() => null),
          getTmdbAnimeImages(id).catch(() => ({ backdrop: null, logo: null })),
        ]);
        return {
          id: it?.id,
          title: it?.title || { english: null, romaji: null },
          coverImage: it?.coverImage || null,
          // TMDB backdrop FIRST — this is the whole point of the integration.
          // AniList's bannerImage is a 1900×400 letterbox crop the 21:9 hero
          // has to stretch; a TMDB backdrop is native 1280×720 key art.
          bannerImage: tmdb.backdrop || it?.bannerImage || null,
          description: it?.description || "",
          status: it?.status || null,
          /* TMDB logo FIRST, fanart.tv behind it (user decision, 2026-08-08).
             I had it the other way round and argued for it — fanart.tv is
             NSFW-filtered, likes-ranked and edge-cached — but that reasoning
             was about delivery, not about the image. Hayase renders TMDB's
             logo, this hero is a copy of theirs, and the two must match.
             fanart.tv still covers everything TMDB has no logo for, which is
             a lot, so nothing is lost by demoting it to second. */
          titleImage: tmdbTitleImage(tmdb.logo) ?? pickHeroLogo(fanarts),
        };
      }),
    );
  };

  // First trending entry that has actually aired — used for the hero's initial
  // banner / "Watch" button so it never lands on a not-yet-released title.
  const pickFirstTrend = (items: any[]): any =>
    (Array.isArray(items)
      ? items.find((it) => it?.status !== "NOT_YET_RELEASED")
      : null) ||
    (Array.isArray(items) ? items[0] : null) ||
    null;

  if (cachedData) {
    const { genre, detail, populars, thisSeason, movies, heroPool } =
      JSON.parse(cachedData);
    const firstTrend = pickFirstTrend(detail?.data || []);
    const [upComing, heroEntries] = await Promise.all([
      getUpcomingAnime(),
      /* `?? detail` is a safety net, not a design: a blob written by an older
         deploy has no `heroPool`, and a hero of trending titles beats no hero
         at all for the few minutes before the key bump takes effect. */
      resolveHeroEntries(heroPool?.data || detail?.data || []),
    ]);
    return {
      props: {
        genre,
        detail,
        populars,
        upComing,
        firstTrend,
        heroEntries,
        thisSeason: thisSeason || null,
        movies: movies || null,
      },
    };
  } else {
    // Single batched GraphQL request fetches trending+popular+genre+season+
    // movies in ONE AniList token cost.
    const [batch, upComing] = await Promise.all([
      aniListHomepageBatch(),
      Promise.race([
        getUpcomingAnime().catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
      ]),
    ]);
    const trendingDetail = batch.trending;
    const popularDetail = batch.popular;
    const genreDetail = batch.genre;
    const seasonDetail = batch.thisSeason;
    const moviesDetail = batch.movies;

    if (redis) {
      // Best-effort cache write — a failing Redis must not crash SSR.
      await redis
        .set(
          /* Key bumped whenever the payload gains a field the page reads.
             v2 → v3 (2026-08-08): `heroPool` joined it. A v2 blob has no such
             key, so the hero would silently keep falling back to trending for
             up to 2 h — the same "cache outlives the change" trap already hit
             three times today (TMDB artwork, episode lists, discover). */
          "index_server_v3",
          JSON.stringify({
            genre: genreDetail.props,
            detail: trendingDetail.props,
            populars: popularDetail.props,
            firstTrend: trendingDetail.props.data?.[0] || null,
            thisSeason: seasonDetail.props,
            movies: moviesDetail.props,
            heroPool: batch.heroPool?.props ?? null,
          }), // set cache for 2 hours
          "EX",
          60 * 60 * 2
        )
        .catch(() => {});
    }

    const heroEntries = await resolveHeroEntries(
      batch.heroPool?.props?.data || trendingDetail.props.data || [],
    );

    return {
      props: {
        genre: genreDetail.props,
        detail: trendingDetail.props,
        populars: popularDetail.props,
        upComing,
        firstTrend: pickFirstTrend(trendingDetail.props.data || []),
        heroEntries,
        thisSeason: seasonDetail.props,
        movies: moviesDetail.props,
      },
    };
  }
}

type HeroEntry = {
  id: number;
  title: { english: string | null; romaji: string | null };
  coverImage: { extraLarge?: string; color?: string } | null;
  bannerImage: string | null;
  description: string;
  status: string | null;
  titleImage: TitleImage | null;
};

type HomeProps = {
  genre: any;
  detail: any;
  populars: any;
  upComing: any;
  firstTrend: any;
  heroEntries: HeroEntry[];
  thisSeason: any;
  movies: any;
};

/* ── Cinematic hero ──────────────────────────────────────────────────
   Full-bleed banner background, HD logo overlay (clearart deliberately
   excluded — see pickHeroLogo), side preview thumbnails of the next four
   trending titles, and large edge arrows for manual navigation. Hovering
   pauses the 8 s auto-advance; clicking a side thumb or an arrow swaps
   focus. The whole block fades into the page below via a tall bottom
   gradient so there's no visible seam.
   Hidden < lg so phones keep their lighter layout below.                */
const HERO_AUTO_INTERVAL_MS = 8000;
const STATUS_TAG: Record<string, { labelKey: string; dot: string }> = {
  RELEASING: { labelKey: "home.tagAiring", dot: "bg-emerald-400" },
  FINISHED: { labelKey: "home.tagFinished", dot: "bg-zinc-400" },
  NOT_YET_RELEASED: { labelKey: "home.tagSoon", dot: "bg-sky-400" },
  CANCELLED: { labelKey: "home.tagCancelled", dot: "bg-red-400" },
  HIATUS: { labelKey: "home.tagHiatus", dot: "bg-amber-400" },
};

function HeroBanner({
  entries,
  firstTrend,
  onPlay,
  stripDescription,
}: {
  entries: HeroEntry[];
  firstTrend: any;
  onPlay: (id: number) => void;
  stripDescription: (s: string) => string;
}) {
  const { t, i18n } = useTranslation();
  // Stable list: SSR-provided entries, falling back to a single entry
  // synthesised from firstTrend when the fanart fetch returned empty.
  const list: HeroEntry[] =
    entries && entries.length > 0
      ? entries
      : firstTrend
        ? [
            {
              id: firstTrend.id,
              title: firstTrend.title,
              coverImage: firstTrend.coverImage,
              bannerImage: firstTrend.bannerImage || null,
              description: firstTrend.description || "",
              status: firstTrend.status || null,
              titleImage: null,
            },
          ]
        : [];

  const [idx, setIdx] = useState(0);
  // `dir` drives the slide direction of the entrance animation so manual
  // prev/next feel directional (content slides in from the side you came
  // from) while the auto-advance always slides left→right.
  const [dir, setDir] = useState(1);

  const go = (next: number, direction: number) => {
    setDir(direction);
    setIdx(((next % list.length) + list.length) % list.length);
  };
  const prev = () => go(idx - 1, -1);
  const next = () => go(idx + 1, 1);

  // Auto-advance. `idx` is in the deps so the timer restarts from zero
  // whenever the slide changes — manual prev/next/dot clicks included —
  // keeping the cadence in sync with the progress-pill fill animation
  // (which also restarts each slide). We deliberately do NOT pause on
  // hover: the hero fills the viewport, so the cursor sits over it almost
  // permanently and a hover-pause would freeze the carousel for good.
  useEffect(() => {
    if (list.length < 2) return;
    const t = window.setTimeout(() => {
      setDir(1);
      setIdx((i) => (i + 1) % list.length);
    }, HERO_AUTO_INTERVAL_MS);
    return () => window.clearTimeout(t);
  }, [list.length, idx]);

  // Pre-translate EVERY carousel synopsis up front (the moment the list +
  // language are known), in parallel, so by the time the carousel auto-
  // advances to each slide its French text is already cached and renders
  // with zero English flash. Fire-and-forget; results land in the shared
  // translation cache that useTranslatedText reads from.
  useEffect(() => {
    if (!list.length || i18n.language === "en") return;
    prefetchTranslations(
      list.map((e) => stripDescription(e.description || "")),
      i18n.language,
    );
  }, [list, i18n.language, stripDescription]);

  // Compute the active entry's synopsis BEFORE any early return so the
  // translation hook is always called in the same order (rules-of-hooks).
  // Guarded against an empty list (the early return below handles render).
  const safeActive = list.length ? list[idx % list.length] : null;
  const localizedDescription = useTranslatedText(
    safeActive ? stripDescription(safeActive.description || "") : "",
  );
  // Same rules-of-hooks discipline: call useFanartSrc BEFORE the early return,
  // off the guarded `safeActive`, so the hook order is stable across renders.
  // Hydration-safe: proxy URL on SSR + first client render, swaps to origin
  // after mount when the CF quota is flagged exhausted.
  const heroLogoSrc = useFanartSrc(safeActive?.titleImage?.url);

  if (list.length === 0) return null;
  const activeIdx = idx % list.length;
  const active = list[activeIdx];
  // Rail order: the CURRENTLY-FEATURED anime's cover first, then the rest
  // following the cycle order (wrap-around). Up to 5 thumbnails fit the
  // right rail without overflowing; the dots below still represent all 8.
  const RAIL_COUNT = Math.min(list.length, 5);
  const railEntries = Array.from(
    { length: RAIL_COUNT },
    (_, k) => list[(activeIdx + k) % list.length],
  );

  const title =
    active.title?.english || active.title?.romaji || "Untitled";
  const statusInfo = active.status ? STATUS_TAG[active.status] : null;
  // Fall back to coverImage when there's no banner (rare for top trending
  // but happens on brand-new entries). Cover stretched is uglier but still
  // gives us something to layer the gradient on.
  const bg = active.bannerImage || active.coverImage?.extraLarge || null;
  const accent = active.coverImage?.color || "#E94560";

  return (
    <div className="hidden lg:block relative w-full overflow-hidden">
      {/* +100px taller than before (was max-h 680). The extra height plus
          the tall bottom gradient lets the artwork breathe and dissolve
          into the page. */}
      <div className="relative aspect-[21/9] max-h-[780px] min-h-[520px] w-full">
        {/* Background banner. Keyed on the entry id so React swaps the
            <img> cleanly; framer-motion cross-fades + slow Ken-Burns zoom. */}
        <AnimatePresence mode="popLayout">
          <motion.div
            key={`bg-${active.id}`}
            // Opacity-only crossfade. The previous 8 s Ken-Burns `scale`
            // animation ran continuously behind ~6 backdrop-blur layers
            // (badges, buttons, pills) — every animated frame forced the
            // browser to recompute all those blurs, which is what made the
            // hero stutter badly on first load (before images/layers were
            // warm). A static background lets the blurs composite once.
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.8 }}
            className="absolute inset-0"
          >
            {bg ? (
              <Image
                src={bg}
                alt=""
                fill
                priority={idx === 0}
                sizes="100vw"
                quality={90}
                className="object-cover object-center"
              />
            ) : (
              <div
                className="absolute inset-0"
                style={{ backgroundColor: accent }}
              />
            )}
          </motion.div>
        </AnimatePresence>

        {/* Cinematic gradients. Left fade boosts text contrast on the
            logo + CTA stack. */}
        <div className="absolute inset-0 bg-gradient-to-r from-primary via-primary/55 to-transparent" />
        {/* Tall bottom fade — the seam-killer. Uses EXPLICIT primary
            (#0c0d10) colour stops, not pure black, so it melts into the
            identically-coloured page below with no visible line. The
            bottom 20% is solid primary across the FULL width (both edges),
            then fades up — identical left and right, no asymmetric dark
            patch (the old bottom-left black vignette caused that). */}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[70%]"
          style={{
            backgroundImage:
              "linear-gradient(to top, #0c0d10 0%, #0c0d10 20%, rgba(12,13,16,0.65) 48%, rgba(12,13,16,0) 100%)",
          }}
        />

        {/* Content column */}
        <div className="absolute inset-0 flex">
          {/* justify-END, not justify-between: the whole block (logo, tags,
              synopsis, CTAs) sits at the BOTTOM of the hero, immediately above
              the progress pills, with `gap-5` as the only space between them.

              justify-between pinned the logo under the navbar and let the
              column's height push everything apart, which left a large dead
              band across the middle of a 780px-tall hero and detached the text
              from its controls. Packing to the bottom also lines the block up
              with the cover rail on the right, which is bottom-anchored too
              (both still share pb-24).

              pt-16 stays as a floor, not as a position: it only matters when a
              very long synopsis would otherwise grow up under the navbar. */}
          <div className="flex w-full xl:w-[60%] lg:w-[65%] flex-col justify-end gap-5 pt-16 pb-24 pl-[7%] pr-8">
            <AnimatePresence mode="wait" custom={dir}>
              <motion.div
                key={`stack-${active.id}`}
                custom={dir}
                variants={{
                  enter: (d: number) => ({ opacity: 0, x: d * 40 }),
                  center: { opacity: 1, x: 0 },
                  exit: (d: number) => ({ opacity: 0, x: d * -40 }),
                }}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.45, ease: "easeOut" }}
                className="flex flex-col gap-5"
              >
                {/* HD logo (stylised title text). Falls back to a styled
                    <h1> when no logo fanart is available. */}
                {active.titleImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={heroLogoSrc}
                    alt={title}
                    width={680}
                    height={280}
                    /* CF transformation quota exhausted → proxied URL 429/502s
                       → fall back to the original fanart.tv file. */
                    onError={onFanartError}
                    /* Plain <img>, NOT next/image: with `priority` next/image
                       injects a <link rel=preload as=image> pinned to this
                       src. When onError swaps the src to assets.fanart.tv the
                       preload goes unconsumed → Chrome's "preloaded but not
                       used" warning. loading=eager + fetchPriority=high give
                       the same first-paint priority with no auto-preload. */
                    loading={idx === 0 ? "eager" : "lazy"}
                    // @ts-expect-error fetchPriority not in lib.dom yet
                    fetchpriority={idx === 0 ? "high" : undefined}
                    decoding="async"
                    className="h-auto w-auto max-h-[200px] max-w-[68%] object-contain object-left drop-shadow-[0_10px_30px_rgba(0,0,0,0.7)]"
                  />
                ) : (
                  <h1 className="font-outfit font-extrabold text-white text-5xl xl:text-6xl leading-[1.05] max-w-[85%] drop-shadow-[0_4px_16px_rgba(0,0,0,0.7)]">
                    {title}
                  </h1>
                )}

                {/* Metadata row */}
                <div className="flex items-center gap-2.5 flex-wrap">
                  {statusInfo && (
                    <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-karla font-semibold tracking-wider text-white/90 backdrop-blur-sm border border-white/10">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${statusInfo.dot}`}
                      />
                      {t(statusInfo.labelKey)}
                    </span>
                  )}
                  <span className="rounded-full bg-action/20 px-3 py-1 text-xs font-karla font-semibold tracking-wider text-action border border-action/40 backdrop-blur-sm">
                    {t("home.trending")} #{idx + 1}
                  </span>
                </div>

                {/* Description (2 lines) */}
                <p className="font-roboto font-light text-base xl:text-lg line-clamp-2 max-w-[88%] text-white/80">
                  {localizedDescription}
                </p>

                {/* CTAs + progress bar share a w-fit column so the bar
                    below the buttons is exactly as wide as the button row
                    (w-full on the bar = the column's content width = the
                    CTA row). Both live inside the per-slide motion stack so
                    the active pill remounts fresh each slide → the fill
                    animation restarts cleanly and the pills never vanish. */}
                <div className="flex flex-col gap-3 mt-2 w-fit">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => onPlay(active.id)}
                      className="inline-flex items-center gap-2 rounded-full bg-action px-7 py-3 font-karla font-semibold text-white text-sm tracking-wider shadow-lg shadow-action/40 outline-none focus:outline-none focus-visible:outline-none transition-all hover:bg-action/90 hover:scale-[1.03]"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        className="h-8 w-8"
                      >
                        <path d="M8 5v14l11-7z" />
                      </svg>
                      {t("anime.watchNowCta")}
                    </button>
                    <Link
                      href={`/en/anime/${active.id}`}
                      className="inline-flex items-center gap-2 rounded-full bg-white/10 px-7 py-3 font-karla font-semibold text-white text-sm tracking-wider border border-white/15 backdrop-blur-sm outline-none focus:outline-none focus-visible:outline-none transition-colors hover:bg-white/20"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        className="h-8 w-8"
                      >
                        <path d="M11 17h2v-6h-2v6zm1-15C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zM11 9h2V7h-2v2z" />
                      </svg>
                      {t("anime.moreInfoCta")}
                    </Link>
                  </div>

                </div>
              </motion.div>
            </AnimatePresence>

            {/* Segmented progress bar — outside AnimatePresence so it
                stays mounted across slide transitions. w-fit matches the
                CTA button row; flex-1 pills distribute evenly. Last child of
                a justify-end column, so it sits at the very bottom with the
                info block resting directly on top of it, and its bottom edge
                still aligns with the cover thumbnails on the right rail
                (both share pb-24). */}
            <div className="flex w-fit gap-2">
              {list.map((_, i) => {
                const isActive = i === idx % list.length;
                return (
                  <button
                    key={i}
                    type="button"
                    aria-label={`Go to trending ${i + 1}`}
                    onClick={() => go(i, i > idx ? 1 : -1)}
                    className={`relative h-1.5 w-12 overflow-hidden rounded-full transition-all ${
                      isActive ? "bg-white/20" : "bg-white/30 hover:bg-white/50"
                    }`}
                  >
                    {isActive && (
                      <span
                        className="absolute inset-y-0 left-0 w-full rounded-full bg-action"
                        style={{
                          transformOrigin: "left",
                          transform: list.length > 1 ? "scaleX(0)" : "scaleX(1)",
                          animation:
                            list.length > 1
                              ? `heroProgress ${HERO_AUTO_INTERVAL_MS}ms linear forwards`
                              : undefined,
                        }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right rail — side preview thumbnails with the prev/next
              arrows sitting to their LEFT. Anchored to the lower right
              above the bottom gradient. Clicking a thumb jumps focus in
              the natural direction (right = forward). */}
          <div className="hidden lg:flex w-[35%] xl:w-[40%] flex-col items-end justify-end pb-24 pr-[5%]">
            {railEntries.length > 0 && (
              <div className="flex items-center gap-3">
                {/* Prev / next arrows — stacked to the left of the covers. */}
                {list.length > 1 && (
                  <div className="z-20 flex flex-col gap-2">
                    <button
                      type="button"
                      aria-label="Previous trending"
                      onClick={prev}
                      className="grid h-10 w-10 place-items-center rounded-full bg-black/40 text-white backdrop-blur-md outline-none focus:outline-none transition-all hover:bg-action hover:scale-110"
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6">
                        <path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      aria-label="Next trending"
                      onClick={next}
                      className="grid h-10 w-10 place-items-center rounded-full bg-black/40 text-white backdrop-blur-md outline-none focus:outline-none transition-all hover:bg-action hover:scale-110"
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6">
                        <path d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
                      </svg>
                    </button>
                  </div>
                )}
                {railEntries.map((e, k) => {
                  // k === 0 is the currently-featured anime (shown first per
                  // request) — highlight it with an action-coloured ring.
                  const realIdx = (activeIdx + k) % list.length;
                  const isCurrent = k === 0;
                  return (
                    <button
                      key={`${e.id}-${k}`}
                      type="button"
                      onClick={() => go(realIdx, k === 0 ? 0 : 1)}
                      className={`group relative h-[180px] w-[126px] shrink-0 overflow-hidden rounded-xl shadow-xl outline-none focus:outline-none transition-all duration-300 hover:scale-[1.06] ${
                        isCurrent
                          ? "border-2 border-action"
                          : "border border-white/10 hover:border-action/60"
                      }`}
                    >
                      {e.coverImage?.extraLarge ? (
                        <Image
                          src={e.coverImage.extraLarge}
                          alt={
                            e.title?.english ||
                            e.title?.romaji ||
                            "thumbnail"
                          }
                          fill
                          sizes="126px"
                          className="object-cover transition-transform duration-500 group-hover:scale-110"
                        />
                      ) : (
                        <div className="absolute inset-0 bg-white/5" />
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-transparent" />
                      <div className="absolute inset-x-0 bottom-0 p-2.5">
                        <span className="block truncate text-[11px] font-karla font-semibold text-white">
                          {e.title?.english || e.title?.romaji || ""}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export interface SessionTypes {
  name: string;
  picture: Picture;
  sub: string;
  token: string;
  id: number;
  image: Image;
  list: string[];
  version: string;
  iat: number;
  exp: number;
  jti: string;
}

interface Picture {
  large: string;
  medium: string;
}

interface Image {
  large: string;
  medium: string;
}

export default function Home({
  detail,
  populars,
  upComing,
  firstTrend,
  heroEntries,
  thisSeason,
  movies,
}: HomeProps) {
  const { data: sessions }: any = useSession();
  const userSession: SessionTypes = sessions?.user;
  const { t } = useTranslation();

  const {
    anime: currentAnime,
    recommendations,
    loading: currentLoading,
  }: {
    anime: CurrentMediaTypes[];
    recommendations: CurrentMediaTypes[];
    loading: boolean;
  } = GetMedia(sessions, {
    stats: "CURRENT",
  });
  const { anime: plan, loading: planLoading }: { anime: CurrentMediaTypes[]; loading: boolean } =
    GetMedia(sessions, {
      stats: "PLANNING",
    });
  const { anime: release, loading: releaseLoading } = GetMedia(sessions);

  const router = useRouter();

  const [schedules, setSchedules] = useState(null);
  const [anime, setAnime] = useState([]);

  const [recentAdded, setRecentAdded] = useState([]);

  async function getRecent() {
    const data = await fetch(`/api/v2/etc/recent/1`)
      .then((res) => res.json())
      .catch((err) => console.log(err));

    setRecentAdded(data?.results);
  }

  useEffect(() => {
    if (userSession?.version) {
      if (userSession?.version !== "1.0.1") {
        signOut({ redirect: true });
      }
    }
  }, [userSession?.version]);

  useEffect(() => {
    getRecent();
  }, []);

  const update = () => {
    setAnime((prevAnime) => prevAnime.slice(1));
  };

  useEffect(() => {
    if (upComing && upComing.length > 0) {
      setAnime(upComing);
    }
  }, [upComing]);

  const [releaseData, setReleaseData] = useState<any[]>([]);

  useEffect(() => {
    function getRelease() {
      let releasingAnime: any[] = [];
      let progress: any[] = [];
      let seenIds = new Set<number>(); // Create a Set to store the IDs of seen anime
      (release as any[]).forEach((list: any) => {
        list.entries.forEach((entry: any) => {
          if (
            entry.media.status === "RELEASING" &&
            !seenIds.has(entry.media.id)
          ) {
            releasingAnime.push(entry.media);
            seenIds.add(entry.media.id); // Add the ID to the Set
          }
          progress.push(entry);
        });
      });
      setReleaseData(releasingAnime);
      if (progress.length > 0) setProg(progress);
    }
    getRelease();
  }, [release]);

  const [listAnime, setListAnime] = useState<any[] | null>();
  const [planned, setPlanned] = useState<any[] | null>(null);
  const [user, setUser] = useState<any[] | null>(null);
  const [removed, setRemoved] = useState();

  const [prog, setProg] = useState<any[] | null>();

  const popular = populars?.data;

  useEffect(() => {
    async function userData() {
      try {
        if (userSession?.name) {
          await fetch(`/api/user/profile`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              name: sessions.user.name,
            }),
          });
        }
      } catch (error) {
        console.log(error);
      }
      let data: UserDataType | null = null;
      try {
        if (userSession?.name) {
          const res = await fetch(
            `/api/user/profile?name=${sessions.user.name}`
          );
          if (!res.ok) {
            switch (res.status) {
              case 404: {
                console.log("user not found");
                break;
              }
              case 500: {
                console.log("server error");
                break;
              }
              default: {
                console.log("unknown error");
                break;
              }
            }
          } else {
            data = await res.json();
            // Do something with the data
          }
        }
      } catch (error) {
        console.error(error);
        // Handle the error here
      }
      // Read the device-local watch history (artplayer_settings) — works for
      // everyone, signed in or not. Most-recent-first, deduped by aniId.
      const readLocalHistory = (): any[] => {
        let parsed: Record<string, any> | null = null;
        try {
          const raw = localStorage.getItem("artplayer_settings");
          parsed = raw ? JSON.parse(raw) : null;
        } catch {}
        if (!parsed || typeof parsed !== "object") return [];
        const arr = (Object.values(parsed) as any[]).sort(
          (a: any, b: any) =>
            new Date(b?.createdAt || 0).getTime() -
            new Date(a?.createdAt || 0).getTime(),
        );
        const seenIds = new Set<string>();
        const seenTitles = new Set<string>();
        return arr.filter((entry: any) => {
          if (entry?.aniId) {
            const key = String(entry.aniId);
            if (seenIds.has(key)) return false;
            seenIds.add(key);
            return true;
          }
          const titleKey = String(entry?.aniTitle || "").toLowerCase().trim();
          if (!titleKey || seenTitles.has(titleKey)) return false;
          seenTitles.add(titleKey);
          return true;
        });
      };

      if (!data) {
        // Anonymous / Prisma-less session → device-local history only.
        const local = readLocalHistory();
        if (local.length) setUser(local);
      } else {
        // Sort most-recent-first before dedup. The Prisma query already
        // orders by createdDate desc, but rows with a null/stale createdDate
        // (older entries, or ones created via createList without a watch
        // update) land in an undefined position, so the carousel order ended
        // up wrong. Re-sorting on the client makes it deterministic and
        // consistent with the anonymous (localStorage) branch above.
        const newFirst = [...(data?.WatchListEpisode ?? [])].sort(
          (a, b) =>
            new Date(b?.createdDate || 0).getTime() -
            new Date(a?.createdDate || 0).getTime(),
        );

        // Dedup by aniId (most reliable) falling back to aniTitle.
        const seenIds = new Set<string>();
        const seenTitles = new Set<string>();
        const filteredData = newFirst.filter((entry) => {
          if (entry?.aniId) {
            const key = String(entry.aniId);
            if (seenIds.has(key)) return false;
            seenIds.add(key);
            return true;
          }
          const titleKey = String(entry?.aniTitle || "").toLowerCase().trim();
          if (!titleKey || seenTitles.has(titleKey)) return false;
          seenTitles.add(titleKey);
          return true;
        });
        // A signed-in user with an empty server list (e.g. they only ever
        // watched anonymously, or the Prisma write failed) should still see
        // their device-local history rather than an empty section.
        setUser(filteredData.length ? filteredData : readLocalHistory());
      }
      // const data = await res.json();
    }
    userData();
  }, [userSession?.name, removed]);

  useEffect(() => {
    async function userData() {
      if (!userSession?.name) return;

      const getMedia =
        currentAnime.find((item) => item.status === "CURRENT") || null;
      const listAnime = getMedia?.entries
        .map(({ media }) => media)
        .filter((media) => media);

      const planned = plan?.[0]?.entries
        .map(({ media }) => media)
        .filter((media) => media);

      if (listAnime) {
        setListAnime(listAnime);
      }
      if (planned) {
        setPlanned(planned);
      }
    }
    userData();

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userSession?.name, currentAnime, plan]);

  function removeHtmlTags(text: string): string {
    return text?.replace(/<[^>]+>/g, "");
  }

  return (
    <Fragment>
      <Head>
        <title>AniScroll • Beta</title>
        <meta charSet="UTF-8"></meta>
        <link rel="icon" type="image/png" href="/logo.png" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta
          name="description"
          content="Discover your new favorite anime or manga title! AniScroll offers a vast library of high-quality content, accessible on multiple devices and without any interruptions. Start using AniScroll today!"
        />
        <meta
          name="keywords"
          content="anime, anime streaming, anime streaming website, anime streaming free, anime streaming website free, anime streaming website free english subbed, anime streaming website free english dubbed, anime streaming website free english subbed and dubbed, anime streaming webs
          ite free english subbed and dubbed download, anime streaming website free english subbed and dubbed"
        />
        <meta name="robots" content="index, follow" />

        <meta property="og:type" content="website" />
        <meta
          property="og:title"
          content="AniScroll - Free Anime and Manga Streaming"
        />
        <meta
          property="og:description"
          content="Discover your new favorite anime or manga title! AniScroll offers a vast library of high-quality content, accessible on multiple devices and without any interruptions. Start using AniScroll today!"
        />
        <meta property="og:image" content="/logo.png" />
        <meta property="og:site_name" content="AniScroll" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta
          name="twitter:title"
          content="AniScroll - Free Anime and Manga Streaming"
        />
        <meta
          name="twitter:description"
          content="Discover your new favorite anime or manga title! AniScroll offers a vast library of high-quality content, accessible on multiple devices and without any interruptions. Start using AniScroll today!"
        />
        <meta name="twitter:image" content="/logo.png" />
      </Head>
      <MobileNav hideProfile={true} />

      <Navbar withNav={true} home={true} />
      <div className="h-auto w-screen bg-primary text-[#dbdcdd] pt-16 lg:pt-0">
        <HeroBanner
          entries={heroEntries}
          firstTrend={firstTrend}
          onPlay={(id) =>
            router.push(
              `/en/anime/watch/${id}/megaplay?id=megaplay-${id}-1&num=1`,
            )
          }
          stripDescription={removeHtmlTags}
        />


        {sessions && (
          <div className="flex items-center justify-center lg:bg-none mt-4 lg:mt-0 w-screen">
            <div className="lg:w-[85%] w-screen px-5 lg:px-0 lg:text-4xl flex items-center gap-3 text-2xl font-bold font-karla">
              <>
                {t(getGreetingKey())},
                <h1 className="lg:hidden">{sessions?.user.name}</h1>
              </>
              <button
                onClick={() => signOut()}
                className="hidden text-center relative lg:flex justify-center group"
              >
                {sessions?.user.name}
                <span className="absolute text-sm z-50 w-20 text-center bottom-11 text-white shadow-lg opacity-0 bg-secondary p-1 rounded-md font-karla font-light invisible group-hover:visible group-hover:opacity-100 duration-300 transition-all">
                  Sign Out
                </span>
              </button>
            </div>
          </div>
        )}

        <div className="lg:mt-16 mt-5 flex flex-col items-center">
          <motion.div
            className="w-screen flex-none lg:w-[95%] xl:w-[87%]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, staggerChildren: 0.2 }} // Add staggerChildren prop
          >
            {user && user?.length > 0 && user?.some((i) => i?.watchId || i?.aniId) && (
              <motion.section // Add motion.div to each child component
                key="recentlyWatched"
                initial={{ y: 20, opacity: 0 }}
                whileInView={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.5 }}
                viewport={{ once: true }}
              >
                <Content
                  ids="recentlyWatched"
                  section="Recently Watched"
                  userData={user}
                  userName={userSession?.name}
                  setRemoved={setRemoved}
                />
              </motion.section>
            )}

            {sessions && releaseData?.length > 0 && (
              <motion.section // Add motion.div to each child component
                key="onGoing"
                initial={{ y: 20, opacity: 0 }}
                whileInView={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.5 }}
                viewport={{ once: true }}
              >
                <Content
                  ids="onGoing"
                  section="On-Going Anime"
                  data={releaseData}
                  og={prog}
                  userName={userSession?.name}
                />
              </motion.section>
            )}
            {/* Reserve the row's height while the signed-in user's lists are
                still loading, so the carousel doesn't pop in and shove the
                sections below it down the page. */}
            {sessions && releaseLoading && releaseData?.length === 0 && (
              <CarouselSkeleton variant="landscape" />
            )}

            {sessions && listAnime && listAnime?.length > 0 && (
              <motion.section // Add motion.div to each child component
                key="listAnime"
                initial={{ y: 20, opacity: 0 }}
                whileInView={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.5 }}
                viewport={{ once: true }}
              >
                <Content
                  ids="listAnime"
                  section="Your Watch List"
                  data={listAnime}
                  og={prog}
                  userName={userSession?.name}
                />
              </motion.section>
            )}
            {sessions && currentLoading && !listAnime?.length && (
              <CarouselSkeleton />
            )}

            {recommendations.length > 0 && (
              <motion.section
                key="recommendationAnime"
                initial={{ y: 20, opacity: 0 }}
                whileInView={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.5 }}
                viewport={{ once: true }}
              >
                <Content
                  ids="recommendationAnime"
                  section="Recommendations"
                  data={recommendations}
                />
              </motion.section>
            )}
            {sessions && currentLoading && recommendations.length === 0 && (
              <CarouselSkeleton />
            )}

            {/* SECTION 2 */}
            {sessions && planned && planned?.length > 0 && (
              <motion.section // Add motion.div to each child component
                key="plannedAnime"
                initial={{ y: 20, opacity: 0 }}
                whileInView={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.5 }}
                viewport={{ once: true }}
              >
                <Content
                  ids="plannedAnime"
                  section="Your Plan"
                  data={planned}
                  userName={userSession?.name}
                />
              </motion.section>
            )}
            {sessions && planLoading && !planned?.length && (
              <CarouselSkeleton />
            )}
          </motion.div>

          <motion.div
            className="w-screen flex-none lg:w-[95%] xl:w-[87%]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, staggerChildren: 0.2 }} // Add staggerChildren prop
          >
            {/* SECTION 3 */}
            {recentAdded?.length > 0 && (
              <motion.section // Add motion.div to each child component
                key="recentAdded"
                initial={{ y: 20, opacity: 0 }}
                transition={{ duration: 0.5 }}
                whileInView={{ y: 0, opacity: 1 }}
                viewport={{ once: true }}
              >
                <Content
                  ids="recentAdded"
                  section="Freshly Added"
                  data={recentAdded}
                />
              </motion.section>
            )}

            {/* SECTION 4 */}
            {detail && (
              <motion.section // Add motion.div to each child component
                key="trendingAnime"
                initial={{ y: 20, opacity: 0 }}
                transition={{ duration: 0.5 }}
                whileInView={{ y: 0, opacity: 1 }}
                viewport={{ once: true }}
              >
                <Content
                  ids="trendingAnime"
                  section="Trending Now"
                  data={detail.data}
                />
              </motion.section>
            )}

            {/* This Season — current-quarter anime by popularity */}
            {thisSeason?.data?.length > 0 && (
              <motion.section
                key="thisSeason"
                initial={{ y: 20, opacity: 0 }}
                transition={{ duration: 0.5 }}
                whileInView={{ y: 0, opacity: 1 }}
                viewport={{ once: true }}
              >
                <Content
                  ids="thisSeason"
                  section="This Season"
                  data={thisSeason.data}
                />
              </motion.section>
            )}
            {/* <div className="w-full h-[150px] bg-white flex-center my-5 text-black">
              ad banner
            </div> */}

            {/* Schedule */}
            {anime.length > 0 && (
              <motion.section // Add motion.div to each child component
                key="schedule"
                initial={{ y: 20, opacity: 0 }}
                whileInView={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.5 }}
                viewport={{ once: true }}
              >
                <Schedule
                  data={anime[0]}
                  anime={anime}
                  update={update}
                  scheduleData={schedules}
                />
              </motion.section>
            )}

            {/* SECTION 5 */}
            {popular && (
              <motion.section // Add motion.div to each child component
                key="popularAnime"
                initial={{ y: 20, opacity: 0 }}
                whileInView={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.5 }}
                viewport={{ once: true }}
              >
                <Content
                  ids="popularAnime"
                  section="Popular Anime"
                  data={popular}
                />
              </motion.section>
            )}

            {/* Popular Movies — MOVIE-format anime by popularity */}
            {movies?.data?.length > 0 && (
              <motion.section
                key="popularMovies"
                initial={{ y: 20, opacity: 0 }}
                whileInView={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.5 }}
                viewport={{ once: true }}
              >
                <Content
                  ids="popularMovies"
                  section="Popular Movies"
                  data={movies.data}
                />
              </motion.section>
            )}

            <motion.section // Add motion.div to each child component
              key="Genres"
              initial={{ y: 20, opacity: 0 }}
              whileInView={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.5 }}
              viewport={{ once: true }}
            >
              <Genres />
            </motion.section>
          </motion.div>
        </div>
      </div>
      <Footer />
    </Fragment>
  );
}

export interface CurrentMediaTypes {
  status?: string;
  name: string;
  entries: Entry[];
}

export interface Entry {
  id: number;
  mediaId: number;
  status: string;
  progress: number;
  score: number;
  media: Media;
}

export interface Media {
  id: number;
  status: string;
  nextAiringEpisode: any;
  title: Title;
  episodes: number;
  coverImage: CoverImage;
}

export interface Title {
  english: string;
  romaji: string;
}

export interface CoverImage {
  large: string;
}

export interface UserDataType {
  id: string;
  name: string;
  setting: Setting;
  WatchListEpisode: WatchListEpisode[];
}

export interface Setting {
  CustomLists: boolean;
}

export interface WatchListEpisode {
  id: string;
  aniId?: string;
  title?: string;
  aniTitle?: string;
  image?: string;
  episode?: number;
  timeWatched?: number;
  duration?: number;
  provider?: string;
  nextId?: string;
  nextNumber?: number;
  dub?: boolean;
  createdDate: string;
  userProfileId: string;
  watchId: string;
}
