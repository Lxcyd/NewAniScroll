import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { FlagIcon, ShareIcon } from "@heroicons/react/24/solid";
import Details from "@/components/watch/primary/details";
import EpisodeLists from "@/components/watch/secondary/episodeLists";
import ServerSelector from "@/components/watch/primary/serverSelector";
import dynamic from "next/dynamic";
// Vidstack uses Web Components — must be loaded client-only or hydration fails.
const UniversalPlayer = dynamic(
  () => import("@/components/watch/primary/UniversalPlayer"),
  {
    ssr: false,
    loading: () => (
      <div className="flex-center aspect-video w-full h-full bg-black rounded-card ring-1 ring-white/5" />
    ),
  }
);
import { getServerSession } from "next-auth";
import { useWatchProvider } from "@/lib/context/watchPageProvider";
import { authOptions } from "../../../api/auth/[...nextauth]";
import { getRemovedMedia } from "@/prisma/removed";
import { createList, createUser, getEpisode } from "@/prisma/user";
import { getServer } from "@/lib/servers";
import { primeMediaCache } from "@/lib/anilist/getMediaMeta";
import { getCachedAnime } from "@/lib/db/anime";
import { FULL_MEDIA_FIELDS } from "@/lib/anilist/fullMediaQuery";
import Link from "next/link";
import MobileNav from "@/components/shared/MobileNav";
import { Navbar } from "@/components/shared/NavBar";
import Modal from "@/components/modal";
import AniList from "@/components/media/aniList";
import { signIn } from "next-auth/react";
import BugReportForm from "@/components/shared/bugReport";
import Skeleton from "react-loading-skeleton";
import Head from "next/head";
import { useRouter } from "next/router";
import { Spinner } from "@vidstack/react";
import RateModal from "@/components/shared/RateModal";

// ─────────────────────────────────────────────────────────────
// SSR
// ─────────────────────────────────────────────────────────────
export async function getServerSideProps(context) {
  let userData = null;
  const session = await getServerSession(context.req, context.res, authOptions);
  const accessToken = session?.user?.token || null;

  const query = context?.query;
  if (!query) return { notFound: true };

  let proxy = process.env.PROXY_URI || null;
  if (proxy && proxy.endsWith("/")) proxy = proxy.slice(0, -1);
  const disqus = process.env.DISQUS_SHORTNAME || null;

  const [aniId, provider] = query?.info;
  const watchId   = query?.id;
  const epiNumber = query?.num;
  const dub       = query?.dub;

  const removed   = await getRemovedMedia();
  const isRemoved = removed?.find((i) => +i?.aniId === +aniId);
  if (isRemoved) {
    return { redirect: { destination: "/en/removed", permanent: false } };
  }

  // Hard 3s timeout — never let AniList block navigation. The page can hydrate
  // with `info=null` and re-fetch client-side if needed, instead of hanging the SSR.
  // Falls back to the persistent Turso cache if AniList is slow/down so the page
  // still renders something useful.
  let data = { data: { Media: null } };
  // DEV-only: setting ANILIST_SIMULATE_DOWN=1 short-circuits the AniList fetch
  // so we can verify the DB fallback path without actually downing AniList.
  const simulateDown = process.env.ANILIST_SIMULATE_DOWN === "1";
  try {
    if (simulateDown) throw new Error("simulated AniList outage");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const ress = await fetch(`https://graphql.anilist.co`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
      },
      // Pull the full Tier-1 payload + mediaListEntry. mediaListEntry is the
      // ONE piece we don't cache (per-user). Everything else gets persisted
      // so future requests survive an AniList outage.
      body: JSON.stringify({
        query: `query ($id: Int) {
          Media (id: $id) {
            mediaListEntry { progress status customLists repeat }
            ${FULL_MEDIA_FIELDS}
          }
        }`,
        variables: { id: aniId },
      }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (ress.ok) {
      data = await ress.json();
      // Prime memory + DB so source-API probes / refreshes can read instantly.
      if (data?.data?.Media) primeMediaCache(aniId, data.data.Media);
    }
  } catch (e) {
    console.warn(`[watch SSR] AniList fetch failed for ${aniId}:`, e.message);
  }

  // Fallback to DB cache when AniList didn't return Media (timeout/down/non-200).
  // Stale data is fine here — better than rendering an empty page.
  if (!data?.data?.Media) {
    try {
      const cached = await getCachedAnime(Number(aniId));
      if (cached?.data) {
        console.log(`[watch SSR] using DB cache for ${aniId} (stale=${cached.isStale})`);
        // Preserve the AniList-only mediaListEntry (we never cache it).
        data = { data: { Media: { ...cached.data, mediaListEntry: null } } };
      }
    } catch (e) {
      console.warn(`[watch SSR] DB fallback failed for ${aniId}:`, e?.message);
    }
  }

  try {
    if (session) {
      await createUser(session.user.name);
      await createList(session.user.name, watchId);
      const epData = await getEpisode(session.user.name, watchId);
      userData = JSON.parse(
        JSON.stringify(epData, (key, value) =>
          key === "createdDate" ? String(value) : value
        )
      );
    }
  } catch (error) {
    console.error(error);
  }

  return {
    props: {
      sessions:   session,
      provider:   provider || null,
      watchId:    watchId  || null,
      epiNumber:  epiNumber || null,
      dub:        dub || null,
      userData:   userData?.[0] || null,
      info:       data?.data?.Media || null,
      proxy,
      disqus,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Page component
// ─────────────────────────────────────────────────────────────
export default function Watch({
  info,
  watchId,
  disqus,
  proxy,
  dub,
  userData,
  sessions,
  provider,
  epiNumber,
}) {
  const [artStorage,        setArtStorage]        = useState(null);
  const [episodeNavigation, setEpisodeNavigation] = useState(null);
  const [episodesList,      setepisodesList]      = useState();
  const [mapEpisode,        setMapEpisode]        = useState(null);
  const [open,              setOpen]              = useState(false);
  const [isOpen,            setIsOpen]            = useState(false);
  const [onList,            setOnList]            = useState(false);

  // ── Server state ──
  // Stable initial value to avoid SSR/CSR hydration mismatch.
  // The user's saved preference is loaded after mount in a useEffect below.
  const [activeServer, setActiveServer] = useState("megaplay");
  const [hlsData, setHlsData]           = useState(null);
  const [hlsLoading, setHlsLoading]     = useState(false);
  // Map<serverId, reason string> — failed servers (kept for tracking, hidden from UI)
  const [failedServers, setFailedServers] = useState(new Map());
  // Set<serverId> — servers that returned a valid source (visible in UI)
  const [confirmedServers, setConfirmedServers] = useState(new Set());

  // Mirror of failedServers for sync reads inside markFailed without forcing
  // markFailed to depend on failedServers (which would invalidate fetchStreamSource
  // every probe and cancel in-flight requests).
  const failedServersRef = useRef(failedServers);
  useEffect(() => { failedServersRef.current = failedServers; }, [failedServers]);

  const markConfirmed = useCallback((id) => {
    setConfirmedServers((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  // Track server preference order — favorite working servers come first
  const PREFERRED_FALLBACK_ORDER = [
    "megaplay",
    "hianime-vidsrc",
    "hianime-megacloud",
    "hianime-tcloud",
    "animesaturn",
    "animesama-sibnet",
    "animesama-sendvid",
    "animesama-oneupload",
    "animesama-embed4me",
    "animesama-callistanise",
    "voiranime-voe",
    "voiranime-streamtape",
    "animesama-sibnet-vo",
    "animesama-sendvid-vo",
    "animesama-embed4me-vo",
    "voiranime-voe-vo",
    "voiranime-streamtape-vo",
  ];

  const markFailed = useCallback((id, reason) => {
    setFailedServers((prev) => {
      if (prev.get(id) === reason) return prev;
      const next = new Map(prev);
      next.set(id, reason);
      return next;
    });

    // Auto-fallback: if the active server is the one that failed, switch to the
    // next working server (prefer same language). Don't write to localStorage —
    // we want to remember the user's intentional choice.
    setActiveServer((current) => {
      if (current !== id) return current;
      const SERVERS = require("@/lib/servers").default;
      const failedDef = SERVERS.find((s) => s.id === id);
      const failedLang = failedDef?.lang;

      // Build candidate list from PREFERRED_FALLBACK_ORDER, filtered by:
      //  - not the failed server
      //  - not in the failedServers map
      //  - matching language (or "multi") when possible
      const failedSet = new Set([...failedServersRef.current.keys(), id]);
      const isCandidate = (sid) => {
        if (sid === id || failedSet.has(sid)) return false;
        return SERVERS.some((s) => s.id === sid);
      };

      // Try same-lang candidates first
      let next = PREFERRED_FALLBACK_ORDER.find((sid) => {
        if (!isCandidate(sid)) return false;
        const s = SERVERS.find((x) => x.id === sid);
        return s.lang === failedLang || s.lang === "multi";
      });
      // Then any candidate
      if (!next) {
        next = PREFERRED_FALLBACK_ORDER.find(isCandidate);
      }
      // Final fallback: any non-failed server in the lib
      if (!next) {
        next = SERVERS.find((s) => !failedSet.has(s.id))?.id;
      }
      return next || current;
    });
  }, []);

  // Load the user's saved preferred server after hydration.
  // Done in useEffect (not lazy useState) to avoid SSR/CSR mismatch.
  // We also patch the URL so the slug reflects the actual server in use,
  // not the static "megaplay" the route was initialised with. Otherwise
  // visiting /watch/{id}/megaplay would show "megaplay" forever even when
  // the user previously chose a different server.
  useEffect(() => {
    const saved = localStorage.getItem("preferred_server");
    if (saved && saved !== "megaplay") {
      setActiveServer(saved);
      try {
        const url = new URL(window.location.href);
        const segs = url.pathname.split("/");
        if (segs.length >= 6 && segs[5] && segs[5] !== saved) {
          segs[5] = saved;
          url.pathname = segs.join("/");
          window.history.replaceState(null, "", url.toString());
        }
      } catch {}
    }
  }, []);

  const router = useRouter();

  // Decorate the URL with a human-readable slug after the
  // /watch/{id}/{provider} segments. The [...info] route already
  // ignores extra path parts, so this is purely cosmetic — old links
  // without the slug keep working. We strip diacritics + lower-case
  // + collapse non-alphanumerics into single dashes.
  useEffect(() => {
    if (!info?.id) return;
    const title =
      info?.title?.english || info?.title?.romaji || info?.title?.userPreferred;
    if (!title) return;
    const slug = title
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    if (!slug) return;
    const path = window.location.pathname;
    // Path shape: /en/anime/watch/{id}/{provider}[/{slug}]
    const parts = path.split("/").filter(Boolean);
    // ["en", "anime", "watch", "{id}", "{provider}", ...]
    if (parts.length < 5) return;
    if (parts.length === 5 || parts[5] !== slug) {
      const base = `/${parts.slice(0, 5).join("/")}`;
      const next = `${base}/${slug}${window.location.search}${window.location.hash}`;
      window.history.replaceState(null, "", next);
    }
  }, [info?.id, info?.title?.english, info?.title?.romaji, info?.title?.userPreferred]);

  const {
    theaterMode,
    autoplay,
    setAutoNext,
    setAutoPlay,
    setMarked,
    setPlayerState,
    setTrack,
    aspectRatio,
    setDataMedia,
    ratingModalState,
    setRatingModalState,
  } = useWatchProvider();

  // ── Persist into local Recently Watched immediately ──────────
  // Runs as soon as we know which anime + episode the user opened. We
  // don't wait for the episode list to come back from the API because
  // that fetch can fail (404 on source) and we still want the row in
  // history. We refine it later (image / nextId) once data arrives.
  useEffect(() => {
    if (!info?.id) return;
    try {
      const raw = localStorage.getItem("artplayer_settings");
      const existing = raw ? JSON.parse(raw) : {};
      const entryKey = `${info.id}-${epiNumber}-${dub ? "dub" : "sub"}`;
      existing[entryKey] = {
        ...(existing[entryKey] || {}),
        watchId: watchId || entryKey,
        aniId: info.id,
        aniTitle: info?.title?.romaji || info?.title?.english,
        title: `Episode ${epiNumber}`,
        image:
          info?.coverImage?.extraLarge ||
          info?.coverImage?.large ||
          info?.bannerImage,
        episode: Number(epiNumber),
        provider,
        dub: !!dub,
        createdAt: new Date().toISOString(),
      };
      localStorage.setItem("artplayer_settings", JSON.stringify(existing));
    } catch {}
  }, [info?.id, epiNumber, dub, provider, watchId]);

  // ── Episode list + navigation ────────────────────────────────
  useEffect(() => {
    // Reset server-state for the new episode at the START of the effect, not in
    // the cleanup. In React 18 dev/Strict Mode the cleanup fires between the two
    // mount passes and would clobber probe results that completed in the first
    // pass — anime-sama / hianime servers would silently disappear from the UI.
    setFailedServers(new Map());
    setConfirmedServers(new Set());

    async function getInfo() {
      if (!info) return;
      if (info.mediaListEntry) setOnList(true);
      setDataMedia(info);

      const raw = await fetch(
        `/api/v2/episode/${info.id}?releasing=${
          info.status === "RELEASING" ? "true" : "false"
        }${dub ? "&dub=true" : ""}`
      ).then((res) => res.json());

      const response = Array.isArray(raw) ? raw : [];
      const getMap  = response.find((i) => i?.map === true) || response[0];
      let   episodes = response;

      if (getMap) {
        setMapEpisode(getMap?.episodes);
      }

      if (episodes) {
        const getProvider = episodes?.find((i) => i.providerId === provider)
          || episodes?.[0];
        const episodeList = getProvider?.episodes.slice(
          0,
          getMap?.episodes?.length ?? getProvider?.episodes?.length
        );
        const playingData = getMap?.episodes.find(
          (i) => i.number === Number(epiNumber)
        );

        if (getProvider && episodeList?.length > 0) {
          setepisodesList(episodeList);
          const epNum = parseInt(epiNumber);
          const currentEpisode  = episodeList?.find((i) => i.number === epNum)
            || { id: `megaplay-${info.id}-${epNum}`, number: epNum };
          const nextEpisode     = episodeList?.find((i) => i.number === epNum + 1);
          const previousEpisode = episodeList?.find((i) => i.number === epNum - 1);

          const vidNav = {
            prev: previousEpisode,
            playing: {
              id:          currentEpisode.id,
              title:       playingData?.title || info?.title?.romaji,
              description: playingData?.description,
              img:         playingData?.img   || playingData?.image,
              number:      currentEpisode.number,
            },
            next: nextEpisode,
          };
          setEpisodeNavigation(vidNav);

          // Persist this episode into the local "recently watched" history.
          // The Recently Watched page (and the home carousel) reads from
          // `artplayer_settings` in localStorage. We write a row keyed on
          // watchId so opening an episode immediately appears there. The
          // server-side history (Prisma) is updated separately by the
          // logged-in flow but local storage covers the anonymous case.
          try {
            const raw = localStorage.getItem("artplayer_settings");
            const existing = raw ? JSON.parse(raw) : {};
            const entryKey = String(currentEpisode.id);
            existing[entryKey] = {
              ...(existing[entryKey] || {}),
              watchId: currentEpisode.id,
              aniId: info.id,
              aniTitle: info?.title?.romaji || info?.title?.english,
              title:
                playingData?.title ||
                `Episode ${currentEpisode.number}`,
              image:
                playingData?.img || playingData?.image || info?.coverImage?.large,
              episode: currentEpisode.number,
              // `getProvider` is the full provider object — store just the
              // id string so the home / recently-watched UIs can compose
              // a watch URL without serialising "[object Object]".
              provider: getProvider?.providerId || provider,
              nextId: nextEpisode?.id || null,
              nextNumber: nextEpisode?.number || null,
              dub: !!dub,
              createdAt: new Date().toISOString(),
            };
            localStorage.setItem("artplayer_settings", JSON.stringify(existing));
          } catch {}
        }
      }

      setArtStorage(JSON.parse(localStorage.getItem("artplayer_settings") || "null"));
    }

    getInfo();
    return () => {
      setEpisodeNavigation(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions?.user?.name, epiNumber, dub]);

  // ── Auto-next / auto-play + skip data ───────────────────────
  // autoplay/autoNext are now hydrated from localStorage by WatchPageProvider
  // itself (single source of truth + automatic persistence), so we don't read
  // them here anymore.
  useEffect(() => {
    async function fetchSkip() {
      if (!info?.idMal) return;
      try {
        const skip = await fetch(
          `https://api.aniskip.com/v2/skip-times/${info.idMal}/${parseInt(
            epiNumber
          )}?types[]=ed&types[]=mixed-ed&types[]=mixed-op&types[]=op&types[]=recap&episodeLength=`
        ).then((res) => (res.ok ? res.json() : null));

        const getOp = skip?.results?.find((item) => item.skipType === "op") || null;
        const getEd = skip?.results?.find((item) => item.skipType === "ed") || null;

        const skipData = [
          getOp ? { startTime: Math.round(getOp.interval.startTime), endTime: Math.round(getOp.interval.endTime), text: "Opening" } : null,
          getEd ? { startTime: Math.round(getEd.interval.startTime), endTime: Math.round(getEd.interval.endTime), text: "Ending"  } : null,
        ].filter(Boolean);

        setTrack({ skip: skipData });
      } catch (e) {
        console.error("Skip fetch error:", e);
      }
    }

    fetchSkip();

    return () => {
      setPlayerState({ currentTime: 0, isPlaying: false });
      setMarked(0);
      setTrack(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, watchId, info?.id]);

  // ── Fetch stream source when server needs backend (hls or api) ──
  // Tracks the latest in-flight request so server-change / navigation aborts it.
  const activeFetchCtrl = useRef(null);

  // Slim AniList metadata payload — sent with every probe so the source API
  // skips its own AniList fetches (one batched fetch per page instead of per probe).
  const mediaMetaPayload = info ? {
    id: info.id,
    title: info.title,
    synonyms: info.synonyms,
    relations: info.relations,
  } : null;

  const fetchStreamSource = useCallback(async (serverId, signal) => {
    const server = getServer(serverId);
    if (server.type === "iframe") {
      setHlsData(null);
      return;
    }

    setHlsLoading(true);
    setHlsData(null);

    try {
      const res = await fetch("/api/v2/source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          server: serverId,
          aniId: info.id,
          episode: parseInt(epiNumber),
          sub: dub ? "dub" : "sub",
          title: info?.title?.romaji || info?.title?.english,
          mediaMeta: mediaMetaPayload,
        }),
        signal,
      });

      if (signal?.aborted) return;

      if (res.ok) {
        const data = await res.json();
        setHlsData(data);
        markConfirmed(serverId);
      } else {
        setHlsData({ error: true });
        markFailed(serverId, `HTTP ${res.status}`);
      }
    } catch (e) {
      if (e.name === "AbortError") return;
      setHlsData({ error: true });
      markFailed(serverId, "Network error");
    } finally {
      if (!signal?.aborted) setHlsLoading(false);
    }
  }, [info?.id, epiNumber, dub, markFailed]);

  useEffect(() => {
    // Abort any previous in-flight fetch before starting a new one
    activeFetchCtrl.current?.abort();
    const ctrl = new AbortController();
    activeFetchCtrl.current = ctrl;
    fetchStreamSource(activeServer, ctrl.signal);
    return () => ctrl.abort();
  }, [activeServer, fetchStreamSource]);

  // ── Pre-check all servers on page load ─────────────────────
  // Probes are batched (max N concurrent) to avoid overwhelming the dev server
  // and to keep navigation snappy. Aborted on episode change / unmount.
  //
  // Probe lifecycle for each server:
  //   1st attempt → 200 with valid streams/iframe         → confirmed
  //                 200 with { error } or empty payload   → retry after 3s
  //                 5xx / network / timeout               → retry after 3s
  //                 404 ("Source not found")              → terminal failed
  //   2nd attempt → 200 with valid streams/iframe         → confirmed
  //                 anything else                         → failed
  //
  // Why retry: anime-sama / fanart.tv / vidmoly occasionally rate-limit or
  // throw transient 503s, especially when 8 probes hit at once. Without retry
  // a perfectly working server gets hidden because it lost a single dice roll.
  useEffect(() => {
    if (!info?.id || !epiNumber) return;

    const SERVERS = require("@/lib/servers").default;
    // Probe every API/HLS server, including the currently active one.
    // (We previously skipped activeServer to save one request, but that
    // meant if the user changed away from the default before the probe
    // completed, the original default never got marked as confirmed and
    // disappeared from the selector.)
    const toProbe = SERVERS.filter(
      (s) => s.type === "hls" || s.type === "api"
    );

    const controller = new AbortController();
    const MAX_CONCURRENT = 8;
    const RETRY_DELAY_MS = 3000;
    let cancelled = false;

    const probeMeta = info ? {
      id: info.id,
      title: info.title,
      synonyms: info.synonyms,
      relations: info.relations,
    } : null;

    // Returns: "ok" | "retry" | "fail-404" | "abort"
    // We parse the body so a 200 with { error } counts as "retry", not "ok".
    const attemptProbe = async (s) => {
      try {
        const res = await fetch("/api/v2/source", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            server: s.id,
            aniId: info.id,
            episode: parseInt(epiNumber),
            sub: dub ? "dub" : "sub",
            title: info?.title?.romaji || info?.title?.english,
            mediaMeta: probeMeta,
          }),
          signal: controller.signal,
        });

        if (res.status === 404) return "fail-404";
        if (!res.ok) return "retry"; // 5xx, 429, anything non-2xx

        // 200 — but the backend sometimes wraps an extractor failure as
        // { error: "..." } or returns nothing playable. Validate the shape.
        let body;
        try { body = await res.json(); } catch { return "retry"; }
        if (body?.error) return "retry";
        const hasStream =
          (Array.isArray(body?.streams) && body.streams.length > 0) ||
          (Array.isArray(body?.sources) && body.sources.length > 0) ||
          (typeof body?.iframe === "string" && body.iframe.length > 0);
        return hasStream ? "ok" : "retry";
      } catch (e) {
        if (e?.name === "AbortError") return "abort";
        return "retry"; // network / DNS / timeout
      }
    };

    const probe = async (s) => {
      const first = await attemptProbe(s);
      if (first === "abort" || cancelled) return;
      if (first === "ok") return markConfirmed(s.id);
      if (first === "fail-404") return markFailed(s.id, "Source not found");

      // Transient — wait, then try once more before giving up.
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      if (cancelled || controller.signal.aborted) return;

      const second = await attemptProbe(s);
      if (second === "abort" || cancelled) return;
      if (second === "ok") return markConfirmed(s.id);
      if (second === "fail-404") return markFailed(s.id, "Source not found");
      // Two transient failures in a row — call it broken.
      markFailed(s.id, "Source unavailable");
    };

    (async () => {
      for (let i = 0; i < toProbe.length && !cancelled; i += MAX_CONCURRENT) {
        const batch = toProbe.slice(i, i + MAX_CONCURRENT);
        await Promise.all(batch.map(probe));
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.id, epiNumber, dub]);

  // ── Iframe-type validators ─────────────────────────────────
  // Some iframe hosts (Megaplay, 4Animo) serve a 200 HTML error page when the
  // requested episode doesn't exist — the iframe itself loads fine, so our
  // load-timeout never triggers. They expose CORS wildcard though, so we can
  // fetch their HTML client-side and detect known error markers.
  useEffect(() => {
    if (!info?.id || !epiNumber) return;
    const SERVERS = require("@/lib/servers").default;
    const dubFlag = !!dub;

    // Iframe-type validators were used for Megaplay/4Animo but both servers
    // are now removed (Megaplay is type:"api" with its own extractor; 4Animo
    // was retired). Keeping the structure as an empty map in case a future
    // iframe server needs the same kind of HTML-content sanity check.
    const validators = {};

    const controller = new AbortController();
    let cancelled = false;

    // Same retry semantics as the main probe: transient errors (5xx, network)
    // get a 3s second chance; only a hard 404 or repeated failure marks the
    // server unavailable.
    const RETRY_DELAY_MS = 3000;

    // Returns "ok" | "retry" | "fail-404" | "fail-content" | "abort"
    const attempt = async (cfg) => {
      try {
        const res = await fetch(cfg.url, {
          method: "GET",
          mode: "cors",
          signal: controller.signal,
        });
        if (res.status === 404) return "fail-404";
        if (!res.ok) return "retry";
        const html = await res.text();
        if (cfg.badMarkers.some((m) => html.includes(m))) return "fail-content";
        return "ok";
      } catch (e) {
        if (e?.name === "AbortError") return "abort";
        return "retry";
      }
    };

    const validate = async (serverId, cfg) => {
      if (!SERVERS.find((s) => s.id === serverId)) return;

      const first = await attempt(cfg);
      if (first === "abort" || cancelled) return;
      if (first === "ok") return markConfirmed(serverId);
      if (first === "fail-404") return markFailed(serverId, "HTTP 404");
      if (first === "fail-content") return markFailed(serverId, "Episode not available");

      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      if (cancelled || controller.signal.aborted) return;

      const second = await attempt(cfg);
      if (second === "abort" || cancelled) return;
      if (second === "ok") return markConfirmed(serverId);
      if (second === "fail-404") return markFailed(serverId, "HTTP 404");
      if (second === "fail-content") return markFailed(serverId, "Episode not available");
      // Two transient failures — let the iframe load attempt itself decide
      // (CORS error specifically: leaving unconfirmed without marking failed
      // means an iframe-typed server stays visible by default; if its load
      // also times out the runtime markFailed will catch it).
    };

    Object.entries(validators).forEach(([id, cfg]) => {
      if (!cancelled) validate(id, cfg);
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.id, epiNumber, dub]);

  // ── Server change handler ──────────────────────────────────
  const handleServerChange = useCallback((serverId) => {
    setActiveServer(serverId);
    localStorage.setItem("preferred_server", serverId);
    // Reflect the chosen provider in the URL so bookmarks / shares /
    // browser-back work correctly. `replace` (not `push`) so the back
    // button doesn't trap the user in their server-switch history.
    try {
      const url = new URL(window.location.href);
      const segs = url.pathname.split("/");
      // /en/anime/watch/{aniId}/{provider}
      if (segs.length >= 6 && segs[5]) {
        segs[5] = serverId;
        url.pathname = segs.join("/");
        window.history.replaceState(null, "", url.toString());
      }
    } catch {}
  }, []);

  // ── Media Session (OS-level now playing) ────────────────────
  useEffect(() => {
    const mediaSession = navigator.mediaSession;
    if (!mediaSession) return;

    const now    = episodeNavigation?.playing;
    const poster = now?.img || info?.bannerImage;
    const title  = now?.title || info?.title?.romaji;

    mediaSession.metadata = new MediaMetadata({
      title,
      artist: `AniScroll ${
        title === info?.title?.romaji
          ? "- Episode " + epiNumber
          : `- ${info?.title?.romaji || info?.title?.english}`
      }`,
      artwork: poster ? [{ src: poster, sizes: "512x512", type: "image/jpeg" }] : undefined,
    });
  }, [episodeNavigation, info, epiNumber]);

  // ── Share ────────────────────────────────────────────────────
  const handleShareClick = async () => {
    try {
      if (navigator.share) {
        await navigator.share({
          title: `Watch Now - ${info?.title?.english || info.title.romaji}`,
          url: window.location.href,
        });
      } else {
        alert("Web Share API is not supported in this browser.");
      }
    } catch (error) {
      console.error("Error sharing:", error);
    }
  };

  function handleOpen()  { setOpen(true);  document.body.style.overflow = "hidden"; }
  function handleClose() { setOpen(false); document.body.style.overflow = "auto";   }

  // ── Player ───────────────────────────────────────────────────
  // Memoized JSX — recomputes ONLY when player-relevant state changes.
  // Wrapping as a function component (`function Player(){}` defined inside Watch)
  // would create a new function reference each parent render → React would treat
  // it as a different component type and fully unmount/remount the iframe/HLS
  // player on every probe completion, restarting playback. useMemo avoids this.
  const playerNode = useMemo(() => {
    const server = getServer(activeServer);
    const needsBackend = server.type === "hls" || server.type === "api";

    if (!episodeNavigation || (needsBackend && hlsLoading)) {
      return (
        <div className="flex-center aspect-video w-full h-full relative">
          <SpinLoader />
        </div>
      );
    }

    if (needsBackend) {
      if (hlsData?.error) {
        return (
          <div className="flex-center aspect-video w-full h-full bg-black text-white/50 font-karla flex-col gap-2 rounded-card ring-1 ring-white/5">
            <p>Server "{server.name}" unavailable</p>
            <button
              type="button"
              onClick={() => handleServerChange("megaplay")}
              className="text-as-accent underline text-sm"
            >
              Switch to Megaplay
            </button>
          </div>
        );
      }

      // Unified player: Vidstack for direct streams (HLS/MP4 with speed /
      // quality / captions / chromecast / PiP / ambient light), iframe chrome
      // for embed-only hosts (vidmoly, voe, streamtape, hianime).
      return (
        <UniversalPlayer
          key={`${server.id}-${info.id}-${epiNumber}-${dub ? "dub" : "sub"}`}
          autoplay={!!autoplay}
          streamData={hlsData}
          poster={episodeNavigation?.playing?.img || info?.bannerImage}
          serverId={server.id}
          downloadName={`${(info?.title?.romaji || info?.title?.english || "anime").replace(/\s+/g, "_")}_E${epiNumber}${dub ? "_DUB" : ""}`}
          onError={(reason) =>
            markFailed(
              server.id,
              reason || (hlsData?.iframe ? "Iframe load timeout" : "Playback failed")
            )
          }
        />
      );
    }

    // buildSrc-style server (Megaplay): always an iframe → same universal chrome
    const src = server.buildSrc({
      aniId: info.id,
      episode: epiNumber,
      dub: !!dub,
    });

    return (
      <UniversalPlayer
        key={`${server.id}-${info.id}-${epiNumber}-${dub ? "dub" : "sub"}`}
        streamData={{ iframe: src }}
        poster={episodeNavigation?.playing?.img || info?.bannerImage}
        serverId={server.id}
        onError={(reason) => markFailed(server.id, reason || "Iframe load timeout")}
      />
    );
  }, [activeServer, episodeNavigation, hlsLoading, hlsData, info, epiNumber, dub, markFailed, handleServerChange, autoplay]);

  // ── Render ───────────────────────────────────────────────────
  return (
    <>
      <Head>
        <title>
          {episodeNavigation?.playing?.title ||
            `${info?.title?.romaji} - Episode ${epiNumber}`}
        </title>
        <meta
          name="title"
          data-title-romaji={info?.title?.romaji}
          data-title-english={info?.title?.english}
          data-title-native={info?.title?.native}
        />
        <meta name="twitter:card"    content="summary_large_image" />
        <meta name="description"     content={episodeNavigation?.playing?.description || info?.description} />
        <meta name="keywords"        content="anime, anime streaming, anime streaming website, anime streaming free" />
        <meta name="robots"          content="index, follow" />
        <meta property="og:type"     content="website" />
        <meta property="og:title"    content={`Watch - ${episodeNavigation?.playing?.title || info?.title?.english}`} />
        <meta property="og:description" content={episodeNavigation?.playing?.description || info?.description} />
        <meta property="og:image"    content={episodeNavigation?.playing?.img || info?.bannerImage} />
        <meta property="og:site_name" content="AniScroll" />
        <meta name="twitter:image"   content={episodeNavigation?.playing?.img || info?.bannerImage} />
        <meta name="twitter:title"   content={`Watch - ${episodeNavigation?.playing?.title || info?.title?.english}`} />
        <meta name="twitter:description" content={episodeNavigation?.playing?.description || info?.description} />
      </Head>

      {/* AniList login modal */}
      <Modal open={open} onClose={() => handleClose()}>
        {!sessions && (
          <div className="flex-center flex-col gap-5 px-10 py-5 bg-secondary rounded-md">
            <h1 className="text-md font-extrabold font-karla">Edit your list</h1>
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
      </Modal>

      <BugReportForm isOpen={isOpen} setIsOpen={setIsOpen} />

      <main className="w-screen h-full">
        {!ratingModalState.isFullscreen && (
          <RateModal
            toggle={ratingModalState.isOpen}
            setToggle={setRatingModalState}
            position="bottom"
            session={sessions}
          />
        )}

        <Navbar
          scrollP={20}
          withNav={true}
          shrink={true}
          paddingY={`py-2 ${theaterMode ? "" : "lg:py-4"}`}
        />
        <MobileNav hideProfile={true} sessions={sessions} />

        <div className={`mx-auto pt-16 ${theaterMode ? "lg:pt-16" : "lg:pt-20"}`}>

          {/* Theater mode player — no parent bg/overflow so ambient glow can extend outside */}
          {theaterMode && (
            <div
              className="w-full max-h-[84dvh] h-full flex-center"
              style={{ aspectRatio }}
            >
              {playerNode}
            </div>
          )}

          <div
            id="default"
            className={`${
              theaterMode ? "lg:max-w-[95%] xl:max-w-[80%]" : "lg:max-w-[95%]"
            } w-full flex flex-col lg:flex-row mx-auto`}
          >
            {/* ── Primary column ── */}
            <div id="primary" className="w-full">

              {/* Default (non-theater) player — no parent bg/overflow so ambient glow can extend outside */}
              {!theaterMode && (
                <div
                  className={`w-full flex-center ${
                    aspectRatio === "4/3" ? "aspect-video" : ""
                  }`}
                >
                  {playerNode}
                </div>
              )}

              {/* Server selector */}

              <div className="px-3 lg:px-0">
                <ServerSelector
                  activeServer={activeServer}
                  onChange={handleServerChange}
                  failedServers={failedServers}
                  confirmedServers={confirmedServers}
                />
              </div>

              {/* Details row */}
              <div id="details" className="flex flex-col gap-5 w-full px-3 lg:px-0">
                <div className="flex items-end justify-between pt-3 border-b-2 border-secondary pb-2">
                  <div className="w-[55%]">
                    <div className="flex font-outfit font-semibold text-lg lg:text-2xl text-white line-clamp-1">
                      <Link
                        href={`/en/anime/${info?.id}`}
                        className="hover:underline line-clamp-1"
                      >
                        {episodeNavigation?.playing?.title || info?.title?.romaji || "Loading..."}
                      </Link>
                    </div>
                    <h3 className="font-karla">
                      {episodeNavigation?.playing?.number ? (
                        `Episode ${episodeNavigation?.playing?.number}`
                      ) : (
                        <Skeleton width={120} height={16} />
                      )}
                    </h3>
                  </div>

                  <div className="flex gap-2 text-sm">
                    <button
                      type="button"
                      onClick={handleShareClick}
                      className="flex items-center gap-2 px-3 py-1 ring-[1px] ring-white/20 rounded overflow-hidden"
                    >
                      <ShareIcon className="w-5 h-5" />
                      <span className="hidden lg:block">share</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsOpen(true)}
                      className="flex items-center gap-2 px-3 py-1 ring-[1px] ring-white/20 rounded overflow-hidden"
                    >
                      <FlagIcon className="w-5 h-5" />
                      <span className="hidden lg:block">report</span>
                    </button>
                  </div>
                </div>

                <Details
                  info={info}
                  session={sessions}
                  description={info?.description}
                  epiNumber={epiNumber}
                  id={info}
                  onList={onList}
                  setOnList={setOnList}
                  handleOpen={() => handleOpen()}
                />
              </div>
            </div>

            {/* ── Secondary column (episode list) ── */}
            <div
              id="secondary"
              className={`relative ${theaterMode ? "pt-5" : "pt-4 lg:pt-0"}`}
            >
              <EpisodeLists
                info={info}
                session={sessions}
                map={mapEpisode}
                providerId={provider}
                watchId={watchId}
                episode={episodesList}
                artStorage={artStorage}
                track={episodeNavigation}
                dub={dub}
              />
            </div>
          </div>
        </div>
      </main>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function SpinLoader() {
  return (
    <div className="pointer-events-none absolute inset-0 z-50 flex h-full w-full items-center justify-center">
      <Spinner.Root className="text-white animate-spin opacity-100" size={84}>
        <Spinner.Track className="opacity-25" width={8} />
        <Spinner.TrackFill className="opacity-75" width={8} />
      </Spinner.Root>
    </div>
  );
}
