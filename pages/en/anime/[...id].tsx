import Head from "next/head";
import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { resolveSource, warmStream, clearPrefetchedSourcesFor } from "@/lib/watch/sourcePrefetch";
import { prefetchSkips } from "@/lib/skip/prefetchSkips";
import { prefetchEpisodeList } from "@/lib/watch/episodePrefetch";
import { setPrefetchedInfo } from "@/lib/watch/infoPrefetch";

import { useSession } from "next-auth/react";
import ListEditor from "@/components/listEditor";

import { useAniList } from "@/lib/anilist/useAnilist";
import { useTranslation } from "react-i18next";
import Footer from "@/components/shared/footer";
import { mediaInfoQuery } from "@/lib/graphql/query";
import MobileNav from "@/components/shared/MobileNav";

import { redis } from "@/lib/redis";
import { primeMediaCache } from "@/lib/anilist/getMediaMeta";
import { anilistFetch } from "@/lib/anilist/anilistFetch";
import { getUserList, peekListEntry, hasUserList, patchListEntry } from "@/lib/anilist/userListCache";
import { peekLocalEntry, LOCAL_LIST_EVENT } from "@/lib/list/localList";
import { useSyncPrefs } from "@/lib/prefs/syncPrefs";
import { getCachedAnime } from "@/lib/db/anime";
import { loadFanarts } from "@/lib/db/fanarts";
import { resolveSeasonChain, resolveSeasonList, resolveBonusFilms, SeasonEntry } from "@/lib/anilist/seasonChain";
import type { FilmVariant } from "@/lib/anilist/resolveSeason";
import { notify } from "@/lib/notifications/noticeStore";
import { Navbar } from "@/components/shared/NavBar";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import InfoPage from "@/components/anime/v2/InfoPage";
import { relationsTreeUrl } from "@/components/anime/v2/RelationsGraph";
import InfoPageMobile from "@/components/anime/v2/mobile/InfoPageMobile";
import { useIsMobile } from "@/lib/hooks/useIsMobile";
import { pickTitleImage, collectArtworks, slugifyTitle, SeasonInfo, TitleImage } from "@/components/anime/v2/helpers";
import { getTmdbAnimeImages } from "@/lib/tmdb/animeImages";
import { resolveHeroBanner } from "@/lib/images/heroBanner";

import type { FanartsMeta } from "@/components/anime/v2/helpers";
import { replaceUrlPreservingState } from "@/lib/navigation/replaceUrl";

type InfoTypes = {
  info: AniListInfoTypes;
  color: string;
  api: string;
  chapterNotFound: string;
  /** Counts only — the fanart rows are fetched on tab click (useFanarts).
   *  See FanartsMeta for why. */
  fanartsMeta: FanartsMeta | null;
  /** Clearart/logo URL picked at SSR time so the <img> is in the
   *  initial HTML and starts streaming with the document. Carries a
   *  cycle queue for clearart so the client can swap images on click. */
  initialTitleImage: TitleImage | null;
  /** S<n> of N — resolved by walking PREQUEL/SEQUEL chains at SSR. */
  seasonInfo: SeasonInfo;
  /** Ordered list of season-like sibling entries (incl. current). */
  seasonList: SeasonEntry[];
  /** Franchise bonus films (SIDE_STORY movies) for the separate "Films"
   *  dropdown. Empty when the franchise has none (hides the dropdown). */
  bonusFilms: FilmVariant[];
  /** Pre-fetched list state for the signed-in user. SSR'd so the heart
   *  and the watch-button don't flash "empty" before useEffect resolves. */
  initialFav: boolean;
  initialStatusLabel: string | null;
  initialProgress: number;
  /** Useragent string sniffed at SSR so the very first render already
   *  picks the right mobile/desktop layout — no client-only flash. */
  initialUA: string | null;
  /** Absolute site origin (e.g. https://aniscroll.com) derived from the
   *  request headers at SSR. Used to build an ABSOLUTE og:image URL in the
   *  HTML, so link-unfurlers (Discord/X/Slack) — which read the raw SSR
   *  markup, never run our client JS — get a card instead of a broken
   *  relative URL. */
  baseUrl: string;
};

// Bump when the shape of `info` changes — or when a SSR-side computation
// it influences (e.g. seasonInfo) gets a non-backwards-compatible fix.
// Past payloads remain in Redis under the old key and naturally expire.
//
// v3 — season detection rewrite.
// v4 — added seasonList SSR for the Episodes-tab season switcher.
//      We re-compute seasonList every request (it walks getMediaMeta,
//      which is cached three layers deep so it's cheap) so this bump
//      is only needed to refresh the `info` payload — not strictly
//      required for the switcher to work.
// v5: flush any partial/legacy SSR blobs (missing coverImage/title) that
// crashed Hero with FUNCTION_INVOCATION_FAILED on the back-button path.
const CACHE_VERSION = "v5";

export default function Info({
  info,
  chapterNotFound,
  fanartsMeta,
  initialTitleImage,
  seasonInfo,
  seasonList,
  bonusFilms,
  initialFav,
  initialStatusLabel,
  initialProgress,
  initialUA,
  baseUrl,
}: InfoTypes) {
  const isMobile = useIsMobile(initialUA);
  const { data: session, status: sessionStatus }: any = useSession();
  // When AniList sync is off, a connected user's status comes from the local
  // list too (the editor writes there), so the info page must read from the
  // same place to stay consistent.
  const syncEnabled = useSyncPrefs().enabled;
  const { toggleFavourite } = useAniList(session);
  const { t } = useTranslation();
  const router = useRouter();

  // Seed with the SSR-resolved values so the first paint already shows
  // the correct heart / list-status / resume-episode — no flash from
  // "empty" to "filled" on hydration.
  const [progress, setProgress] = useState<number>(initialProgress);
  const [statusLabel, setStatusLabel] = useState<string | null>(initialStatusLabel);
  const [fav, setFav] = useState<boolean>(initialFav);
  // Whether the signed-in user's list status has finished resolving. The page
  // SSRs an identical (status=null) HTML for everyone so it can be edge-cached,
  // then fetches the per-user status from AniList on the client. Until that
  // settles we must NOT render "Add to list" for a signed-in user — otherwise
  // the button flashes "Add to list" then flips to the real status. For
  // anonymous visitors there's nothing to load, so it's resolved from the start.
  const [statusResolved, setStatusResolved] = useState<boolean>(!session);

  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (chapterNotFound) {
      notify.error(t("anime.sourceNotFound"));
      const cleanUrl = window.location.origin + window.location.pathname;
      replaceUrlPreservingState(cleanUrl);
    }
  }, [chapterNotFound]);

  // Rewrite the URL to include a human-readable slug after the AniList
  // id (e.g. /en/anime/108511/that-time-i-got-reincarnated-as-a-slime).
  // The catch-all route (`[...id]`) already accepts and ignores extra
  // segments, so the page itself doesn't need to change — we just
  // decorate the URL via history.replaceState so it's nice to share.
  // Anything after the hash (#episodes etc.) is preserved.
  useEffect(() => {
    if (!info?.id) return;
    const slug = slugifyTitle(info.title);
    if (!slug) return;
    const current = window.location.pathname;
    // Preserve the current locale prefix (/en or /fr) so we don't fight the
    // I18nProvider's locale swap.
    const locale = current.startsWith("/fr/") || current === "/fr" ? "fr" : "en";
    const expected = `/${locale}/anime/${info.id}/${slug}`;
    if (current === expected) return;
    // Only rewrite when the current path is the bare /{locale}/anime/{id}
    // form — don't touch URLs that already carry some other segment
    // the user typed manually.
    if (
      current === `/${locale}/anime/${info.id}` ||
      current === `/${locale}/anime/${info.id}/`
    ) {
      const search = window.location.search || "";
      const hash = window.location.hash || "";
      replaceUrlPreservingState(expected + search + hash);
    }
  }, [info?.id, info?.title]);

  // Reset modal on first mount.
  useEffect(() => {
    handleClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-sync local state when the SSR props change (Next router does
  // SPA-style navigation between /en/anime/{id} pages, which re-runs
  // getServerSideProps but keeps the React tree mounted). Without
  // this, navigating from anime A → anime B would carry over A's
  // fav/progress until the user reloaded.
  useEffect(() => {
    setProgress(initialProgress);
    setStatusLabel(initialStatusLabel);
    setFav(initialFav);
    // Navigating to another anime restarts the per-user resolution: a signed-in
    // user's status is unknown again until the fetch below re-runs.
    setStatusResolved(!session);
  }, [info?.id, initialProgress, initialStatusLabel, initialFav, session]);

  // Hydrate the signed-in user's heart / progress / list-status CLIENT-side.
  // The SSR HTML is identical for everyone (so Vercel edge-caches the page for
  // logged-in users too). Rather than query AniList per-anime every time an
  // info page opens (slow, repeated for every anime browsed), we fetch the
  // user's WHOLE list once per session (lib/anilist/userListCache) and look the
  // current anime up locally — O(1) map read, no per-page network. A cached
  // list (mem or sessionStorage) means the right status shows instantly; the
  // first load of a session pays one full-list fetch, then every subsequent
  // anime is free. The favourite flag isn't in MediaListCollection, so we read
  // it from the same lightweight per-anime query only as a side fetch.
  useEffect(() => {
    const token = session?.user?.token;
    const userName = session?.user?.name;
    const aniId = Number(info?.id);
    // Sync off → the local-list effect below owns the status instead.
    if (!syncEnabled) return;
    if (!token || !userName || !Number.isFinite(aniId)) return;
    let cancelled = false;

    // 1. Synchronous seed from whatever list is already cached → instant status.
    const cached = peekListEntry(userName, aniId);
    if (cached) {
      setStatusLabel(cached.status ?? null);
      setProgress(cached.progress || 0);
      setStatusResolved(true);
    } else if (hasUserList(userName)) {
      // List is cached and this anime isn't on it → confirmed "not in list".
      setStatusLabel(null);
      setProgress(0);
      setStatusResolved(true);
    }

    // 2. Refresh the whole list (cache-aware) and re-read this anime from it.
    (async () => {
      const map = await getUserList(userName, token);
      if (cancelled) return;
      const e = map.get(aniId);
      setStatusLabel(e?.status ?? null);
      setProgress(e?.progress || 0);
      setStatusResolved(true);
    })();

    // 3. Favourite is per-media, not in the collection — fetch it separately.
    (async () => {
      try {
        const res = await fetch("https://graphql.anilist.co", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            query: "query ($id: Int) { Media(id: $id) { isFavourite } }",
            variables: { id: aniId },
          }),
        });
        if (!res.ok || cancelled) return;
        const json = await res.json();
        if (!cancelled) setFav(json?.data?.Media?.isFavourite === true);
      } catch {
        /* heart stays empty on failure */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session?.user?.token, session?.user?.name, info?.id, syncEnabled]);

  // ── Local-list status (guests, and connected users with sync off) ─────
  // Status/progress come from the local list (lib/list/localList.ts) when the
  // user has no AniList session OR has turned sync off (the editor writes
  // locally in both cases). We re-read on the local-list change event so
  // finishing an episode (or editing) reflects immediately.
  //
  // IMPORTANT for the signed-in case: only treat a missing session as "guest"
  // once next-auth has CONFIRMED it (status === "unauthenticated"). During the
  // brief post-hydration "loading" phase `session` is undefined for a signed-in
  // user too — acting then would flash "Add to list" over their real status.
  useEffect(() => {
    const useLocal =
      !syncEnabled /* connected-but-off or guest-with-off */ ||
      sessionStatus === "unauthenticated";
    if (!useLocal) return;
    const aniId = Number(info?.id);
    if (!Number.isFinite(aniId)) return;
    const read = () => {
      const e = peekLocalEntry(aniId);
      setStatusLabel(e?.status ?? null);
      setProgress(e?.progress || 0);
      setStatusResolved(true);
    };
    read();
    window.addEventListener(LOCAL_LIST_EVENT, read);
    return () => window.removeEventListener(LOCAL_LIST_EVENT, read);
  }, [sessionStatus, syncEnabled, info?.id]);

  // ── Prefetch the player for the "Watch" target ───────────────────────
  // Visitors who open an anime page usually go on to watch it, so we warm
  // the whole playback path in the background once the page is idle (so the
  // info page itself — images, metadata — keeps priority). When the user hits
  // "Watch", the route + player chunk are cached, the episode source is
  // already resolved (read from the shared cache), and the first HLS segment
  // is primed — playback starts almost instantly. Everything here is
  // best-effort and fire-and-forget; failures never affect the info page.
  // Stash the full Media payload in the shared client cache the instant we
  // have it (synchronously, before any idle deferral) so a fast click on
  // "Watch" can hydrate the watch page from memory with zero network wait.
  useEffect(() => {
    if (info?.id) setPrefetchedInfo(info.id, info);
  }, [info?.id, info]);

  useEffect(() => {
    if (!info?.id) return;
    const resumeEp = Math.max(1, (progress || 0) + 1);
    const server = "megaplay";
    const watchHref = `/en/anime/watch/${info.id}/${server}?id=${server}-${info.id}-${resumeEp}&num=${resumeEp}`;

    const releasing = info.status === "RELEASING";
    const malId = (info as any)?.idMal as number | undefined;

    let cancelled = false;
    // Aborts every in-flight prefetch fetch the moment the user leaves this
    // info page (unmount / navigates to another anime). Paired with a cache
    // purge in cleanup so nothing we warmed lingers after we're gone.
    const ac = new AbortController();

    // ── Tier 1: the things the watch page actually blocks on ───────────
    // The player can't render until the EPISODE LIST returns (it builds
    // `episodeNavigation` from it) and the SOURCE resolves. These are the
    // gate on "time to player", so we start them on a short fixed delay —
    // long enough not to fight the info page's above-the-fold fetches, but
    // well before a typical user finishes reading and clicks "Watch".
    const runCritical = () => {
      if (cancelled) return;
      // Warm the Next.js route + the player's dynamic chunk.
      try {
        router.prefetch(watchHref);
      } catch {}
      void import("@/components/watch/primary/UniversalPlayer").catch(() => {});

      // Episode list — the request the player waits on. Writes to the shared
      // cache the watch page reads first, and primes the browser HTTP cache.
      void prefetchEpisodeList(info.id, { releasing, priority: "low" });

      const mediaMeta = {
        id: info.id,
        idMal: (info as any).idMal,
        title: info.title,
        synonyms: (info as any).synonyms,
        relations: info.relations,
      };
      const titleStr = info?.title?.romaji || info?.title?.english || undefined;
      const warmServer = (srv: string, priority: "high" | "low") =>
        resolveSource(
          { aniId: info.id, episode: resumeEp, server: srv, sub: "sub", title: titleStr, mediaMeta },
          { priority: priority as any, signal: ac.signal },
        ).then((data) => {
          if (!cancelled && data) warmStream(data, ac.signal);
        });

      // Priority order:
      //  1. megaplay — the server the watch page starts on.
      //  2. the user's saved preferred server — the one the page switches to
      //     once confirmed (and the one they actually watch).
      // Both at HIGH priority so they resolve first.
      let preferred: string | null = null;
      try {
        preferred = localStorage.getItem("preferred_server");
      } catch {}

      const prioritised = [server];
      if (preferred && preferred !== server) prioritised.push(preferred);
      for (const srv of prioritised) void warmServer(srv, "high");

      // We deliberately DON'T warm every other server here anymore. Doing so
      // fired a /api/v2/source resolution — heavy anime-sama / voiranime
      // scraping — for ~8 servers on EVERY info-page view, even when the
      // visitor was only browsing and never watched. That's a big, mostly
      // wasted cost (invocations + CPU + scraping bandwidth). Only megaplay
      // (the server the watch page starts on) and the user's preferred server
      // are warmed above; any other server resolves on-demand the instant it's
      // selected on the watch page (~1-2s — and the watch page's own probes
      // seed the cache too), so the UX cost is negligible.
    };

    // ── Tier 2: nice-to-have warmups, deferred to a real idle moment ───
    // AniSkip chapter data shares SKIP_MEMO with the watch page; it only
    // matters once the video reports its duration, so it can wait for idle.
    const runIdle = () => {
      if (cancelled) return;
      // Warm the per-host entry for the server the watch page starts on
      // (megaplay, its SSR default) so the overlay reads a hit on arrival.
      if (malId) void prefetchSkips(malId, resumeEp, info.id, { server: "megaplay" });
    };

    // Short delay: just enough to let the info page's first paint + its own
    // above-the-fold image/metadata fetches kick off, but well under the time
    // it takes a user to read the page and click "Watch". (Was 800ms, which
    // lost the race on fast clicks — the prefetch hadn't started yet.)
    const timeoutId = window.setTimeout(runCritical, 200);

    const w = window as any;
    let idleId: number | undefined;
    let idleTimeoutId: number | undefined;
    if (typeof w.requestIdleCallback === "function") {
      idleId = w.requestIdleCallback(runIdle, { timeout: 3000 });
    } else {
      idleTimeoutId = window.setTimeout(runIdle, 1500);
    }

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      if (idleId != null && typeof w.cancelIdleCallback === "function") {
        w.cancelIdleCallback(idleId);
      }
      if (idleTimeoutId != null) window.clearTimeout(idleTimeoutId);

      // Stop every in-flight prefetch the instant we leave the page.
      ac.abort();

      // Purge what we cached for this anime — UNLESS we're navigating to its
      // own watch page, which is exactly the consumer this cache exists for.
      // (The cleanup also fires on that SPA navigation; purging then would
      // throw away the warm sources right before the player reads them.)
      const goingToWatch =
        typeof window !== "undefined" &&
        new RegExp(`/anime/watch/${info.id}(?:[/?#]|$)`).test(
          window.location.pathname + window.location.search,
        );
      if (!goingToWatch) clearPrefetchedSourcesFor(info.id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.id, progress]);

  /* Optimistic favourite toggle. Flips the heart immediately so the
     click feels instant; if the AniList mutation fails we roll back
     and surface a notify. Requires the user to be signed in. */
  const handleToggleFav = async () => {
    if (!session?.user?.name) {
      handleOpen(); // opens the login modal that the list-editor uses
      return;
    }
    const previous = fav;
    setFav(!previous);
    try {
      const res = await toggleFavourite(info.id);
      if (res?.errors?.length) throw new Error(res.errors[0]?.message);
    } catch (e: any) {
      setFav(previous);
      notify.error(t("anime.couldntUpdateFav", { message: e?.message || t("anime.unknown") }));
    }
  };

  function handleOpen() {
    if (!session) {
      setOpen(true);
      document.body.style.overflow = "hidden";
      return;
    }
    setOpen(true);
    document.body.style.overflow = "hidden";
  }

  function handleClose() {
    setOpen(false);
    if (typeof document !== "undefined") document.body.style.overflow = "auto";
  }

  const title = info?.title?.english || info?.title?.romaji || "Anime";

  // Absolute OG-card URL. Built from the SSR-derived origin so the meta tag is
  // an absolute URL in the very first HTML — link-unfurlers (Discord/X/Slack)
  // read that markup without running our JS, so a relative URL wouldn't work.
  // The card route (pages/api/og.tsx) draws the cover on the left + title /
  // meta / genres / score on the right. Sharing the page link embeds this card.
  const ogImageUrl = (() => {
    const params = new URLSearchParams();
    params.set("title", title);
    if (info?.coverImage?.extraLarge || info?.coverImage?.large)
      params.set("cover", info.coverImage.extraLarge || info.coverImage.large);
    if (info?.bannerImage) params.set("banner", info.bannerImage);
    if (info?.averageScore) params.set("score", String(info.averageScore));
    const year = info?.seasonYear || info?.startDate?.year;
    if (year) params.set("year", String(year));
    if (info?.format) params.set("format", info.format);
    if (info?.episodes) params.set("episodes", String(info.episodes));
    if (info?.genres?.length) params.set("genres", info.genres.slice(0, 3).join(","));
    // Cache-buster: link unfurlers (Discord/X/Slack) cache the OG image by URL
    // forever. Bump this when the card design changes so they refetch instead
    // of serving the stale render (e.g. the old all-caps "ANISCROLL").
    params.set("v", "4");
    return `${baseUrl}/api/og?${params.toString()}`;
  })();
  const pageUrl = `${baseUrl}/en/anime/${info?.id ?? ""}`;

  // The second path segment is the human-readable anime slug (was "megaplay").
  // The watch route ignores it for routing (real provider falls back to the
  // first episode-list provider), so it's purely a readable/SEO URL — e.g.
  // /anime/watch/178754/kaijuu-8-gou-2nd-season?num=8. Falls back to "watch"
  // when the title hasn't resolved yet so the URL is never empty.
  const watchSlug = slugifyTitle(info?.title) || "watch";
  const watchUrl = info
    ? `/en/anime/watch/${info.id}/${watchSlug}?id=megaplay-${info.id}-${
        Math.max(1, progress + 1)
      }&num=${Math.max(1, progress + 1)}`
    : undefined;

  return (
    <>
      <Head>
        <title>AniScroll • Beta</title>
        <meta
          name="title"
          content={info?.title?.romaji}
          data-title-romaji={info?.title?.romaji}
          data-title-english={info?.title?.english || ""}
          data-title-native={info?.title?.native || ""}
        />
        <meta name="description" content={info?.description?.slice(0, 220) || ""} />

        {/* Open Graph — drives the embed card shown when the page link is
            shared (Discord, X, Slack, iMessage, …). og:image is the dynamic
            card route with the cover on the left. */}
        <meta property="og:type" content="video.tv_show" />
        <meta property="og:site_name" content="AniScroll" />
        <meta property="og:title" content={`${title} • AniScroll`} />
        <meta
          property="og:description"
          content={
            (info?.description?.replace(/<[^>]+>/g, "").slice(0, 180) || "") +
            "…"
          }
        />
        <meta property="og:url" content={pageUrl} />
        <meta property="og:image" content={ogImageUrl} />
        {/* Must match SCALE / CARD_W / CARD_H in pages/api/og.tsx. */}
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />

        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={`AniScroll - ${title}`} />
        <meta
          name="twitter:description"
          content={`${info?.description?.replace(/<[^>]+>/g, "").slice(0, 180) || ""}...`}
        />
        <meta name="twitter:image" content={ogImageUrl} />
        {/* Fonts used by the V2 design — Inter already loaded globally;
            Space Grotesk + JetBrains Mono are only needed on this page. */}
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        {/* Open the connection to the fanart.tv CDN before the preload
            below fires. Without preconnect the browser still pays DNS +
            TCP + TLS (~200-500ms) before any byte of the clearart
            arrives — that gap is most of why clearart felt slow vs.
            banner/cover (those reuse the AniList CDN connection the
            page already speaks to). */}
        {initialTitleImage?.url && (() => {
          try {
            const origin = new URL(initialTitleImage.url).origin;
            return (
              <>
                <link rel="preconnect" href={origin} />
                <link rel="dns-prefetch" href={origin} />
              </>
            );
          } catch {
            return null;
          }
        })()}
        {/* No rel=preload for the clearart: its <img> may swap to the
            original assets.fanart.tv URL at render time when the CF
            transformation proxy errors (429/502 once the monthly quota is
            spent — see lib/images/fanartFallback). A preload pinned to the
            proxy URL would then go unconsumed and Chrome logs "preloaded but
            not used". The <img> is already loading="eager" + fetchpriority
            "high", and we keep the preconnect above, so first-paint speed is
            unchanged. Banner/cover stay preloaded — those AniList URLs are
            stable and never rewritten. */}
        {info?.bannerImage && (
          <link
            rel="preload"
            as="image"
            href={info.bannerImage}
            // @ts-expect-error fetchPriority not in lib.dom yet
            fetchpriority="high"
          />
        )}
        {(info?.coverImage?.extraLarge || info?.coverImage?.large) && (
          <link
            rel="preload"
            as="image"
            href={info.coverImage.extraLarge || info.coverImage.large}
            // @ts-expect-error fetchPriority not in lib.dom yet
            fetchpriority="high"
          />
        )}
        {/* The franchise graph, started by the PRELOAD SCANNER rather than by
            the component that needs it.

            The board is client-only, so its fetch could not leave before
            hydration: measured on dev, the HTML was in at 260ms and the request
            still did not start until 428ms, then took 284ms. That 168ms of dead
            air is bought back here — the browser opens the request while it is
            still parsing and compiling, and the component finds it in flight.

            `crossorigin` IS required, and leaving it off is what made the
            browser refuse the match: an `as=fetch` preload without it carries
            credentials mode "omit", while a plain `fetch()` defaults to
            "same-origin" — "A preload for … is found, but is not used because
            the request credentials mode does not match". The two now agree on
            "omit" (see `relationsTreeUrl`'s caller in RelationsGraph), which is
            also the truth of this route: it is public, identical for everybody,
            and reads no cookie.

            `key` because next/head keeps ONE tag per key: without it a re-render
            of this page emitted the tag again, and the console carried three
            copies of the same "preloaded but not used" complaint. */}
        {info?.id && (
          <link
            key="preload-relations-tree"
            rel="preload"
            as="fetch"
            crossOrigin="anonymous"
            href={relationsTreeUrl(Number(info.id))}
          />
        )}
      </Head>

      <Navbar info={info} />

      {/* List editor renders its OWN overlay (matching the reference design),
          so it's not wrapped in <Modal>. Works for everyone: signed-in users
          edit their AniList entry, guests edit the local list (the editor
          detects the missing session and switches to local mode). */}
      {open && info && (
        <ListEditor
          animeId={info.id}
          session={session}
          stats={statusLabel || undefined}
          prg={progress}
          max={info?.episodes ?? undefined}
          info={info}
          close={handleClose}
          onSaved={(next) => {
            // Apply the edit in place — no full page reload. The editor already
            // patched the whole-list cache; we just sync the button/progress.
            setStatusLabel(next.removed ? null : next.status);
            setProgress(next.progress);
            setStatusResolved(true);
          }}
          onFavouriteChange={(f) => setFav(f)}
        />
      )}

      <MobileNav hideProfile={true} />

      <main>
        {isMobile ? (
          <InfoPageMobile
            info={info}
            fanartsMeta={fanartsMeta}
            initialTitleImage={initialTitleImage}
            seasonInfo={seasonInfo}
            seasonList={seasonList}
            bonusFilms={bonusFilms}
            statusLabel={statusLabel}
            statusResolved={statusResolved}
            fav={fav}
            progress={progress}
            watchUrl={watchUrl}
            onOpenListEditor={handleOpen}
            onToggleFav={handleToggleFav}
          />
        ) : (
          <InfoPage
            info={info}
            fanartsMeta={fanartsMeta}
            initialTitleImage={initialTitleImage}
            seasonInfo={seasonInfo}
            seasonList={seasonList}
            bonusFilms={bonusFilms}
            statusLabel={statusLabel}
            statusResolved={statusResolved}
            fav={fav}
            progress={progress}
            watchUrl={watchUrl}
            onOpenListEditor={handleOpen}
            onToggleFav={handleToggleFav}
          />
        )}
      </main>

      <Footer />
    </>
  );
}


/* Emit RFC 8288 `Link: rel=preload` HTTP headers so the browser starts
   downloading the hero artwork BEFORE we've finished computing the rest
   of the SSR response. Next.js (Pages Router) doesn't stream, but
   headers are flushed at status-line time — well ahead of the HTML
   body. We send one header per asset; URLs that we can't resolve until
   later (the clearart depends on loadFanarts, the banner depends on
   AniList) are emitted as soon as they become known.

   Each `Link` entry follows: <url>; rel=preload; as=image; fetchpriority=high.
   The browser's preload scanner picks these up and opens the connection
   + starts the byte stream immediately, in parallel with whatever
   getServerSideProps is still awaiting. */
function appendPreloadHeader(res: any, url: string): void {
  if (!url || !res?.setHeader) return;
  // Header value is multi-valued: append using getHeader/setHeader to
  // avoid clobbering previous Link entries set on the same response.
  const existing = res.getHeader?.("Link");
  const entry = `<${url}>; rel=preload; as=image; fetchpriority=high`;
  if (Array.isArray(existing)) {
    res.setHeader("Link", [...existing, entry]);
  } else if (typeof existing === "string" && existing.length > 0) {
    res.setHeader("Link", `${existing}, ${entry}`);
  } else {
    res.setHeader("Link", entry);
  }
}

/* Per-phase SSR timer. No-op unless PROFILE_SSR=1, so this stays free
   in normal dev/prod. Logs to one line per request so it's easy to grep
   and doesn't drown the terminal. */
const PROFILE_SSR = process.env.PROFILE_SSR === "1";
function makeTimer() {
  const t0 = Date.now();
  const marks: Array<[string, number]> = [];
  return {
    mark(label: string) {
      if (!PROFILE_SSR) return;
      marks.push([label, Date.now() - t0]);
    },
    end(label: string) {
      if (!PROFILE_SSR) return;
      marks.push([label, Date.now() - t0]);
      const summary = marks.map(([l, ms]) => `${l}=${ms}ms`).join(" ");
      // eslint-disable-next-line no-console
      console.log(`[ssr info] ${summary}`);
    },
  };
}

/* Collapse the fanart payload to the two counts the tab bar needs. The rows go
   over the wire only when a tab that reads them is opened — see FanartsMeta and
   lib/hooks/useFanarts. */
function toFanartsMeta(fanarts: any): FanartsMeta | null {
  if (!fanarts) return null;
  return {
    total: fanarts.total ?? 0,
    artworkCount: collectArtworks(fanarts).length,
  };
}

/* Drop the cast from the `info` that goes into __NEXT_DATA__.

   It is ~12 KB on a big title and only the Characters tab reads it — a tab body
   that <Tabs> does not even mount until its tab is clicked, at which point
   CharactersTab pulls the rows from /api/v2/characters/[id]. The count is kept
   inline so the tab badge is correct on first paint.

   Applied at the props boundary only: the Redis blob under `anime:v5:<id>` and
   the media cache primed by primeMediaCache both keep the full object, so
   nothing downstream (the watch page, /api/v2/media) loses a field. */
function stripCharacters(info: any): any {
  if (!info?.characters) return info;
  const { characters, ...rest } = info;
  return { ...rest, charactersCount: characters?.edges?.length ?? 0 };
}

export async function getServerSideProps(ctx: any) {
  const { id, notfound } = ctx.query;
  const timer = makeTimer();

  // Absolute origin for OG meta. Crawlers read the SSR HTML (no client JS), so
  // a relative og:image won't unfurl — we need the scheme+host here. Prefer the
  // forwarded headers Vercel sets, fall back to host, then to the prod domain.
  const fwdProto = ctx.req?.headers?.["x-forwarded-proto"];
  const fwdHost =
    ctx.req?.headers?.["x-forwarded-host"] || ctx.req?.headers?.host;
  const baseUrl = fwdHost
    ? `${(Array.isArray(fwdProto) ? fwdProto[0] : fwdProto) || "https"}://${
        Array.isArray(fwdHost) ? fwdHost[0] : fwdHost
      }`
    : "https://aniscroll.com";

  let API_URI;
  API_URI = process.env.API_URI || null;
  if (API_URI && API_URI.endsWith("/")) {
    API_URI = API_URI.slice(0, -1);
  }

  let cache: string | null = null;
  let chapterNotFound: string | null = null;

  if (notfound) {
    chapterNotFound = Math.random().toString(36).substring(7);
  }

  const cacheKey = `anime:${CACHE_VERSION}:${id}`;

  if (redis) {
    // Guarded: a Redis blip (timeout / dropped connection) must NOT crash the
    // whole SSR with FUNCTION_INVOCATION_FAILED — we just fall through to the
    // live AniList path as if it were a cache miss.
    try {
      cache = await redis.get(cacheKey);
    } catch (e: any) {
      console.warn(`[anime SSR] redis.get failed:`, e?.message);
      cache = null;
    }
  }
  timer.mark("redis");

  const animeIdNum = Number(id?.[0]);

  // The signed-in user's heart / progress / list-status are NO LONGER read
  // here. Fetching the session server-side made the SSR response per-user,
  // which forced `private, no-store` and re-invoked this function on EVERY
  // logged-in view. They now hydrate client-side (with a heart fill-in
  // animation — see the effect in the component below), so the SSR payload
  // is identical for everyone and Vercel's edge cache serves every visitor,
  // logged-in or not. This is the big invocation / Fast Origin Transfer win
  // on the site's busiest page — same pattern the home page already uses for
  // its personalised carousels.
  //
  // Headers:
  //  - `Cache-Control` → BROWSER cache (60s, so a hard refresh sees fresh
  //    metadata, no "stuck on yesterday's status").
  //  - `CDN-Cache-Control` → Vercel's edge cache (6h + 24h stale-while-
  //    revalidate). AniList metadata shifts slowly (episode count on an
  //    airing, status on a finale), so worst case a viewer sees a count
  //    off by a bit for a few hours while the next visitor refreshes it —
  //    and the nightly refresh-cache cron re-primes RELEASING anime anyway.
  //    Widened from 1h → 6h to cut Fluid Active CPU: most views on this, the
  //    busiest page, now hit the edge cache instead of re-invoking SSR. The
  //    24h stale-while-revalidate is unchanged, so there's no added staleness
  //    risk beyond serving a slightly older edge copy for longer.
  ctx.res.setHeader("Cache-Control", "public, max-age=60");
  ctx.res.setHeader(
    "CDN-Cache-Control",
    "public, s-maxage=21600, stale-while-revalidate=86400",
  );

  // A corrupt / partial cached value must not crash the function — treat a
  // parse failure as a cache miss and fall through to the live fetch below.
  let parsedCache: { info?: any; color?: any } | null = null;
  if (cache) {
    try {
      parsedCache = JSON.parse(cache);
    } catch (e: any) {
      console.warn(`[anime SSR] corrupt cache for ${id?.[0]}:`, e?.message);
      parsedCache = null;
    }
  }

  // A cached entry is only usable if it carries the fields the page renders
  // unconditionally. A partial/legacy blob missing coverImage or title would
  // crash SSR (Hero reads info.coverImage.* and the title) with
  // FUNCTION_INVOCATION_FAILED — exactly the back-button 500. Treat such an
  // entry as a miss and fall through to the live fetch, which rebuilds a
  // complete payload.
  const cacheUsable =
    !!parsedCache?.info?.coverImage &&
    !!(parsedCache.info.title?.userPreferred ||
       parsedCache.info.title?.romaji ||
       parsedCache.info.title?.english);

  if (parsedCache?.info && cacheUsable) {
    const { info, color } = parsedCache;

    // The cover URL is already in the cached `info`, so tell the browser to
    // start fetching it RIGHT NOW via a Link: header — long before
    // getServerSideProps finishes. Adds ~0ms to the response and shaves
    // ~200-500ms off image arrival when the SSR awaits downstream work below.
    const coverUrl = info?.coverImage?.extraLarge || info?.coverImage?.large;
    if (coverUrl) appendPreloadHeader(ctx.res, coverUrl);

    // Resolve fanarts first so we can ALSO emit a preload header for
    // the clearart before we await the (slower) season-chain walk.
    // Single-row Turso read, typically <50ms. TMDB rides along: warm it is
    // also one Turso row, and when TMDB_API_KEY is unset it returns without
    // touching anything, so this costs nothing in that case.
    const [fanarts, tmdb] = await Promise.all([
      loadFanarts(animeIdNum).catch(() => null),
      getTmdbAnimeImages(animeIdNum).catch(() => ({ backdrop: null, logo: null })),
    ]);
    timer.mark("fanarts");
    const initialTitleImage = pickTitleImage(fanarts, tmdb.logo);
    const fanartsMeta = toFanartsMeta(fanarts);
    const heroBanner = await resolveHeroBanner(info?.bannerImage, tmdb.backdrop);
    if (heroBanner) appendPreloadHeader(ctx.res, heroBanner);
    // No clearart preload header — see the <link> note above: the <img> may
    // swap to assets.fanart.tv on proxy error, leaving a proxy-URL preload
    // unconsumed ("preloaded but not used"). preconnect handles the latency.

    // Now wait on the slower stuff in parallel. The browser is already
    // pulling the images while these resolve.
    const [seasonInfo, seasonList, bonusFilms] = await Promise.all([
      resolveSeasonChain(animeIdNum).catch(() => ({ number: null, total: null })),
      resolveSeasonList(animeIdNum).catch(() => []),
      resolveBonusFilms(animeIdNum).catch(() => []),
    ]);
    timer.end(`cache-hit id=${id?.[0]}`);
    return {
      props: {
        /* Shallow copy, never a mutation: `info` came straight out of the
           Redis blob and the same object is handed back to other readers of
           that cache. Writing the TMDB URL onto it would leak a TMDB backdrop
           into the shared AniList payload for 30 days. */
        info: stripCharacters(
          heroBanner ? { ...info, bannerImage: heroBanner } : info,
        ),
        color,
        api: API_URI,
        chapterNotFound: chapterNotFound || null,
        fanartsMeta,
        initialTitleImage,
        seasonInfo,
        seasonList,
        bonusFilms,
        // Per-user fields hydrate client-side now (see component) so this
        // SSR payload stays identical for everyone → edge-cacheable.
        initialFav: false,
        initialStatusLabel: null,
        initialProgress: 0,
        initialUA: ctx.req?.headers?.["user-agent"] || null,
        baseUrl,
      },
    };
  }

  let data: any = null;
  const simulateDown = process.env.ANILIST_SIMULATE_DOWN === "1";
  try {
    if (simulateDown) throw new Error("simulated AniList outage");
    const resp = await anilistFetch({
      query: mediaInfoQuery,
      variables: { id: id?.[0] },
      label: `info-ssr:${id?.[0]}`,
    });
    data = resp?.data?.Media || null;
  } catch (e: any) {
    console.warn(`[anime SSR] AniList fetch failed for ${id?.[0]}:`, e?.message);
  }
  timer.mark("anilist");

  if (data) {
    primeMediaCache(animeIdNum, data);
  } else {
    try {
      const cached = await getCachedAnime(animeIdNum);
      if (cached?.data) data = cached.data;
    } catch (e: any) {
      console.warn(`[anime SSR] DB fallback failed:`, e?.message);
    }
  }
  timer.mark("dbFallback");

  const cacheTime = data?.nextAiringEpisode?.episode ? 60 * 10 : 60 * 60 * 24 * 30;

  if (!data) {
    return { notFound: true };
  }

  const textColor = setTxtColor(data?.coverImage?.color);
  const color = {
    backgroundColor: `${data?.coverImage?.color || "#ffff"}`,
    color: textColor,
  };

  // The cover URL is now known — push it into a Link: header so the browser
  // can start downloading while we await the rest.
  const coverUrl = data?.coverImage?.extraLarge || data?.coverImage?.large;
  if (coverUrl) appendPreloadHeader(ctx.res, coverUrl);

  // Resolve fanarts ahead of the slower walker work so we can emit the
  // clearart preload header before the response body is sent. TMDB rides
  // along — see the cache-hit path above for why the banner preload waits.
  const [fanarts, tmdb] = await Promise.all([
    loadFanarts(animeIdNum).catch(() => null),
    getTmdbAnimeImages(animeIdNum).catch(() => ({ backdrop: null, logo: null })),
  ]);
  timer.mark("fanarts");
  const initialTitleImage = pickTitleImage(fanarts, tmdb.logo);
  const fanartsMeta = toFanartsMeta(fanarts);
  const heroBanner = await resolveHeroBanner(data?.bannerImage, tmdb.backdrop);
  if (heroBanner) appendPreloadHeader(ctx.res, heroBanner);
  // No clearart preload header — the <img> may swap to assets.fanart.tv on
  // proxy error, which would leave a proxy-URL preload unconsumed.

  const seasonInfoP = resolveSeasonChain(animeIdNum).catch(
    () => ({ number: null, total: null })
  );
  const seasonListP = resolveSeasonList(animeIdNum).catch(
    () => [] as SeasonEntry[]
  );
  const bonusFilmsP = resolveBonusFilms(animeIdNum).catch(
    () => [] as FilmVariant[]
  );

  if (redis) {
    try {
      await redis.set(
        cacheKey,
        JSON.stringify({ info: data, color }),
        "EX",
        cacheTime
      );
    } catch (e: any) {
      console.warn(`[anime SSR] redis.set failed:`, e?.message);
    }
  }

  const [seasonInfo, seasonList, bonusFilms] = await Promise.all([
    seasonInfoP,
    seasonListP,
    bonusFilmsP,
  ]);
  timer.end(`cache-miss id=${id?.[0]}`);

  return {
    props: {
      /* Shallow copy — `data` is what redis.set just persisted as the shared
         AniList blob above, and it must stay free of TMDB URLs. */
      info: stripCharacters(
        heroBanner ? { ...data, bannerImage: heroBanner } : data,
      ),
      color,
      api: API_URI,
      chapterNotFound: chapterNotFound || null,
      fanartsMeta,
      initialTitleImage,
      seasonInfo,
      seasonList,
      bonusFilms,
      // Per-user fields hydrate client-side (see component) → cacheable SSR.
      initialFav: false,
      initialStatusLabel: null,
      initialProgress: 0,
      initialUA: ctx.req?.headers?.["user-agent"] || null,
      baseUrl,
    },
  };
}

function getBrightness(hexColor: { match: (arg0: RegExp) => any[] } | null) {
  if (!hexColor) return 200;
  const rgb = hexColor
    .match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i)
    .slice(1)
    .map((x: string) => parseInt(x, 16));
  return (299 * rgb[0] + 587 * rgb[1] + 114 * rgb[2]) / 1000;
}

function setTxtColor(hexColor: { match: (arg0: RegExp) => any[] } | null) {
  const brightness = getBrightness(hexColor);
  return brightness < 150 ? "#fff" : "#000";
}
