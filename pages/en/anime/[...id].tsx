import Head from "next/head";
import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import Modal from "@/components/modal";
import { resolveSource, warmStream, clearPrefetchedSourcesFor } from "@/lib/watch/sourcePrefetch";
import SERVERS from "@/lib/servers";
import { prefetchSkips } from "@/lib/skip/prefetchSkips";
import { prefetchEpisodeList } from "@/lib/watch/episodePrefetch";
import { setPrefetchedInfo } from "@/lib/watch/infoPrefetch";

import { signIn, useSession } from "next-auth/react";
import AniList from "@/components/media/aniList";
import ListEditor from "@/components/listEditor";

import { useAniList } from "@/lib/anilist/useAnilist";
import { useTranslation } from "react-i18next";
import Footer from "@/components/shared/footer";
import { mediaInfoQuery } from "@/lib/graphql/query";
import MobileNav from "@/components/shared/MobileNav";

import { redis } from "@/lib/redis";
import { primeMediaCache } from "@/lib/anilist/getMediaMeta";
import { anilistFetch } from "@/lib/anilist/anilistFetch";
import { getServerSession } from "next-auth";
import { authOptions } from "../../api/auth/[...nextauth]";
import { getCachedAnime } from "@/lib/db/anime";
import { loadFanarts, FanartPayload } from "@/lib/db/fanarts";
import { resolveSeasonChain, resolveSeasonList, SeasonEntry } from "@/lib/anilist/seasonChain";
import { toast } from "sonner";
import { Navbar } from "@/components/shared/NavBar";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import InfoPage from "@/components/anime/v2/InfoPage";
import InfoPageMobile from "@/components/anime/v2/mobile/InfoPageMobile";
import { useIsMobile } from "@/lib/hooks/useIsMobile";
import { pickTitleImage, slugifyTitle, SeasonInfo, TitleImage } from "@/components/anime/v2/helpers";

type InfoTypes = {
  info: AniListInfoTypes;
  color: string;
  api: string;
  chapterNotFound: string;
  fanarts: FanartPayload | null;
  /** Clearart/logo URL picked at SSR time so the <img> is in the
   *  initial HTML and starts streaming with the document. Carries a
   *  cycle queue for clearart so the client can swap images on click. */
  initialTitleImage: TitleImage | null;
  /** S<n> of N — resolved by walking PREQUEL/SEQUEL chains at SSR. */
  seasonInfo: SeasonInfo;
  /** Ordered list of season-like sibling entries (incl. current). */
  seasonList: SeasonEntry[];
  /** Pre-fetched list state for the signed-in user. SSR'd so the heart
   *  and the watch-button don't flash "empty" before useEffect resolves. */
  initialFav: boolean;
  initialStatusLabel: string | null;
  initialProgress: number;
  /** Useragent string sniffed at SSR so the very first render already
   *  picks the right mobile/desktop layout — no client-only flash. */
  initialUA: string | null;
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
const CACHE_VERSION = "v4";

export default function Info({
  info,
  chapterNotFound,
  fanarts,
  initialTitleImage,
  seasonInfo,
  seasonList,
  initialFav,
  initialStatusLabel,
  initialProgress,
  initialUA,
}: InfoTypes) {
  const isMobile = useIsMobile(initialUA);
  const { data: session }: any = useSession();
  const { toggleFavourite } = useAniList(session);
  const { t } = useTranslation();
  const router = useRouter();

  // Seed with the SSR-resolved values so the first paint already shows
  // the correct heart / list-status / resume-episode — no flash from
  // "empty" to "filled" on hydration.
  const [progress, setProgress] = useState<number>(initialProgress);
  const [statusLabel, setStatusLabel] = useState<string | null>(initialStatusLabel);
  const [domainUrl, setDomainUrl] = useState("");
  const [fav, setFav] = useState<boolean>(initialFav);

  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (chapterNotFound) {
      toast.error(t("anime.sourceNotFound"));
      const cleanUrl = window.location.origin + window.location.pathname;
      window.history.replaceState(null, "", cleanUrl);
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
    const expected = `/en/anime/${info.id}/${slug}`;
    const current = window.location.pathname;
    if (current === expected) return;
    // Only rewrite when the current path is the bare /en/anime/{id}
    // form — don't touch URLs that already carry some other segment
    // the user typed manually.
    if (current === `/en/anime/${info.id}` || current === `/en/anime/${info.id}/`) {
      const search = window.location.search || "";
      const hash = window.location.hash || "";
      window.history.replaceState(null, "", expected + search + hash);
    }
  }, [info?.id, info?.title]);

  // Reset modal + capture domain on first mount.
  useEffect(() => {
    handleClose();
    setDomainUrl(window.location.origin);
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
  }, [info?.id, initialProgress, initialStatusLabel, initialFav]);

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

      // 3. Then warm EVERY other available server (api/hls) in the background
      //    at low priority, so switching to any of them on the watch page is
      //    instant. The watch page's own probes also seed this cache, but
      //    warming here means they're ready before the user even navigates.
      const rest = SERVERS.filter(
        (s: any) =>
          (s.type === "hls" || s.type === "api") &&
          !prioritised.includes(s.id),
      ).map((s: any) => s.id);
      for (const srv of rest) void warmServer(srv, "low");
    };

    // ── Tier 2: nice-to-have warmups, deferred to a real idle moment ───
    // AniSkip chapter data shares SKIP_MEMO with the watch page; it only
    // matters once the video reports its duration, so it can wait for idle.
    const runIdle = () => {
      if (cancelled) return;
      if (malId) void prefetchSkips(malId, resumeEp, info.id);
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
     and surface a toast. Requires the user to be signed in. */
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
      toast.error(t("anime.couldntUpdateFav", { message: e?.message || t("anime.unknown") }));
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
  const watchUrl = info
    ? `/en/anime/watch/${info.id}/megaplay?id=megaplay-${info.id}-${
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
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={`AniScroll - ${title}`} />
        <meta
          name="twitter:description"
          content={`${info?.description?.slice(0, 180) || ""}...`}
        />
        <meta
          name="twitter:image"
          content={`${domainUrl}/api/og?title=${encodeURIComponent(title)}&image=${
            info?.bannerImage || info?.coverImage?.extraLarge || ""
          }`}
        />
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
        {initialTitleImage?.url && (
          <link
            rel="preload"
            as="image"
            href={initialTitleImage.url}
            // @ts-expect-error fetchPriority not in lib.dom yet
            fetchpriority="high"
          />
        )}
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
      </Head>

      <Navbar info={info} />

      <Modal open={open} onClose={() => handleClose()}>
        <div>
          {!session && (
            <div className="flex-center flex-col gap-5 px-10 py-5 bg-secondary rounded-md">
              <div className="text-md font-extrabold font-karla">Edit your list</div>
              <button
                className="flex items-center bg-[#363642] rounded-md text-white p-1"
                onClick={() => signIn("AniListProvider")}
              >
                <h1 className="px-1 font-bold font-karla">Login with AniList</h1>
                <div className="scale-[60%] pb-[1px]">
                  <AniList />
                </div>
              </button>
            </div>
          )}
          {session && info && (
            <ListEditor
              animeId={info.id}
              session={session}
              stats={statusLabel || undefined}
              prg={progress}
              max={info?.episodes ?? undefined}
              info={info}
              close={handleClose}
            />
          )}
        </div>
      </Modal>

      <MobileNav hideProfile={true} />

      <main>
        {isMobile ? (
          <InfoPageMobile
            info={info}
            initialFanarts={fanarts}
            initialTitleImage={initialTitleImage}
            seasonInfo={seasonInfo}
            seasonList={seasonList}
            statusLabel={statusLabel}
            fav={fav}
            progress={progress}
            watchUrl={watchUrl}
            onOpenListEditor={handleOpen}
            onToggleFav={handleToggleFav}
          />
        ) : (
          <InfoPage
            info={info}
            initialFanarts={fanarts}
            initialTitleImage={initialTitleImage}
            seasonInfo={seasonInfo}
            seasonList={seasonList}
            statusLabel={statusLabel}
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

/* Per-user list state fetched at SSR so the heart + watch button
   render correct on the first paint. Returns the empty shape when
   the user isn't signed in or AniList doesn't have a list entry yet.
   Uses the user's token through the global limiter; AniList returns
   isFavourite + mediaListEntry in a single small query. */
async function loadUserListState(
  aniId: number,
  accessToken: string | null
): Promise<{ fav: boolean; statusLabel: string | null; progress: number }> {
  const empty = { fav: false, statusLabel: null, progress: 0 };
  if (!accessToken || !Number.isFinite(aniId)) return empty;
  const json = await anilistFetch({
    query: `
      query ($id: Int) {
        Media(id: $id) {
          isFavourite
          mediaListEntry { progress status }
        }
      }
    `,
    variables: { id: aniId },
    authToken: accessToken,
    timeoutMs: 3500,
    label: `userList:${aniId}`,
    cacheSeconds: 0,
  });
  const media = json?.data?.Media;
  if (!media) return empty;
  return {
    fav: media.isFavourite === true,
    statusLabel: media.mediaListEntry?.status ?? null,
    progress: Number(media.mediaListEntry?.progress) || 0,
  };
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

export async function getServerSideProps(ctx: any) {
  const { id, notfound } = ctx.query;
  const timer = makeTimer();

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
    cache = await redis.get(cacheKey);
  }
  timer.mark("redis");

  const animeIdNum = Number(id?.[0]);

  // The user-specific list/favourite is fetched in parallel with the
  // rest. It's the only piece we can't cache (per-user) but it's a
  // tiny query and we want it inline so the heart paints right.
  const session: any = await getServerSession(ctx.req, ctx.res, authOptions);
  timer.mark("session");
  const accessToken: string | null = session?.user?.token || null;
  const userListP = loadUserListState(animeIdNum, accessToken);

  // Edge-cache headers for anonymous SSR. The rendered HTML contains
  // zero user-specific bits when there's no session (heart, watch
  // status, progress all start empty and hydrate client-side), so we
  // can let Vercel's edge serve the same response to every visitor of
  // this PoP. AniList metadata changes slowly (episode count when a new
  // episode airs, status when a show finishes), so a 1 hour edge cache
  // with 24h stale-while-revalidate is safe — the worst case is a
  // viewer seeing an episode count that's off by one for an hour after
  // an airing, but the next visitor refreshes it in the background.
  //
  // We split the headers so:
  //  - `Cache-Control` controls the BROWSER cache (60s — so a hard
  //    refresh sees fresh data, no "stuck on yesterday's status").
  //  - `CDN-Cache-Control` controls Vercel's edge cache (1h + 24h SWR)
  //    — this is the line that actually saves Fast Origin Transfer.
  //
  // Logged-in responses include initialFav / initialStatusLabel from
  // the user's AniList list and MUST NOT be shared — for those, set
  // the response to private/no-store across the board.
  if (session) {
    ctx.res.setHeader("Cache-Control", "private, no-store");
  } else {
    ctx.res.setHeader("Cache-Control", "public, max-age=60");
    ctx.res.setHeader(
      "CDN-Cache-Control",
      "public, s-maxage=3600, stale-while-revalidate=86400",
    );
  }

  if (cache) {
    const { info, color } = JSON.parse(cache);

    // Banner + cover URLs are already in the cached `info`, so we can
    // tell the browser to start fetching them RIGHT NOW via Link:
    // headers — long before getServerSideProps finishes. These add ~0ms
    // to the response and shave ~200-500ms off image arrival time when
    // the SSR has to await downstream work below.
    if (info?.bannerImage) appendPreloadHeader(ctx.res, info.bannerImage);
    const coverUrl = info?.coverImage?.extraLarge || info?.coverImage?.large;
    if (coverUrl) appendPreloadHeader(ctx.res, coverUrl);

    // Resolve fanarts first so we can ALSO emit a preload header for
    // the clearart before we await the (slower) season-chain walk.
    // Single-row Turso read, typically <50ms.
    const fanarts = await loadFanarts(animeIdNum).catch(() => null);
    timer.mark("fanarts");
    const initialTitleImage = pickTitleImage(fanarts);
    if (initialTitleImage?.url) appendPreloadHeader(ctx.res, initialTitleImage.url);

    // Now wait on the slower stuff in parallel. The browser is already
    // pulling the images while these resolve.
    const [seasonInfo, seasonList, userList] = await Promise.all([
      resolveSeasonChain(animeIdNum).catch(() => ({ number: null, total: null })),
      resolveSeasonList(animeIdNum).catch(() => []),
      userListP.catch(() => ({ fav: false, statusLabel: null, progress: 0 })),
    ]);
    timer.end(`cache-hit id=${id?.[0]}`);
    return {
      props: {
        info,
        color,
        api: API_URI,
        chapterNotFound: chapterNotFound || null,
        fanarts,
        initialTitleImage,
        seasonInfo,
        seasonList,
        initialFav: userList.fav,
        initialStatusLabel: userList.statusLabel,
        initialProgress: userList.progress,
        initialUA: ctx.req?.headers?.["user-agent"] || null,
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

  // Banner + cover URLs are now known — push them into Link: headers so
  // the browser can start downloading while we await the rest.
  if (data?.bannerImage) appendPreloadHeader(ctx.res, data.bannerImage);
  const coverUrl = data?.coverImage?.extraLarge || data?.coverImage?.large;
  if (coverUrl) appendPreloadHeader(ctx.res, coverUrl);

  // Resolve fanarts ahead of the slower walker work so we can emit the
  // clearart preload header before the response body is sent.
  const fanarts = await loadFanarts(animeIdNum).catch(() => null);
  timer.mark("fanarts");
  const initialTitleImage = pickTitleImage(fanarts);
  if (initialTitleImage?.url) appendPreloadHeader(ctx.res, initialTitleImage.url);

  const seasonInfoP = resolveSeasonChain(animeIdNum).catch(
    () => ({ number: null, total: null })
  );
  const seasonListP = resolveSeasonList(animeIdNum).catch(
    () => [] as SeasonEntry[]
  );

  if (redis) {
    await redis.set(
      cacheKey,
      JSON.stringify({ info: data, color }),
      "EX",
      cacheTime
    );
  }

  const [seasonInfo, seasonList, userList] = await Promise.all([
    seasonInfoP,
    seasonListP,
    userListP.catch(() => ({ fav: false, statusLabel: null, progress: 0 })),
  ]);
  timer.end(`cache-miss id=${id?.[0]}`);

  return {
    props: {
      info: data,
      color,
      api: API_URI,
      chapterNotFound: chapterNotFound || null,
      fanarts,
      initialTitleImage,
      seasonInfo,
      seasonList,
      initialFav: userList.fav,
      initialStatusLabel: userList.statusLabel,
      initialProgress: userList.progress,
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
