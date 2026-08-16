import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { FlagIcon, ShareIcon, UsersIcon } from "@heroicons/react/24/solid";
import Details from "@/components/watch/primary/details";
import EpisodeLists from "@/components/watch/secondary/episodeLists";
import ServerSelector from "@/components/watch/primary/serverSelector";
import { prefetchSkips } from "@/lib/skip/prefetchSkips";
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
import PlayerErrorBoundary from "@/components/watch/primary/PlayerErrorBoundary";
import { setPlayerFullscreen } from "@/lib/player/playerFullscreen";
import { useWatchProvider } from "@/lib/context/watchPageProvider";
import { getRemovedMedia } from "@/prisma/removed";
import { getServer } from "@/lib/servers";
import { primeMediaCache, getCachedMediaMeta } from "@/lib/anilist/getMediaMeta";
import { getCachedAnime } from "@/lib/db/anime";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { onEpisodeFinished } from "@/lib/list/syncEngine";
import { getPlayerPrefs } from "@/lib/prefs/playerPrefs";
import { recordWatchToday } from "@/lib/stats/streak";
import { useTranslation } from "react-i18next";
import { FULL_MEDIA_FIELDS } from "@/lib/anilist/fullMediaQuery";
import { getPrefetchedSource, sourceKey, setPrefetchedSource, clearPrefetchedSourcesFor } from "@/lib/watch/sourcePrefetch";
import { requestSource } from "@/lib/watch/sourceRequest";
import { replaceUrlPreservingState } from "@/lib/navigation/replaceUrl";
import { getPrefetchedEpisodes, setPrefetchedEpisodes, clearPrefetchedEpisodesFor } from "@/lib/watch/episodePrefetch";
import { getPrefetchedInfo, clearPrefetchedInfoFor } from "@/lib/watch/infoPrefetch";
import { markComplete } from "@/lib/watch/progress";
import { anilistFetch } from "@/lib/anilist/anilistFetch";
import Link from "next/link";
import MobileNav from "@/components/shared/MobileNav";
import { Navbar } from "@/components/shared/NavBar";
import Modal from "@/components/modal";
import AniList from "@/components/media/aniList";
import { signIn, useSession } from "next-auth/react";
import ReportModal from "@/components/shared/ReportModal";
import Skeleton from "react-loading-skeleton";
import Head from "next/head";
import { useRouter } from "next/router";
import { Spinner } from "@vidstack/react";
import RateModal from "@/components/shared/RateModal";
import { notify } from "@/lib/notifications/noticeStore";
import { useWatchParty } from "@/lib/watch2gether/useWatchParty";
import WatchPartyPanel from "@/components/watch/party/WatchPartyPanel";

// Resolved video-proxy Worker base — mirrors the fallback the player and the
// source resolver hardcode when NEXT_PUBLIC_PROXY_BASE is unset. Used to warm
// the connection (preconnect/dns-prefetch) unconditionally in <Head>.
const PROXY_BASE =
  process.env.NEXT_PUBLIC_PROXY_BASE ||
  "https://proxy.aniscroll.com";

// Anti-bot decoy retries on the on-click source fetch. Some scraper hosts
// (sibnet) answer a cold hit with a decoy that extracts to nothing (204); the
// route seeds its player_map and the next call resolves. Seeding can outlast a
// single short retry, so back off across attempts — total ~5.6s worst case,
// only ever paid on a 204 that would otherwise drop the chip.
const DECOY_BACKOFF_MS = [800, 1600, 3200];
const DECOY_RETRIES = DECOY_BACKOFF_MS.length;

// ─────────────────────────────────────────────────────────────
// SSR
// ─────────────────────────────────────────────────────────────
export async function getServerSideProps(context) {
  const query = context?.query;
  if (!query) return { notFound: true };

  /* This render is the SAME for everyone — no session is read here at all.
     That is the whole point: the previous version baked the signed-in user into
     the props, which forced `private, no-store` and re-invoked this function on
     EVERY view *and every episode change* (SPA navigation still fetches the
     page's props). Signed-in users are the ones who watch the most episodes, so
     the busiest page on the site was also the least cacheable one.

     Where the per-user bits went:
       - `sessions` → `useSession()` in the component (same object, incl. the
         AniList token; the SessionProvider fetches it once per full page load
         and keeps it across SPA navigation).
       - `mediaListEntry` → the client backfill effect that already existed for
         it (GET /api/v2/media/[id], `private, no-store`), because the SSR only
         ever had it on a cold hit anyway.

     Same trade the anime-info page already made. Episodes can appear while a
     copy is cached, hence 30 min (vs 6 h there) + a day of
     stale-while-revalidate. */
  context.res.setHeader("Cache-Control", "public, max-age=60");
  context.res.setHeader(
    "CDN-Cache-Control",
    "public, s-maxage=1800, stale-while-revalidate=86400",
  );

  let proxy = process.env.PROXY_URI || null;
  if (proxy && proxy.endsWith("/")) proxy = proxy.slice(0, -1);

  const [aniId, provider] = query?.info;
  // The visible `?id=` is now cosmetic only (`{server}-{episode}`, no AniList
  // id). The watch-list DB key, however, MUST stay globally unique per episode —
  // `{server}-{episode}` alone collides across anime (every show's ep 1 would
  // map to the same row). Derive the key from the AniList id + episode, which is
  // stable and unique regardless of which server/URL opened it.
  const epiNumber = query?.num;
  const dub       = query?.dub;
  const watchId =
    aniId && epiNumber ? `${aniId}-${epiNumber}` : query?.id || null;

  const removed   = await getRemovedMedia();
  const isRemoved = removed?.find((i) => +i?.aniId === +aniId);
  if (isRemoved) {
    return { redirect: { destination: "/en/removed", permanent: false } };
  }

  // ── Non-blocking metadata resolution ──────────────────────────────────
  // Navigation here is SPA (router.push from the info page), but the Pages
  // Router still awaits getServerSideProps before mounting the page — so the
  // ONE thing that must stay fast is this function. The watch page no longer
  // depends on the SSR `info`: it hydrates from the shared client cache (or
  // GET /api/v2/media/[id]) on mount. So we try the *synchronous, in-process*
  // memory cache first (primed by the info page's SSR in the same lambda) and
  // only fall back to a short AniList fetch when it's a genuine cold/direct
  // hit — never letting a slow upstream gate the navigation.
  let data = { data: { Media: null } };

  // 1. Memory cache — instant, no I/O. The info page primed this for the same
  //    container on the previous request, so SPA navigation almost always hits.
  const mem = getCachedMediaMeta(Number(aniId));
  if (mem) {
    data = { data: { Media: { ...mem, mediaListEntry: null } } };
  }

  // 2. Cold/direct hit only: fetch from AniList with a tight timeout. We don't
  //    want a full render with no metadata on a shared link, but we also never
  //    block longer than ~2.5s — the client will hydrate the rest.
  const simulateDown = process.env.ANILIST_SIMULATE_DOWN === "1";
  if (!data?.data?.Media) {
    try {
      if (simulateDown) throw new Error("simulated AniList outage");
      // No `authToken`: this response is shared by every visitor (and cached
      // as such), so it must not carry anyone's list entry. The client backfills
      // `mediaListEntry` right after mount — see the effect below.
      const json = await anilistFetch({
        query: `query ($id: Int) {
          Media (id: $id) {
            ${FULL_MEDIA_FIELDS}
          }
        }`,
        variables: { id: Number(aniId) },
        timeoutMs: 2500,
        label: `watch-ssr:${aniId}`,
      });
      if (json?.data?.Media) {
        data = json;
        // Prime memory + DB so source-API probes / refreshes can read instantly.
        primeMediaCache(aniId, data.data.Media);
      }
    } catch (e) {
      console.warn(`[watch SSR] AniList fetch failed for ${aniId}:`, e.message);
    }
  }

  // 3. Last-resort persistent fallback (AniList slow/down on a cold hit).
  if (!data?.data?.Media) {
    try {
      const cached = await getCachedAnime(Number(aniId));
      if (cached?.data) {
        data = { data: { Media: { ...cached.data, mediaListEntry: null } } };
      }
    } catch (e) {
      console.warn(`[watch SSR] DB fallback failed for ${aniId}:`, e?.message);
    }
  }

  /* NOTE — three Prisma round-trips used to run here on every signed-in view
     (createUser + createList + getEpisode) to build a `userData` prop that the
     component destructured and NEVER read. They were the bulk of this
     function's work on the site's busiest page, and the rows they wrote were
     stubs: `updateUserEpisode` (the only thing that fills in title / image /
     timeWatched) has no caller left, and /en/anime/recently-watched drops rows
     with no image or title — it explicitly falls back to localStorage, which is
     what actually holds the watch history now. So the writes bought nothing and
     the read fed a dead prop. If a server-side watch history comes back, it
     belongs in the progress-sync path (which knows what was watched), not in a
     page render that fires on every episode open. */

  return {
    props: {
      provider:   provider || null,
      watchId:    watchId  || null,
      epiNumber:  epiNumber || null,
      dub:        dub || null,
      info:       data?.data?.Media || null,
      aniId:      aniId || null,
      proxy,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Page component
// ─────────────────────────────────────────────────────────────
export default function Watch({
  info: ssrInfo,
  watchId,
  proxy,
  dub,
  provider,
  epiNumber,
  aniId,
}) {
  const titlePref = useTitlePref();
  const { t } = useTranslation();
  /* Client-side, deliberately: the SSR render is shared by every visitor so it
     can be edge-cached (see getServerSideProps). Same object as the old
     `sessions` prop — the AniList token included — resolved once per full page
     load by the app-level <SessionProvider> and kept across SPA navigation. It
     is null for the first paint of a cold load, so anything reading it must
     tolerate that (they all do: modals, list buttons and effects). */
  const { data: sessions } = useSession();

  // ── Client-hydratable metadata ────────────────────────────────────────
  // `info` no longer relies solely on the SSR prop. To make SPA navigation
  // from the anime info page feel instant, we initialise from the shared
  // client cache (the info page primed it) when available, fall back to the
  // SSR `info`, and as a last resort fetch GET /api/v2/media/[id] on mount.
  // This means a cold SSR (memory miss → `ssrInfo` null) still renders fast:
  // the player hydrates from the client the moment metadata arrives.
  const resolvedAniId = ssrInfo?.id || (aniId ? Number(aniId) : null);
  // Initialise from the SSR prop on BOTH server and the first client render so
  // hydration matches. The client cache / API fill in afterwards in an effect.
  const [info, setInfo] = useState(ssrInfo || null);

  // On an in-app navigation to a DIFFERENT anime (e.g. a Watch-Party redirect),
  // Next reuses this page component, so the `info` useState above does NOT
  // re-initialise — it kept the previous anime and the player showed stale
  // content until a manual reload. Re-sync `info` whenever the SSR prop's id (or
  // the resolved aniId) changes so the new anime renders immediately.
  const lastSsrIdRef = useRef(ssrInfo?.id ?? (aniId ? Number(aniId) : null));
  useEffect(() => {
    const incoming = ssrInfo?.id ?? (aniId ? Number(aniId) : null);
    if (incoming == null) return;
    if (incoming === lastSsrIdRef.current && info?.id === incoming) return;
    lastSsrIdRef.current = incoming;
    // Adopt the fresh SSR metadata when present; otherwise null it so the
    // resolve effect below refetches for the new id (and the player doesn't
    // keep rendering the previous anime's stream).
    setInfo(ssrInfo && ssrInfo.id === incoming ? ssrInfo : null);
  }, [ssrInfo, aniId, info?.id]);

  // Resolve metadata client-side when the SSR didn't supply it (cold/direct
  // hit with a memory miss). Prefer the prefetch cache (primed by the info
  // page during SPA navigation), then the warm API. Runs post-hydration so it
  // never causes an SSR/CSR mismatch.
  useEffect(() => {
    if (info?.id) return;
    if (!resolvedAniId) return;
    const cached = getPrefetchedInfo(resolvedAniId);
    if (cached) {
      setInfo(cached);
      return;
    }
    let cancelled = false;
    fetch(`/api/v2/media/${resolvedAniId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        if (!cancelled && m && !m.error) setInfo(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [info?.id, resolvedAniId]);

  // If the SSR served metadata without the per-user list entry (it now skips
  // the AniList fetch on a memory hit), backfill mediaListEntry from the API
  // so the "on list" state and resume progress are correct for signed-in users.
  useEffect(() => {
    if (!sessions?.user?.name) return;
    if (!info?.id) return;
    if (info.mediaListEntry) return;
    let cancelled = false;
    fetch(`/api/v2/media/${info.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        if (!cancelled && m?.mediaListEntry) {
          setInfo((prev) =>
            prev ? { ...prev, mediaListEntry: m.mediaListEntry } : prev,
          );
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.id, sessions?.user?.name]);

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
  // Gates the first source fetch until we've read the user's saved server
  // preference from localStorage. Without this gate the page fetched + showed
  // megaplay (the SSR-safe default) first, then visibly SWITCHED to the user's
  // server once it confirmed — the jarring flip the user reported. With the
  // gate, the very first fetch already targets the preferred server.
  const [serverResolved, setServerResolved] = useState(false);
  const [hlsData, setHlsData]           = useState(null);
  const [hlsLoading, setHlsLoading]     = useState(false);
  // Map<serverId, reason string> — failed servers (kept for tracking, hidden from UI)
  const [failedServers, setFailedServers] = useState(new Map());
  // Set<serverId> — servers that returned a valid source (visible in UI)
  const [confirmedServers, setConfirmedServers] = useState(new Set());
  // Set<serverId> — servers that returned 200 but only via the fallback
  // iframe path (extraction failed). The selector renders these red so
  // the user knows playback won't use the custom Vidstack chrome.
  const [degradedServers, setDegradedServers] = useState(new Set());
  const markDegraded = useCallback((id) => {
    setDegradedServers((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  // Verdicts for servers resolved by the ACTIVE-source fast path
  // (fetchStreamSource), which runs OUTSIDE the probe fan-out's local Sets.
  // Without this, an active server confirmed here (e.g. the default `megaplay`,
  // or the user's preferred one) was marked in React state but NEVER added to
  // the `cachedConfirmed` Set the availability snapshot is built from — so it
  // was never published, and the NEXT visitor's snapshot omitted it, hiding the
  // chip. The probe effect reads this ref when publishing so those verdicts make
  // it into the snapshot.
  //
  // `ok` — plus the ONE kind of absence the click path may publish: `hardAbsent`,
  // where the route proved the upload is gone (404 from the host itself, see the
  // `hard` flag in lib/watch/sourceRequest). An ordinary absence still never
  // lands here: a cold anti-bot decoy and a genuine soft404 look identical, and
  // guessing wrong hides a working host for the snapshot's 6h TTL. The
  // background probe, which retries properly, owns those via confirmedAbsent.
  const activeVerdictRef = useRef({ ok: new Set(), hardAbsent: new Set() });

  // Mirror of failedServers for sync reads inside markFailed without forcing
  // markFailed to depend on failedServers (which would invalidate fetchStreamSource
  // every probe and cancel in-flight requests).
  const failedServersRef = useRef(failedServers);
  useEffect(() => { failedServersRef.current = failedServers; }, [failedServers]);

  // Live mirror of `activeServer`. The probe fan-out is keyed on the EPISODE, so
  // its closure freezes whatever `activeServer` was when the effect ran — which
  // on mount is always the SSR-safe "megaplay" placeholder, before the saved
  // preference has been read. It used that frozen value to splice the active
  // server out of the pool ("fetchStreamSource resolves it, don't probe twice"),
  // so for anyone with a preference other than megaplay, megaplay was skipped by
  // the pool AND never fetched by the active path: its chip could not appear even
  // when the episode has a perfectly good megaplay source. Reading the ref at
  // splice time (after the awaits, i.e. once the preference has landed) skips the
  // server actually being fetched instead.
  const activeServerRef = useRef(activeServer);
  useEffect(() => { activeServerRef.current = activeServer; }, [activeServer]);

  const markConfirmed = useCallback((id) => {
    setConfirmedServers((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  // Track server preference order — favorite working servers come first.
  // Six of the nine ids this list used to carry (hianime-*, animesama-oneupload,
  // voiranime-streamtape*) no longer exist in lib/servers.js. `isCandidate`
  // filtered them out silently, so the list effectively read
  // [megaplay, animesama-sibnet, animesama-sibnet-vo] — which is why a dead VF
  // chip fell back to Megaplay (lang "multi", first in line) instead of another
  // FRENCH DUB. Kept as a hint for the ids that still exist; anything not listed
  // is picked up by the lib/servers.js sweep below (already ordered by speed).
  const PREFERRED_FALLBACK_ORDER = [
    "megaplay",
    "animesama-sibnet",
    "animesama-sibnet-vo",
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

      // STRICT same language first — a viewer who picked a French dub wants
      // another French dub, not Megaplay's subtitles. The old single pass
      // accepted `lang === "multi"` at the same priority, and since megaplay
      // heads the list it always won: losing the VF chip silently switched the
      // episode to VOSTFR.
      const langOf = (sid) => SERVERS.find((x) => x.id === sid)?.lang;
      const sameLang = (sid) => failedLang && langOf(sid) === failedLang;

      let next = PREFERRED_FALLBACK_ORDER.find((sid) => isCandidate(sid) && sameLang(sid));
      // …then any other server of that language (lib order = fastest first).
      if (!next) {
        next = SERVERS.find((s) => !failedSet.has(s.id) && s.lang === failedLang)?.id;
      }
      // Only once the language is exhausted: the hinted list, then anything left.
      if (!next) {
        next = PREFERRED_FALLBACK_ORDER.find(isCandidate);
      }
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
  // Load the user's saved server preference. The URL no longer carries the
  // server id (used to be in the path between {aniId} and the slug); the
  // canonical URL is now /en/anime/watch/{aniId}/{slug}. localStorage is
  // the only source of truth for the default server — old shared links
  // get migrated to the slug-only form by the canonicalization effect
  // below.
  // The user's saved server preference. We DON'T apply it blindly anymore:
  // doing so pointed `activeServer` at a server this particular anime doesn't
  // offer, so the source fetch failed and the player showed nothing. Instead
  // we remember the preference and only switch to it once it's confirmed
  // available for THIS anime (see the effect below). `appliedPrefRef` ensures
  // we only honour the saved preference once per mount — after that the user's
  // in-session clicks win.
  const preferredServerRef = useRef(null);
  const appliedPrefRef = useRef(false);
  useEffect(() => {
    const pref = localStorage.getItem("preferred_server") || null;
    preferredServerRef.current = pref;
    // Select the user's server UP FRONT so it's the one loaded in priority — not
    // megaplay-then-switch. If the anime doesn't actually offer this server the
    // fetch fails and the safety-net effect below falls back to a confirmed one,
    // which is exactly the "sauf s'il n'a pas l'anime" behaviour we want. With
    // no saved preference we keep the megaplay default.
    if (pref) {
      appliedPrefRef.current = true;
      setActiveServer(pref);
    }
    setServerResolved(true);
  }, []);

  // Apply the saved preference only when it's actually available for this
  // anime (i.e. it has been confirmed by the probes). Until then we stay on
  // the safe default. If the preferred server never confirms (this anime
  // doesn't have it), we simply never switch to it — no dead player.
  useEffect(() => {
    if (appliedPrefRef.current) return;
    const pref = preferredServerRef.current;
    if (!pref || pref === activeServer) return;
    if (confirmedServers.has(pref)) {
      appliedPrefRef.current = true;
      setActiveServer(pref);
    }
  }, [confirmedServers, activeServer]);

  // Safety net: if the active server ends up confirmed-failed (and is NOT in
  // the confirmed set), jump to the first confirmed server so the user is
  // never left staring at an empty player. Runs whenever the probe verdicts
  // change.
  useEffect(() => {
    if (confirmedServers.has(activeServer)) return;
    if (!failedServers.has(activeServer)) return; // still pending — wait
    // Pick the best confirmed server, honouring the preferred fallback order.
    const firstConfirmed =
      PREFERRED_FALLBACK_ORDER.find((id) => confirmedServers.has(id)) ||
      [...confirmedServers][0];
    if (firstConfirmed && firstConfirmed !== activeServer) {
      setActiveServer(firstConfirmed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmedServers, failedServers, activeServer]);

  const router = useRouter();

  // ── Watch 2gether ──
  // A room is active when the URL carries ?party={roomId}. The hook is a no-op
  // (returns null) when absent, so the page behaves identically without one.
  const partyRoomId = router.query.party ? String(router.query.party) : null;
  // AniList session: the user id lives in `id` (from profile()) OR `sub` (from
  // the userinfo request) depending on the auth path — fall back across both so
  // a signed-in user is never mistaken for a guest.
  const sessionUserId = sessions?.user?.id ?? sessions?.user?.sub;
  const myUserId = sessionUserId != null ? String(sessionUserId) : null;

  // Panel is closable; a floating pill restores it. Reset to visible whenever a
  // new party is entered.
  const [partyPanelHidden, setPartyPanelHidden] = useState(false);
  // The right-hand panel is shown when in a party OR when the user opened the
  // lobby (Create / Join) via the "Watch together" button.
  const [partyUIOpen, setPartyUIOpen] = useState(false);

  // When we leave or are removed, strip ?party from the URL (and toast why).
  // We KEEP the panel open so it falls back to the lobby (create / join a room)
  // — the removed person should be able to start or rejoin another party.
  const stripParty = useCallback(() => {
    setPartyUIOpen(true);
    setPartyPanelHidden(false);
    // Build from the live location (not router.pathname/query): on this i18n
    // catch-all route those can drop the `info`/`num` segments and rewrite the
    // URL as /anime/watch/undefined/…?num=undefined, crashing the page.
    const params = new URLSearchParams(window.location.search);
    params.delete("party");
    const qs = params.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
    router.replace(url, undefined, { shallow: true });
  }, [router]);

  const handleSelfRemoved = useCallback(
    (reason) => {
      if (reason === "kick") notify.error(t("party.toastKicked"));
      else if (reason === "ban") notify.error(t("party.toastBanned"));
      stripParty();
    },
    [stripParty, t]
  );

  const handleJoinRejected = useCallback(
    (reason) => {
      if (reason === "banned") notify.error(t("party.toastBanned"));
      else if (reason === "inactive") notify.error(t("party.toastInactive"));
      else if (reason === "locked") notify.error(t("party.toastLocked"));
      else notify.error(t("party.toastNotFound"));
      stripParty();
    },
    [stripParty, t]
  );

  const party = useWatchParty(
    partyRoomId,
    { aniId: aniId, epiNumber: epiNumber, dub: !!dub, server: activeServer },
    myUserId,
    { onSelfRemoved: handleSelfRemoved, onJoinRejected: handleJoinRejected }
  );
  useEffect(() => {
    if (partyRoomId) {
      setPartyPanelHidden(false);
      setPartyUIOpen(true);
    }
  }, [partyRoomId]);

  // Release the player's fullscreen mode when we actually LEAVE the watch page.
  // This lives here, not in UniversalPlayer: the player is remounted on every
  // episode change, on a server fallback, and for a beat whenever the router's
  // episode number lands before the new stream data does (its key holds both) —
  // releasing on its unmount kicked the user out of fullscreen mid-navigation.
  // This page stays mounted across all of that (same route), so its unmount is
  // the only honest "the user is gone" signal.
  useEffect(() => () => setPlayerFullscreen(false), []);

  // Track the player's pixel height so (on large screens) the party panel can
  // match it exactly. Falls back to a max-height via CSS when unset.
  // NOTE: the ResizeObserver effect lives lower (after `theaterMode` is read
  // from context) to avoid a TDZ on its dependency.
  const playerBoxRef = useRef(null);
  const [playerBoxH, setPlayerBoxH] = useState(0);

  // Episode sync: when WE change episode while in a party, tell everyone. When
  // a peer changes episode, navigate to it (preserving ?party). We track the
  // last episode we broadcast/applied to avoid feedback loops.
  const lastBroadcastEpRef = useRef(null);
  const applyingRemoteEpRef = useRef(false);
  // Guard against redirect loops: remember the last target we navigated to
  // (aniId-ep-dub). The snapshot keeps arriving on every (re)connect, so without
  // this the state-driven redirect could fire again before `info` finishes
  // hydrating to the new anime and push the same route in a tight loop ("on
  // charge en boucle"). We only ever push a given target once.
  const lastNavTargetRef = useRef(null);
  // A joiner must FOLLOW the host, never drag the room to its own page. Until we
  // have aligned with the room snapshot at least once, suppress broadcasting our
  // episode — otherwise a member who joins by code instantly broadcasts the page
  // they happened to be on and teleports the HOST to it (the inverted redirect).
  // The host (room creator) is synced from the start; everyone else syncs once
  // the snapshot lands (see the snapshot redirect effect below).
  const syncedToRoomRef = useRef(false);

  // Broadcast our episode whenever it changes (and we didn't just apply a remote one).
  useEffect(() => {
    if (!party || epiNumber == null) return;
    // The room creator is authoritative immediately; joiners wait until synced.
    if (party.isHost) syncedToRoomRef.current = true;
    const key = `${epiNumber}-${dub ? "dub" : "sub"}`;
    if (lastBroadcastEpRef.current === key) return;
    lastBroadcastEpRef.current = key;
    if (applyingRemoteEpRef.current) {
      applyingRemoteEpRef.current = false;
      return; // this change came FROM a peer — don't echo it back
    }
    // Not yet aligned with the room → don't broadcast our incidental page.
    if (!syncedToRoomRef.current) return;
    party.broadcast("episode", {
      aniId: aniId,
      epiNumber: epiNumber,
      dub: !!dub,
      server: activeServer,
      position: 0,
    });
  }, [party, epiNumber, dub, aniId, activeServer]);

  // Apply remote episode changes by navigating, keeping ?party intact. Also
  // handles the initial snapshot so a peer who joined by CODE on a different
  // page (or different anime) is taken to whatever the room is watching.
  useEffect(() => {
    if (!party) return;
    const navTo = (targetAniId, targetEp, targetDub) => {
      // Never navigate on a missing/"undefined" target (a malformed snapshot) —
      // buildWatchUrl would produce /anime/watch/undefined/…?num=undefined.
      const bad = (v) => v == null || v === "" || v === "undefined";
      if (bad(targetAniId) || bad(targetEp)) return;
      const sameAnime = String(aniId) === String(targetAniId);
      const sameEp = sameAnime && String(epiNumber) === String(targetEp) && !!dub === !!targetDub;
      if (sameEp) return;
      const target = `${targetAniId}-${targetEp}-${targetDub ? "dub" : "sub"}`;
      if (lastNavTargetRef.current === target) return; // already navigating there
      lastNavTargetRef.current = target;
      applyingRemoteEpRef.current = true;
      router.push(buildWatchUrl(targetAniId, targetEp, targetDub, activeServer, party.roomId), undefined, {
        shallow: false,
      });
    };
    const unsub = party.onRemote((e) => {
      if (e.type === "episode" && e.payload) {
        navTo(e.payload.aniId || info?.id || aniId, e.payload.epiNumber, e.payload.dub);
      } else if (e.type === "server" && e.payload?.server) {
        // Apply the server directly (not via handleServerChange) so it doesn't
        // re-broadcast back to the room.
        if (e.payload.server !== activeServer) setActiveServer(e.payload.server);
      } else if (e.type === "snapshot" && e.payload?.snapshot) {
        const s = e.payload.snapshot;
        navTo(s.aniId, s.epiNumber, s.dub);
        // Align the server for late joiners ONLY — never for the host who just
        // seeded this snapshot (they're already on the right server). Applying
        // it to the host swapped `activeServer` to the snapshot's value, which
        // re-ran the stream fetch and reloaded the <video> from 0s — THAT was
        // the "creating a party rewinds to 0" bug (not the playback snapshot,
        // which is host-guarded). Also skip when we're already on the room's
        // anime+episode: a server realign there is a source reload we don't want
        // mid-watch. Genuine cross-server joiners still align via the `server`
        // event and the initial mismatch handled before playback settles.
        const selfIsHost = e.payload?.selfIsHost === true;
        const sameAnime = String(aniId) === String(s.aniId);
        const sameEp =
          sameAnime && String(epiNumber) === String(s.epiNumber) && !!dub === !!s.dub;
        if (!selfIsHost && !sameEp && s.server && s.server !== activeServer) {
          setActiveServer(s.server);
        }
      }
    });
    return unsub;
  }, [party, epiNumber, dub, info?.id, aniId, activeServer, router]);

  // Robust redirect: whenever the room snapshot says we're on the wrong anime
  // or episode (e.g. joined by code from a different page), navigate there.
  // State-driven (not event-driven) so it can't miss the transient snapshot.
  useEffect(() => {
    const s = party?.snapshot;
    // Guard against a malformed snapshot (aniId/epiNumber missing or the literal
    // string "undefined" from a room seeded before the page had its metadata) —
    // navigating on it produced /anime/watch/undefined/…?num=undefined, which
    // crashed the page (Array.map over a null episode). Stay put instead.
    const bad = (v) => v == null || v === "" || v === "undefined";
    if (!s || bad(s.aniId) || bad(s.epiNumber)) return;
    // Compare against the page's OWN SSR prop (`aniId`), not `info?.id` which
    // hydrates asynchronously: while it lags the new anime, sameAnime reads
    // false and we'd push the same route over and over (the load loop).
    const sameAnime = String(aniId) === String(s.aniId);
    const sameEp =
      sameAnime && String(epiNumber) === String(s.epiNumber) && !!dub === !!s.dub;
    if (sameEp) {
      // We're on the room's episode — we're aligned. From now on our own
      // deliberate episode changes may broadcast to the room.
      syncedToRoomRef.current = true;
      return;
    }
    const target = `${s.aniId}-${s.epiNumber}-${s.dub ? "dub" : "sub"}`;
    if (lastNavTargetRef.current === target) return; // already navigating there
    lastNavTargetRef.current = target;
    applyingRemoteEpRef.current = true;
    router.push(
      buildWatchUrl(s.aniId, s.epiNumber, s.dub, s.server || activeServer, party.roomId),
      undefined,
      { shallow: false }
    );
  }, [party?.snapshot, party?.roomId, epiNumber, dub, aniId, activeServer, router]);

  // Canonicalize the URL to /en/anime/watch/{aniId}/{slug}. Strips any
  // legacy /{server} segment (old links shared before we removed the
  // server from the URL) and writes the human-readable slug. The [...info]
  // route ignores extra path parts so old links keep working; this just
  // tidies them in-place.
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
    const parts = path.split("/").filter(Boolean);
    // Expected prefix: ["{locale}", "anime", "watch", "{aniId}"]
    if (parts.length < 4 || parts[2] !== "watch") return;
    // Preserve whatever locale prefix is currently in the URL (/en or /fr) so
    // we don't fight the I18nProvider's locale swap.
    const locale = parts[0] === "fr" ? "fr" : "en";
    const aniIdPart = parts[3];
    const desired = `/${locale}/anime/watch/${aniIdPart}/${slug}`;
    if (path !== desired) {
      const next = `${desired}${window.location.search}${window.location.hash}`;
      replaceUrlPreservingState(next);
    }
  }, [info?.id, info?.title?.english, info?.title?.romaji, info?.title?.userPreferred]);

  // ── Keep the visible ?id= in sync with the active server ─────
  // The `id` query param is purely cosmetic for the URL bar (real routing is
  // the path + ?num=). We show it as `{server}-{episode}` — the numeric AniList
  // id that used to sit in the middle (`megaplay-113415-1`) is useless noise, so
  // we drop it. And when the user switches players, the server segment updates
  // to the new server's name instead of staying pinned to whatever opened the
  // page. replaceState (not push) so it doesn't pollute history or reload.
  useEffect(() => {
    if (!activeServer || epiNumber == null) return;
    const params = new URLSearchParams(window.location.search);
    const desiredId = `${activeServer}-${epiNumber}`;
    if (params.get("id") === desiredId) return;
    params.set("id", desiredId);
    const next = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
    replaceUrlPreservingState(next);
  }, [activeServer, epiNumber]);

  // ── Free prefetch caches when leaving the watch page ─────────
  // The source / episode / info prefetch maps and the HLS segment buffer can
  // hold a lot of data (the source cache alone keeps every server's master
  // playlist + extracted stream; hls.js buffers up to tens of MB of video).
  // Once the user navigates away from this anime's watch page there's no reason
  // to keep any of it resident — drop every cached entry for this aniId on
  // unmount so memory doesn't accumulate across a browsing session. Vidstack
  // already tears down the hls.js instance (and its buffer) when the player
  // unmounts; this clears the prefetch maps that would otherwise linger.
  const resolvedAniIdRef = useRef(aniId || ssrInfo?.id || null);
  useEffect(() => {
    const id = aniId || ssrInfo?.id;
    if (id) resolvedAniIdRef.current = id;
  }, [aniId, ssrInfo?.id]);
  useEffect(() => {
    return () => {
      const id = resolvedAniIdRef.current;
      if (!id) return;
      try {
        clearPrefetchedSourcesFor(id);
        clearPrefetchedEpisodesFor(id);
        clearPrefetchedInfoFor(id);
      } catch {}
    };
  }, []);

  const {
    theaterMode,
    autoplay,
    setAutoNext,
    setAutoPlay,
    setMarked,
    setPlayerState,
    setTrack,
    setSkipTimes,
    aspectRatio,
    setDataMedia,
    ratingModalState,
    setRatingModalState,
  } = useWatchProvider();

  // Match the party panel's height to the player on desktop. We derive it from
  // the player wrapper's WIDTH (× 9/16), not by measuring the player's own
  // height: the player renders an ambient-glow layer that extends past the 16:9
  // video, so a height measurement overshot and the panel grew too tall. The
  // visible video is always 16:9 in non-theater, so width × 9/16 is exact and
  // immune to the glow. Observing width also dodges the dynamic-import remount
  // (the wrapper itself is stable and never swapped).
  useEffect(() => {
    const wrapper = playerBoxRef.current;
    if (!wrapper || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const w = wrapper.getBoundingClientRect().width || 0;
      if (w) setPlayerBoxH(Math.round((w * 9) / 16));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(wrapper);
    measure();
    return () => ro.disconnect();
  }, [theaterMode]);

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
      const entryKey = String(info.id);
      const prev = existing[entryKey] || {};
      existing[entryKey] = {
        ...prev,
        watchId: watchId || entryKey,
        aniId: info.id,
        aniTitle: info?.title?.romaji || info?.title?.english,
        title: `Episode ${epiNumber}`,
        // Never overwrite an existing episode thumbnail with the cover art.
        // The episode effect writes the real 16:9 thumbnail; this mount effect
        // only fills in the image when there is absolutely nothing yet.
        image: prev.image || null,
        // Portrait cover of the anime — used by the home Recently Watched
        // carousel which renders vertical cards (like Trending/Popular).
        cover:
          info?.coverImage?.extraLarge ||
          info?.coverImage?.large ||
          prev.cover ||
          null,
        episode: Number(epiNumber),
        provider,
        dub: !!dub,
        createdAt: new Date().toISOString(),
      };
      localStorage.setItem("artplayer_settings", JSON.stringify(existing));
    } catch {}
  }, [info?.id, epiNumber, dub, provider, watchId]);

  // Close a lingering rate popup whenever the anime changes. The rating state
  // lives in the app-wide WatchPageProvider (so it survives client-side nav), so
  // an unanswered popup from anime A would otherwise stay open — and re-bind to
  // anime B's dataMedia — the moment you open another anime. Reset it on id change.
  useEffect(() => {
    setRatingModalState((prev) =>
      prev.isOpen ? { ...prev, isOpen: false } : prev,
    );
  }, [info?.id, setRatingModalState]);

  // ── Reset server verdicts on episode change ──────────────────
  // Keyed EXACTLY like the probe fan-out below ([info.id, epiNumber, dub]) —
  // and nothing else. This used to live at the top of the episode-list effect,
  // whose deps also carry `sessions?.user?.name`. That name arrives async
  // (`useSession()` returns undefined first, then the session object) and
  // next-auth ALSO refetches on window focus, so the reset fired again on a
  // perfectly stable episode. The probe effect, keyed only on the episode, did
  // NOT re-run: its in-memory `cachedConfirmed` still held every server, so
  // every probe returned early and nothing ever repainted. Since all servers in
  // lib/servers.js are type "api", `shouldShow` falls through to
  // `confirmedServers.has(id)` for all of them — an emptied Set wipes the whole
  // selector, leaving only the active chip. That is the "all the players vanish
  // except the selected one" report, and its randomness was the race between
  // session hydration and the probe pool finishing.
  //
  // Reset at the START of the effect, not in the cleanup. In React 18 dev/Strict
  // Mode the cleanup fires between the two mount passes and would clobber probe
  // results that completed in the first pass.
  useEffect(() => {
    setFailedServers(new Map());
    setConfirmedServers(new Set());
    setDegradedServers(new Set());
  }, [info?.id, epiNumber, dub]);

  // ── Episode list + navigation ────────────────────────────────
  useEffect(() => {
    async function getInfo() {
      if (!info) return;
      if (info.mediaListEntry) setOnList(true);
      setDataMedia(info);

      // Fast path: the info page may have already fetched + cached this exact
      // episode list in the background. If so, use it immediately so the player
      // can build `episodeNavigation` and render without waiting on the network.
      let raw = getPrefetchedEpisodes(info.id, !!dub);
      if (!raw) {
        raw = await fetch(
          `/api/v2/episode/${info.id}?releasing=${
            info.status === "RELEASING" ? "true" : "false"
          }${dub ? "&dub=true" : ""}`
        ).then((res) => res.json());
        if (Array.isArray(raw)) setPrefetchedEpisodes(info.id, !!dub, raw);
      }

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
            const entryKey = String(info.id);
            // Only ever store a real episode thumbnail here. Do NOT fall back
            // to bannerImage — a wide banner (≈16:5) doesn't fill the 16:9
            // card and leaves a black band. When there's no thumbnail the
            // card uses `cover` (portrait) which object-cover fills cleanly.
            const episodeImage =
              playingData?.img || playingData?.image || null;
            existing[entryKey] = {
              ...(existing[entryKey] || {}),
              watchId: currentEpisode.id,
              aniId: info.id,
              aniTitle: info?.title?.romaji || info?.title?.english,
              title:
                playingData?.title ||
                `Episode ${currentEpisode.number}`,
              image: episodeImage,
              // Portrait cover for the home carousel's vertical cards.
              cover:
                info?.coverImage?.extraLarge ||
                info?.coverImage?.large ||
                existing[entryKey]?.cover ||
                null,
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
    // `info?.id` is a dependency now that `info` is hydrated client-side — on a
    // cold SSR it arrives after mount, and without it here getInfo() would bail
    // early (if (!info) return) and never re-run, leaving the player stuck.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions?.user?.name, epiNumber, dub, info?.id]);

  // ── List sync on episode finish ──────────────────────────────
  // Hands the sync engine the full media context (total episodes, title,
  // cover) so it can update the local list and — when AniList sync is on and
  // connected — push progress/status upstream. Total episodes: prefer the
  // AniList `episodes` count, fall back to the next-airing episode minus one
  // for still-releasing shows (matches the list editor's logic). Called both
  // by the player's natural `ended` (HLS) and on advancing to the next episode
  // (covers iframe servers like Megaplay that have no <video> element).
  const handleEpisodeComplete = useCallback(
    ({ aniListId, episodeNumber }) => {
      const total =
        info?.episodes ??
        (info?.nextAiringEpisode?.episode
          ? info.nextAiringEpisode.episode - 1
          : null);
      onEpisodeFinished({
        aniId: aniListId,
        episode: episodeNumber,
        total,
        title: info?.title,
        coverImage: info?.coverImage?.large || info?.coverImage?.extraLarge || null,
      }).catch(() => {});
      // Count today toward the watch streak (idempotent within a day).
      recordWatchToday();
    },
    [info],
  );

  // Total episodes for the current anime (same derivation as above), so we can
  // tell whether the episode being watched is the FINAL one — used to surface
  // the rate popup a little BEFORE the last episode actually ends.
  const totalEpisodes = useMemo(
    () =>
      info?.episodes ??
      (info?.nextAiringEpisode?.episode ? info.nextAiringEpisode.episode - 1 : null),
    [info],
  );
  const isFinalEpisode = useMemo(() => {
    const ep = parseInt(epiNumber, 10);
    return totalEpisodes != null && Number.isFinite(ep) && ep >= totalEpisodes;
  }, [epiNumber, totalEpisodes]);
  // Single-episode work (film / OVA): the rate popup should wait until the very
  // end rather than fire at 88%, since there's no ED/preview tail.
  const isSingleEpisode = useMemo(
    () => totalEpisodes === 1 || info?.format === "MOVIE",
    [totalEpisodes, info?.format],
  );

  // Open the rate popup (once) when the final episode is nearly over, unless the
  // user disabled it in Settings. SkipOverlay calls this from inside the player.
  const handleFinalEpisodeNearEnd = useCallback(() => {
    if (!getPlayerPrefs().rateOnComplete) return;
    setRatingModalState((prev) => (prev.isOpen ? prev : { ...prev, isOpen: true }));
  }, [setRatingModalState]);

  // ── Mark the previous episode complete when advancing ────────
  // When the user moves on to the next episode (N → N+1), the one they just
  // left is, by definition, finished — so we pin its progress to the end. That
  // makes the home/info "continue watching" show the right next episode and
  // keeps a future rewatch starting clean from 0 (see lib/watch/progress.ts).
  // Only forward moves count; jumping BACK to an earlier episode must not wipe
  // a genuine mid-episode resume point. The natural end-of-video case is
  // handled inside the player itself via `markComplete` on `ended`.
  const prevEpiRef = useRef(null);
  useEffect(() => {
    const ep = parseInt(epiNumber, 10);
    const id = info?.id;
    const prev = prevEpiRef.current;
    if (
      id != null &&
      prev != null &&
      prev.id === id && // same anime — don't carry across a series switch
      Number.isFinite(ep) &&
      ep === prev.ep + 1
    ) {
      markComplete(id, prev.ep);
      // Advancing to the next episode = the previous one is watched. Drive the
      // list sync from here (not just the player's `ended`) so it ALSO works
      // for iframe servers like Megaplay, which have no <video> element to fire
      // `ended`. handleEpisodeComplete updates the local list + optional push.
      handleEpisodeComplete({ aniListId: id, episodeNumber: prev.ep });
    }
    if (id != null && Number.isFinite(ep)) prevEpiRef.current = { id, ep };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epiNumber, info?.id, handleEpisodeComplete]);

  // ── Auto-next / auto-play + skip data ───────────────────────
  // autoplay/autoNext are now hydrated from localStorage by WatchPageProvider
  // itself (single source of truth + automatic persistence), so we don't read
  // them here anymore.
  /* AniSkip fetch — issued from inside the player once `duration` is
     known so we can pass `episodeLength` to the API. With that hint
     AniSkip returns only the submissions timed against a matching
     video length and omits the noisy `mixed-op` / `mixed-ed`
     entries that would otherwise pollute the seek bar. We expose a
     tiny callback on the player context that the watch page wires
     to the MediaPlayer's `onDurationChange`. */
  useEffect(() => {
    // Clear on episode change; the player will refetch with the
    // new duration as soon as metadata loads.
    setSkipTimes([]);
    setPlayerState({ currentTime: 0, isPlaying: false });
    setMarked(0);
    setTrack(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, watchId, info?.id]);

  // Warm the AniSkip cache as soon as we know the anime + episode — well
  // before the dynamic player chunk (and SkipOverlay inside it) has loaded.
  // By the time the overlay mounts and reads SKIP_MEMO the data is usually
  // already there, so the chapter pills/skip segments appear the moment the
  // video reports its duration instead of waiting on a fetch that only starts
  // after the player JS downloads. Fire-and-forget: the cache is the channel.
  // Gated on `serverResolved` for the same reason the source fetch is: until the
  // saved preference has been read, `activeServer` is still the SSR-safe
  // "megaplay" placeholder. Since the cache key includes the server (per-host
  // OP/ED), firing here warmed an entry for a server we were about to leave —
  // one wasted /api/v2/skip round-trip per page load, thrown away a few ms later
  // when the preference landed and the effect re-ran with the real server.
  useEffect(() => {
    if (!serverResolved) return;
    if (!info?.idMal || !epiNumber) return;
    // Pass the active server so the warmed entry is the per-host one SkipOverlay
    // (which keys by server) will read — otherwise it'd warm the lang-keyed
    // reconciled entry and the overlay would still fetch its own.
    prefetchSkips(info.idMal, Number(epiNumber), info.id, { server: activeServer });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverResolved, info?.idMal, info?.id, epiNumber, activeServer]);

  // ── Fetch stream source when server needs backend (hls or api) ──
  // Tracks the latest in-flight request so server-change / navigation aborts it.
  const activeFetchCtrl = useRef(null);
  // Flipped true the moment the ACTIVE server's source settles (cache hit, OK,
  // or error). The background probe fan-out waits on this so the active stream
  // — the request that actually gates the player — gets the connection pool to
  // itself first, instead of competing with ~17 low-priority probes.
  const activeSourceSettledRef = useRef(false);

  const fetchStreamSource = useCallback(async (serverId, signal) => {
    // `info` is hydrated client-side now — on a cold SSR it can be null for the
    // first render(s). Bail until we have it (this callback re-creates when
    // info?.id changes, so the effect re-fires with real metadata).
    if (!info?.id) return;
    const server = getServer(serverId);
    if (server.type === "iframe") {
      setHlsData(null);
      return;
    }

    setHlsLoading(true);
    setHlsData(null);

    // Fast path: the info page may have already resolved this exact source in
    // the background (megaplay, resume episode). If a fresh entry is in the
    // shared prefetch cache, use it immediately — no fetch, no extraction wait.
    const sub = dub ? "dub" : "sub";
    const prefetched = getPrefetchedSource(
      sourceKey(info.id, parseInt(epiNumber), serverId, sub),
    );
    if (prefetched && !signal?.aborted) {
      setHlsData(prefetched);
      setHlsLoading(false);
      markConfirmed(serverId);
      activeVerdictRef.current.ok.add(serverId);
      if (prefetched?.degraded) markDegraded(serverId);
      activeSourceSettledRef.current = true;
      return;
    }

    const askSource = () =>
      requestSource(
        {
          server: serverId,
          aniId: info.id,
          episode: parseInt(epiNumber),
          sub: dub ? "dub" : "sub",
          title: info?.title?.romaji || info?.title?.english,
          malId: info?.idMal ?? null,
        },
        {
          signal,
          // The active server's source is the request the user is actually
          // waiting on (everything else on the page is decoration). Hinting
          // high priority lets the browser bump it ahead of the probe burst
          // and any image / analytics fetches in the connection pool.
          priority: "high",
        },
      );

    try {
      let out = await askSource();

      if (signal?.aborted) return;

      // 204 = "source absent" under the soft404 contract. But some scraper
      // hosts (sibnet is the canonical case) serve an anti-bot DECOY on the
      // first cold hit — extraction fails once, then the route's player_map is
      // seeded and the very next call resolves fine (verified: 204 then 200
      // stable). The background probe already retries transient misses before
      // giving up; the on-click path did NOT, so one cold decoy hid a working
      // chip the instant the user selected it.
      //
      // One 800ms retry was not enough: seeding the player_map can outlast it,
      // so a second decoy still concluded "absent" and hid a WORKING chip for
      // the snapshot's 6h TTL — the user-visible bug is the chip vanishing at
      // the very moment you click it. Back off over a few attempts instead.
      //
      // A PROVEN absence (`hard`) skips the backoff entirely: the host answered
      // 404 for this upload, and no amount of waiting turns that into a stream.
      // Retrying it cost 3 requests and 5.6 s of spinner before the fallback
      // could even start — that was the "the VF player is dead" wait.
      for (
        let attempt = 0;
        out.kind === "absent" && !out.hard && attempt < DECOY_RETRIES;
        attempt++
      ) {
        await new Promise((r) => setTimeout(r, DECOY_BACKOFF_MS[attempt]));
        if (signal?.aborted) return;
        out = await askSource();
        if (signal?.aborted) return;
      }

      if (out.kind === "absent") {
        setHlsData({ error: true });
        markFailed(serverId, "Source not found");
        // Mark the chip failed for THIS session. Publishing is reserved for the
        // proven case: on the click path an ordinary decoy and a genuine soft404
        // are indistinguishable, and guessing wrong loses far more (a working
        // host hidden for 6h, cross-visitor) than it saves (one re-probe). The
        // background probe, which can afford to retry properly, owns those.
        // A `hard` verdict has no such ambiguity — and NOT publishing it is what
        // made a dead chip reappear on every single reload.
        if (out.hard) activeVerdictRef.current.hardAbsent.add(serverId);
      } else if (out.kind === "ok") {
        const data = out.data;
        setHlsData(data);
        setPrefetchedSource(
          sourceKey(info.id, parseInt(epiNumber), serverId, sub),
          data,
        );
        markConfirmed(serverId);
        activeVerdictRef.current.ok.add(serverId);
        if (data?.degraded) markDegraded(serverId);
      } else {
        // 5xx / transient — mark failed for the UI but do NOT publish as absent
        // (would wrongly hide a working server in the 6h snapshot).
        setHlsData({ error: true });
        markFailed(serverId, out.status ? `HTTP ${out.status}` : "Source unavailable");
      }
    } catch (e) {
      if (e.name === "AbortError") return;
      setHlsData({ error: true });
      markFailed(serverId, "Network error");
    } finally {
      if (!signal?.aborted) setHlsLoading(false);
      // Unblock the background probe fan-out whatever the outcome (success or
      // failure) so a dead active server never starves the selector forever.
      activeSourceSettledRef.current = true;
    }
  }, [info?.id, epiNumber, dub, markFailed]);

  useEffect(() => {
    // Hold the first fetch until the saved server preference has been read, so
    // we fetch the user's server first instead of megaplay-then-switch.
    if (!serverResolved) return;
    // Abort any previous in-flight fetch before starting a new one
    activeFetchCtrl.current?.abort();
    const ctrl = new AbortController();
    activeFetchCtrl.current = ctrl;
    activeSourceSettledRef.current = false; // gate the probe fan-out again
    fetchStreamSource(activeServer, ctrl.signal);
    return () => ctrl.abort();
  }, [activeServer, fetchStreamSource, serverResolved]);

  // ── Prefetch the NEXT episode ──────────────────────────────
  // When the user hits "Next episode", nothing is warm: the source resolves from
  // scratch, then the manifest + opening segments are fetched cold. We close that
  // gap by resolving the next episode's source on the ACTIVE server a few seconds
  // after the current one has settled — cheap (one /api/v2/source call, usually a
  // Redis hit), and it (a) seeds the shared prefetch cache so switching reads it
  // instantly, and (b) for megaplay triggers the server-side edge pre-warm (see
  // source/index.js) so the next episode's opening is a cache HIT on arrival.
  // Fire-and-forget, low priority, aborted on episode/server change.
  useEffect(() => {
    if (!serverResolved || !info?.id) return;
    const nextNum = episodeNavigation?.next?.number;
    if (nextNum == null) return;
    const sub = dub ? "dub" : "sub";
    // Already have it cached? Don't re-resolve.
    if (getPrefetchedSource(sourceKey(info.id, parseInt(nextNum), activeServer, sub))) {
      return;
    }
    const ctrl = new AbortController();
    // Wait until the active stream has settled so this never competes with the
    // request the user is actually waiting on.
    const delay = setTimeout(async () => {
      if (!activeSourceSettledRef.current) return;
      try {
        const out = await requestSource(
          {
            server: activeServer,
            aniId: info.id,
            episode: parseInt(nextNum),
            sub,
            title: info?.title?.romaji || info?.title?.english,
            malId: info?.idMal ?? null,
          },
          { signal: ctrl.signal, priority: "low" },
        );
        if (out.kind !== "ok") return;
        setPrefetchedSource(
          sourceKey(info.id, parseInt(nextNum), activeServer, sub),
          out.data,
        );
      } catch {
        /* aborted or offline — the next-episode click just resolves normally */
      }
    }, 5000);
    return () => {
      clearTimeout(delay);
      ctrl.abort();
    };
  }, [serverResolved, info?.id, activeServer, dub, episodeNavigation?.next?.number, info?.idMal]);

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
    // On phones / Save-Data mode the previous 8-way fan-out competes with the
    // active server's stream fetch for the device's small connection pool
    // (Safari iOS caps at 6 simultaneous requests, same origin) and delays
    // playback start by several seconds. Two concurrent probes is enough on
    // mobile to clear the list in <10 s without starving the foreground
    // playback request.
    const isMobileViewport =
      typeof window !== "undefined" &&
      window.matchMedia?.("(max-width: 768px)").matches;
    const saveData =
      typeof navigator !== "undefined" &&
      navigator.connection &&
      navigator.connection.saveData === true;
    // Desktop fans out 4 probes; mobile 3. The browser caps at 6 conns per
    // origin and the ACTIVE server is now probed first, outside this pool and
    // before the start-delay (see below) — so the foreground stream isn't
    // competing with the pool for its slot. That lets us bump mobile from 2→3
    // to clear the selector faster. saveData stays conservative at 2.
    const MAX_CONCURRENT = saveData ? 2 : isMobileViewport ? 3 : 4;
    // Head-start before the BACKGROUND pool starts, so the active stream's
    // source fetch (and the active server's own priority probe) get the
    // connection pool first. Shorter now (700 ms) because the active server is
    // probed immediately and separately — the delay only gates the rest.
    const PROBE_START_DELAY_MS = isMobileViewport ? 700 : 250;
    const RETRY_DELAY_MS = 3000;
    // A server the cross-visitor snapshot already reported `absent` was confirmed
    // dead by a previous visitor (2 attempts). Re-probing it every single visit —
    // ~half the ~17 servers, ×2 attempts each — was by far the biggest /api/v2/source
    // (POST, non-edge-cachable → ≥1 Upstash command each) consumer, and it dwarfed
    // everything the July edge-cache pass optimized. We still re-probe absents to
    // catch a recovered host, but only on a FRACTION of visits: across ~1/p visitors
    // a recovered host is rediscovered well within the snapshot's 6h TTL, while the
    // per-visit Upstash cost drops ~p×. See DEVLOG 2026-07-30.
    const SNAPSHOT_ABSENT_REPROBE_P = 0.2;
    let cancelled = false;

    // Session-level probe result cache. Hydrate CONFIRMED probes from
    // sessionStorage so the green dots appear at first paint on a reload.
    //
    // The key is PER EPISODE. It used to be per (anime, lang) on the premise
    // that "availability barely changes between episodes of the same anime" —
    // true of catalogue presence, false of the uploads themselves, which die one
    // episode at a time (Clevatess S2: ep1 and ep3 fine, ep2's vidmoly upload
    // deleted). Confirmations from ep1 were rehydrated onto ep2 for the whole
    // 90 s TTL, painting a green chip for a source that does not exist AND —
    // worse — landing in `cachedConfirmed`, which makes the fan-out skip the
    // probe that would have caught it. Every other availability store in this
    // page is keyed by episode; this one was the odd one out.
    // Cross-episode pre-painting is not lost: the cross-visitor snapshot
    // (/api/v2/availability, also per episode) still lights the chips at paint.
    //
    // FAILED probes deliberately don't persist: scrapers like sibnet and
    // vidmoly have intermittent anti-bot rejections that flip to OK on the
    // next request, and a 90-second sessionStorage entry would otherwise
    // hide the chip until the next tab close. Re-probing on reload is the
    // cheaper cost — at most an extra batch of POSTs that already happen
    // in the background. In-memory `cachedFailed` still suppresses re-probes
    // within the SAME mount (episode navigation).
    const PROBE_TTL_MS = 90_000;
    const probeCacheKey = `aniscroll.probes.${info.id}.${parseInt(epiNumber)}.${dub ? "dub" : "sub"}`;
    let cachedProbes = null;
    try {
      const raw = sessionStorage.getItem(probeCacheKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Date.now() - parsed.ts < PROBE_TTL_MS) {
          cachedProbes = parsed;
          // Re-hydrate UI markers from the cache so the selector dots
          // appear at the same instant the page renders.
          for (const id of parsed.confirmed || []) markConfirmed(id);
        }
      }
    } catch {
      /* sessionStorage may be disabled — fall through to full probe */
    }
    const cachedConfirmed = new Set(cachedProbes?.confirmed || []);
    // cachedFailed stays empty on hydration → every server probes again on
    // reload. Failures we see DURING this mount still get tracked here so
    // episode navigation doesn't re-probe known-failed servers.
    const cachedFailed = new Set();
    // STABLE absences only (server returned a hard 404/204 = no source for this
    // episode). Kept apart from cachedFailed, which also holds TRANSIENT
    // failures (anti-bot rejects that flip to OK next time). Only stable
    // absences are published to the availability snapshot — persisting a
    // transient one would wrongly hide a working host for 6h (the snapshot TTL).
    const confirmedAbsent = new Set();
    // Servers the cross-visitor snapshot reported as absent. Unlike cachedFailed
    // these are NOT skipped by the probe fan-out — they get RE-PROBED in the
    // background this visit. Reason: an `absent` entry is otherwise self-
    // perpetuating — hidden at paint, skipped by the probe, then re-published as
    // absent → frozen for the snapshot's whole 6h TTL even after the host is
    // healthy again (the megaplay / sibnet-vo "chip never comes back" bug). They
    // still stay HIDDEN at first paint (we don't markConfirmed them); the
    // background probe flips them to a green chip + re-publishes `ok` the moment
    // one resolves 200. A genuine 204/404 simply re-confirms the absence.
    const snapshotAbsent = new Set();
    // Save back to sessionStorage as confirmations come in. Failed probes
    // are intentionally not persisted (see comment above).
    const persistProbeCache = () => {
      try {
        const snapshot = {
          confirmed: Array.from(cachedConfirmed),
          ts: Date.now(),
        };
        sessionStorage.setItem(probeCacheKey, JSON.stringify(snapshot));
      } catch {}
    };

    // Returns: "ok" | "retry" | "fail-404" | "abort"
    // `requestSource` already folds a 200-with-{error} into "retry" for us.
    const attemptProbe = async (s) => {
      try {
        const out = await requestSource(
          {
            server: s.id,
            aniId: info.id,
            episode: parseInt(epiNumber),
            sub: dub ? "dub" : "sub",
            title: info?.title?.romaji || info?.title?.english,
            malId: info?.idMal ?? null,
          },
          {
            signal: controller.signal,
            // Probes are background work — they fill in the server-selector
            // chips but the user isn't blocked on them. Marking low priority
            // gets them out of the way of the active stream's source fetch
            // (which is priority:"high") in the browser's connection scheduler.
            priority: "low",
          },
        );

        if (out.kind === "absent") return { v: "fail-404" };
        if (out.kind !== "ok") return { v: "retry" };

        // 200 without `error` still isn't proof of a playable source — the
        // payload can come back empty. Validate the shape.
        const body = out.data;
        const hasStream =
          (Array.isArray(body?.streams) && body.streams.length > 0) ||
          (Array.isArray(body?.sources) && body.sources.length > 0) ||
          (typeof body?.iframe === "string" && body.iframe.length > 0);
        if (!hasStream) return { v: "retry" };
        // Return the resolved payload so the caller can seed the prefetch
        // cache — switching to this server then reads it instantly (no second
        // /api/v2/source round-trip + extraction wait).
        return { v: "ok", degraded: !!body?.degraded, data: body };
      } catch (e) {
        if (e?.name === "AbortError") return { v: "abort" };
        return { v: "retry" }; // network / DNS / timeout
      }
    };

    // Seed the shared prefetch cache with a probe's resolved source so that
    // SWITCHING to that server is instant — fetchStreamSource reads this cache
    // first. This is what "prefetch every available server" comes down to: the
    // probes already resolve each server's source to light its chip, so we just
    // keep the payload instead of throwing it away.
    const sub = dub ? "dub" : "sub";
    const seedSourceCache = (serverId, data) => {
      if (!data || data.error) return;
      try {
        setPrefetchedSource(
          sourceKey(info.id, parseInt(epiNumber), serverId, sub),
          data,
        );
      } catch {}
    };

    const probe = async (s) => {
      // Skip probes for servers we already verified in this session — they
      // were marked from the cache above and re-probing would only cost a
      // round-trip without changing the visible UI.
      if (cachedConfirmed.has(s.id) || cachedFailed.has(s.id)) return;
      const first = await attemptProbe(s);
      if (first.v === "abort" || cancelled) return;
      if (first.v === "ok") {
        cachedConfirmed.add(s.id);
        persistProbeCache();
        seedSourceCache(s.id, first.data);
        if (first.degraded) markDegraded(s.id);
        return markConfirmed(s.id);
      }
      // Snapshot-absent servers were ALREADY confirmed absent cross-visitor (a
      // previous visitor ran the full 2-attempt probe and published the absence).
      // Re-probing here only exists to catch a recovered host, so a SINGLE attempt
      // is enough — the decoy double-retry below is for FRESH unknown chips whose
      // first 204 might be an anti-bot decoy, not for a server another visitor has
      // already verified dead. Skipping the retry halves the /api/v2/source cost of
      // every re-probe (each POST = a non-cachable Upstash command).
      if (snapshotAbsent.has(s.id)) {
        if (first.v === "fail-404") {
          cachedFailed.add(s.id);
          confirmedAbsent.add(s.id);
          persistProbeCache();
          return markFailed(s.id, "Source not found");
        }
        // Transient this visit — keep it out of the UI but don't publish absence.
        cachedFailed.add(s.id);
        persistProbeCache();
        return markFailed(s.id, "Source unavailable");
      }

      // NOTE: a FIRST 204/404 is NOT treated as a terminal absence anymore.
      // sibnet (and other scraper hosts) serve an anti-bot decoy on the first
      // cold hit — the route resolves 204 once, then 200 on the very next call
      // (verified: cyberpunk ep2 sibnet-vo 204→200, the compile-cold request
      // even tripping a handler timeout). Concluding "absent" here is what made
      // the sibnet chip appear then vanish. So a first fail-404 falls through to
      // the same wait-and-retry as a transient error; only a SECOND fail-404
      // (below) is published as a genuine absence.

      // Transient OR a first cold 204 — wait, then try once more before giving up.
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      if (cancelled || controller.signal.aborted) return;

      const second = await attemptProbe(s);
      if (second.v === "abort" || cancelled) return;
      if (second.v === "ok") {
        cachedConfirmed.add(s.id);
        persistProbeCache();
        seedSourceCache(s.id, second.data);
        if (second.degraded) markDegraded(s.id);
        return markConfirmed(s.id);
      }
      if (second.v === "fail-404") {
        cachedFailed.add(s.id);
        confirmedAbsent.add(s.id);
        persistProbeCache();
        return markFailed(s.id, "Source not found");
      }
      // Two transient failures in a row — call it broken. NOT added to
      // confirmedAbsent: transient anti-bot failures must not be published as a
      // permanent absence (would hide a working host for the snapshot's TTL).
      cachedFailed.add(s.id);
      persistProbeCache();
      markFailed(s.id, "Source unavailable");
    };

    // Sliding-window pool: as soon as one probe settles, the next one starts —
    // instead of waiting for a whole batch (Promise.all) to finish. A single
    // slow server no longer holds up every chip behind it, so the selector
    // fills in continuously rather than in stuttering paquets.
    const runPool = async (servers, concurrency) => {
      let idx = 0;
      const worker = async () => {
        while (!cancelled) {
          const i = idx++;
          if (i >= servers.length) return;
          await probe(servers[i]);
        }
      };
      const n = Math.min(concurrency, servers.length);
      await Promise.all(Array.from({ length: n }, worker));
    };

    // Server-side availability hydration: a cross-visitor snapshot of which
    // servers resolved for this (anime, episode, lang) last time anyone
    // watched it. Pre-marks the chips green at first paint even on a COLD
    // visit (sessionStorage only helps within the same tab). A single Redis
    // GET; failure is silently ignored.
    //
    // CPU WIN: snapshot-confirmed servers are TRUSTED — we add them to
    // cachedConfirmed so the probe fan-out below SKIPS them. /api/v2/source is
    // by far the most CPU-expensive endpoint (multi-provider scrape + cheerio),
    // and re-probing every known-good server on every visit was burning the
    // bulk of our Vercel Fluid budget. The snapshot already tells us the server
    // works; we don't re-scrape just to repaint a chip that's already green.
    //
    // Trade-off: the prefetch source cache isn't seeded for trusted servers, so
    // clicking one fires a single /api/v2/source call (fast — Redis positive
    // cache hit if warm, one scrape if cold). That single on-demand resolve is
    // far cheaper than fan-out re-scraping every server up front. A stale
    // snapshot self-corrects: the on-select fetch flips the chip via markFailed
    // if the server is actually dead now.
    const hydrateFromServer = async () => {
      try {
        const r = await fetch(
          `/api/v2/availability?aniId=${info.id}&episode=${parseInt(epiNumber)}&sub=${sub}`,
          { signal: controller.signal },
        );
        if (!r.ok) return;
        const { servers, absent } = await r.json();
        if (cancelled) return;
        if (Array.isArray(servers)) {
          for (const id of servers) {
            // Trust the snapshot: paint the chip AND suppress the re-probe.
            cachedConfirmed.add(id);
            if (typeof markConfirmed === "function") markConfirmed(id);
          }
        }
        if (Array.isArray(absent)) {
          // Snapshot-absent servers stay HIDDEN at first paint (we don't paint
          // them green), but we do NOT drop them into cachedFailed — that would
          // make the probe fan-out skip them and re-publish the same absence,
          // freezing a since-recovered host for the whole 6h TTL. Instead they
          // go into snapshotAbsent so they get a background re-probe this visit:
          // a host that now resolves flips its chip green and re-publishes `ok`.
          for (const id of absent) snapshotAbsent.add(id);
        }
      } catch {
        /* offline / aborted — fall through to the normal probe fan-out */
      }
    };

    (async () => {
      // Kick the snapshot GET now but DON'T block on it yet — it overlaps the
      // active-stream wait + start delay below (both run anyway), so the
      // trusted-server set is ready by the time we compute `remaining` without
      // adding any latency in front of the probe burst.
      const hydrated = hydrateFromServer();

      // 1) Hold the background fan-out until the ACTIVE stream's source has
      //    settled, so the player's own request owns the (small) connection
      //    pool first. Poll the ref with a hard ceiling so a hung active
      //    source never blocks the selector indefinitely.
      const waitForActive = async () => {
        const ceil = Date.now() + 4000; // never wait longer than 4s
        while (
          !activeSourceSettledRef.current &&
          !cancelled &&
          Date.now() < ceil
        ) {
          await new Promise((r) => setTimeout(r, 100));
        }
      };
      await waitForActive();
      // A short extra beat so the first segment warm (warmStream) also gets a
      // head-start before the probe burst hits the pool.
      await new Promise((r) => setTimeout(r, PROBE_START_DELAY_MS));
      if (cancelled) return;

      // Snapshot must be settled before computing `remaining` so trusted
      // servers are excluded from the fan-out — it almost always finished
      // during the waits above, so this await is effectively free.
      await hydrated;
      if (cancelled) return;

      const remaining = toProbe.filter((s) => {
        if (cachedConfirmed.has(s.id) || cachedFailed.has(s.id)) return false;
        // Snapshot-absent servers are re-probed only on a fraction of visits
        // (SNAPSHOT_ABSENT_REPROBE_P): a recovered host is still rediscovered
        // within ~1/p visitors (well inside the 6h snapshot TTL), but we stop
        // paying a per-visit /api/v2/source POST (= an Upstash command) to
        // rediscover an absence a previous visitor already confirmed. This is
        // the dominant steady-state Upstash saving. Servers with NO snapshot
        // verdict yet (genuine unknowns) always probe.
        if (snapshotAbsent.has(s.id) && Math.random() >= SNAPSHOT_ABSENT_REPROBE_P) {
          return false;
        }
        return true;
      });

      // 2) The active server's source is fetched by fetchStreamSource (its own
      //    effect, priority:"high") — that lights its chip via markConfirmed.
      //    We DON'T separately probe it here: that was a duplicate /api/v2/source
      //    round-trip competing with the very request the player waits on.
      //    Read the LIVE active server (ref), not the one captured when this
      //    effect ran — see activeServerRef. The captured value is the pre-
      //    preference "megaplay" placeholder, and skipping it here is what hid
      //    the Megaplay chip on every visit for a user with a saved preference.
      const liveActive = activeServerRef.current;
      const activeIdx = remaining.findIndex((s) => s.id === liveActive);
      if (activeIdx >= 0) remaining.splice(activeIdx, 1);

      await runPool(remaining, MAX_CONCURRENT);

      // Publish the confirmed-server snapshot so the NEXT visitor's chips
      // light up instantly (server-side availability cache). Fire-and-forget,
      // never blocks anything; the endpoint collapses concurrent writes so a
      // popular episode costs ~1 Redis write regardless of viewer count.
      // Fold in the active-source fast-path verdicts (the active server is
      // resolved outside this pool, so its result isn't in cachedConfirmed /
      // confirmedAbsent). This is what gets `megaplay` (the default active
      // server) and the user's preferred server into the snapshot at all.
      const publishOk = new Set([
        ...cachedConfirmed,
        ...activeVerdictRef.current.ok,
      ]);
      // PROVEN absences from the active-source path join them: the host itself
      // answered 404 for that upload, which is not something a retry or another
      // visitor will see differently. Ambiguous ones still never get here — see
      // activeVerdictRef's contract.
      const publishAbsent = new Set([
        ...confirmedAbsent,
        ...activeVerdictRef.current.hardAbsent,
      ]);
      // A server can't be both — a confirmation always wins over a stale absence.
      for (const id of publishOk) publishAbsent.delete(id);
      if (!cancelled && (publishOk.size > 0 || publishAbsent.size > 0)) {
        try {
          fetch("/api/v2/availability", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              aniId: info.id,
              episode: parseInt(epiNumber),
              sub,
              servers: Array.from(publishOk),
              // Stable absences too → the next visitor skips probing these
              // entirely instead of re-scraping to rediscover they're empty.
              absent: Array.from(publishAbsent),
            }),
            keepalive: true,
            priority: "low",
          }).catch(() => {});
        } catch {}
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.id, epiNumber, dub]);

  // ── Iframe-type validators ─────────────────────────────────
  // Historically some iframe hosts (Megaplay, 4Animo) served a 200 HTML error
  // page when the episode didn't exist — the iframe loaded fine so our timeout
  // never fired, and a client-side HTML fetch + bad-marker check caught them.
  // Both servers are gone now (Megaplay is type:"api" with its own extractor;
  // 4Animo was retired), so there are no validators to run and the effect was
  // a no-op (empty map). Removed. If a future iframe server needs the same
  // HTML sanity check, reinstate the attempt/validate retry loop here (its
  // semantics mirror the main probe above).

  // ── Server change handler ──────────────────────────────────
  const handleServerChange = useCallback(
    (serverId) => {
      // When the host has blocked our playback, changing the server (lecteur)
      // is also a playback action — refuse it and explain why.
      if (party?.amPlaybackBlocked) {
        notify.error(t("party.blockedBanner"));
        return;
      }
      setActiveServer(serverId);
      localStorage.setItem("preferred_server", serverId);
      // The URL no longer encodes the server — preference lives entirely
      // in localStorage, so shares/bookmarks don't pin a stale server id
      // and switching players doesn't dirty the browser history.
      // Sync the server across the party. Remote-applied changes bypass this
      // handler (they call setActiveServer directly), so reaching here always
      // means a genuine local action worth broadcasting.
      if (party) party.broadcast("server", { server: serverId });
    },
    [party, t]
  );

  // ── Keyboard shortcut: cycle to the next player/server ──────
  // The player fires `aniscroll:cycleServer` (it doesn't own the server list).
  // We cycle through the servers IN THE EXACT ORDER THEY'RE SHOWN in the
  // selector (multi → vo → vf, each fastest-first) and with the SAME visibility
  // rules (`shouldShow`), so pressing the shortcut walks the chips left→right,
  // top→bottom just like the UI — never a hidden/failed server.
  useEffect(() => {
    const onCycle = () => {
      const { getServersByLang } = require("@/lib/servers");
      const groups = getServersByLang();
      // Same visibility test as serverSelector.js `shouldShow`.
      const isVisible = (s) => {
        if (s.id === activeServer) return true;
        if (failedServers?.has?.(s.id)) return false;
        if (s.type === "iframe") return true;
        return confirmedServers.has(s.id);
      };
      const pool = [...groups.multi, ...groups.vo, ...groups.vf].filter(isVisible);
      if (pool.length < 2) return; // nothing to cycle to
      const idx = pool.findIndex((s) => s.id === activeServer);
      const next = pool[(idx + 1) % pool.length];
      if (next && next.id !== activeServer) {
        handleServerChange(next.id);
        // Unified notice store — same animated stack as every other notice; the
        // global <NoticeStack> portals it into the player when fullscreen.
        notify(t("player.switchedTo", { name: next.name }));
      }
    };
    window.addEventListener("aniscroll:cycleServer", onCycle);
    return () => window.removeEventListener("aniscroll:cycleServer", onCycle);
  }, [confirmedServers, failedServers, activeServer, handleServerChange, t]);

  // ── Media Session (OS-level now playing) ────────────────────
  useEffect(() => {
    const mediaSession = navigator.mediaSession;
    if (!mediaSession) return;

    const now    = episodeNavigation?.playing;
    const title  = now?.title || info?.title?.romaji;

    // Use the portrait cover for the OS "now playing" artwork. Previously we
    // used the episode thumbnail / bannerImage (wide), which iOS letterboxed
    // into the square artwork slot as an ugly banner. The portrait cover fills
    // the slot cleanly. Declare the real (portrait) aspect so iOS doesn't try
    // to fit it into a 1:1 box.
    const cover =
      info?.coverImage?.extraLarge ||
      info?.coverImage?.large ||
      now?.img ||
      info?.bannerImage;

    mediaSession.metadata = new MediaMetadata({
      title,
      artist: `AniScroll ${
        title === info?.title?.romaji
          ? "- Episode " + epiNumber
          : `- ${info?.title?.romaji || info?.title?.english}`
      }`,
      artwork: cover
        ? [
            { src: cover, sizes: "600x900", type: "image/jpeg" },
            { src: cover, sizes: "1200x1800", type: "image/jpeg" },
          ]
        : undefined,
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

    /* Build the canonical "next episode" URL once so SkipOverlay's
       "Next Episode" button can use it. We mirror exactly what the
       episode list does (see components/watch/secondary/episodeLists.tsx)
       so the navigation feels identical to clicking the next thumbnail
       — same query params (id + num + optional dub), same provider. */
    const nextEp = episodeNavigation?.next;
    const prevEp = episodeNavigation?.prev;
    // Clean ?id= form: `{server}-{episode}` (no AniList id in the middle). Keeps
    // the URL bar tidy and matches what the in-page sync writes on server change.
    const nextEpisodeHref = nextEp
      ? `/en/anime/watch/${info.id}?id=${encodeURIComponent(
          `${activeServer}-${nextEp.number}`
        )}&num=${nextEp.number}${dub ? `&dub=${dub}` : ""}`
      : null;
    // Same shape for the previous episode — surfaced to the player so the
    // "previous episode" keyboard shortcut can navigate.
    const prevEpisodeHref = prevEp
      ? `/en/anime/watch/${info.id}?id=${encodeURIComponent(
          `${activeServer}-${prevEp.number}`
        )}&num=${prevEp.number}${dub ? `&dub=${dub}` : ""}`
      : null;

    if (needsBackend) {
      if (hlsData?.error) {
        return (
          <div className="flex-center aspect-video w-full h-full bg-black text-white/50 font-karla flex-col gap-2 rounded-card ring-1 ring-white/5">
            <p>{t("player.serverUnavailable", { name: server.name })}</p>
            <button
              type="button"
              onClick={() => handleServerChange("megaplay")}
              className="text-as-accent underline text-sm"
            >
              {t("player.switchToMegaplay")}
            </button>
          </div>
        );
      }

      // Unified player: Vidstack for direct streams (HLS/MP4 with speed /
      // quality / captions / chromecast / PiP / ambient light), iframe chrome
      // for embed-only hosts (vidmoly, voe, streamtape, hianime).
      const playerKey = `${server.id}-${info.id}-${epiNumber}-${dub ? "dub" : "sub"}`;
      return (
        <PlayerErrorBoundary key={playerKey} resetKey={playerKey}>
          <UniversalPlayer
            autoplay={!!autoplay}
            streamData={hlsData}
            poster={episodeNavigation?.playing?.img || info?.bannerImage}
            serverId={server.id}
            nextEpisodeHref={nextEpisodeHref}
            prevEpisodeHref={prevEpisodeHref}
            malId={info?.idMal || null}
            aniListId={info?.id || null}
            episodeNumber={parseInt(epiNumber)}
            onEpisodeComplete={handleEpisodeComplete}
            isFinalEpisode={isFinalEpisode}
            isSingleEpisode={isSingleEpisode}
            onFinalEpisodeNearEnd={handleFinalEpisodeNearEnd}
            party={party}
            downloadName={`${(info?.title?.romaji || info?.title?.english || "anime").replace(/\s+/g, "_")}_E${epiNumber}${dub ? "_DUB" : ""}`}
            onError={(reason) =>
              markFailed(
                server.id,
                reason || (hlsData?.iframe ? "Iframe load timeout" : "Playback failed")
              )
            }
          />
        </PlayerErrorBoundary>
      );
    }

    // buildSrc-style server (Megaplay): always an iframe → same universal chrome
    const src = server.buildSrc({
      aniId: info.id,
      episode: epiNumber,
      dub: !!dub,
    });

    const iframeKey = `${server.id}-${info.id}-${epiNumber}-${dub ? "dub" : "sub"}`;
    return (
      <PlayerErrorBoundary key={iframeKey} resetKey={iframeKey}>
        <UniversalPlayer
          streamData={{ iframe: src }}
          poster={episodeNavigation?.playing?.img || info?.bannerImage}
          serverId={server.id}
          nextEpisodeHref={nextEpisodeHref}
          prevEpisodeHref={prevEpisodeHref}
          malId={info?.idMal || null}
          aniListId={info?.id || null}
          episodeNumber={parseInt(epiNumber)}
          onEpisodeComplete={handleEpisodeComplete}
          isFinalEpisode={isFinalEpisode}
          isSingleEpisode={isSingleEpisode}
          onFinalEpisodeNearEnd={handleFinalEpisodeNearEnd}
          party={party}
          onError={(reason) => markFailed(server.id, reason || "Iframe load timeout")}
        />
      </PlayerErrorBoundary>
    );
    // Depend on the party's STABLE callbacks, not the whole `party` object
    // (which changes on every chat/presence update) — otherwise the player
    // rebuilds on each message, restarting playback and breaking sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeServer, episodeNavigation, hlsLoading, hlsData, info, epiNumber, dub, markFailed, handleServerChange, autoplay, handleEpisodeComplete, isFinalEpisode, isSingleEpisode, handleFinalEpisodeNearEnd, party?.onRemote, party?.broadcast]);

  // ── Render ───────────────────────────────────────────────────
  // The Watch-Party panel. Rendered in two places: on mobile it sits in the
  // primary column directly under the player (`lg:hidden`), on desktop it lives
  // in the secondary column beside the episode list (`hidden lg:block`). Built
  // once here so both placements stay in sync.
  const partyPanelBlock = (party || partyUIOpen) && (
    partyPanelHidden ? (
      <button
        onClick={() => setPartyPanelHidden(false)}
        className="mb-4 flex items-center gap-2 rounded-full bg-action/20 px-3 py-2 text-sm font-medium text-action hover:bg-action/30"
      >
        <UsersIcon className="h-4 w-4" /> {t("party.openChat")}
      </button>
    ) : (
      <div
        className="mb-4 lg:h-[var(--player-h)]"
        style={
          // Match the player height on large screens only. The pixel value is
          // the FULL-WIDTH player height; on a phone (player spans the
          // viewport) that is far taller than the panel's mobile `h-[60vh]`, so
          // applying it as a plain inline height left the panel overlapping the
          // episode list. We expose it as a CSS var and only consume it at
          // `lg:`; on mobile the inner `h-[60vh]` drives the height instead.
          playerBoxH ? { "--player-h": `${playerBoxH}px` } : undefined
        }
      >
        <div className="h-[60vh] max-h-[520px] lg:h-full lg:max-h-none">
          <WatchPartyPanel
            party={party}
            lobby={{ aniId: info?.id, epiNumber, dub, server: activeServer }}
            onClose={() => {
              setPartyPanelHidden(true);
              if (!party) setPartyUIOpen(false);
            }}
          />
        </div>
      </div>
    )
  );

  return (
    <>
      <Head>
        <title>AniScroll • Beta</title>
        {/* Warm DNS + TCP + TLS for the hosts the player is most likely to
            hit, in parallel with the rest of the page render. Saves the
            ~100-300 ms handshake when the actual stream/iframe request
            fires. preconnect handles all three; dns-prefetch is a fallback
            for older browsers that ignore preconnect. */}
        <link rel="preconnect" href="https://megaplay.buzz" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://video.sibnet.ru" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://sendvid.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://vidmoly.to" crossOrigin="anonymous" />
        {/* Warm the video proxy Worker unconditionally: the env var is only a
            build-time override, and when it's unset the player still hardcodes
            the same Worker as its fallback — so preconnect must target the
            resolved base, not gate on the env var being present. */}
        <link rel="preconnect" href={PROXY_BASE} crossOrigin="anonymous" />
        <link rel="dns-prefetch" href={PROXY_BASE} />
        <link rel="dns-prefetch" href="https://megaplay.buzz" />
        <link rel="dns-prefetch" href="https://video.sibnet.ru" />
        <link rel="dns-prefetch" href="https://sendvid.com" />
        <link rel="dns-prefetch" href="https://vidmoly.to" />
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
            <h1 className="text-md font-extrabold font-karla">{t("nav.editYourList")}</h1>
            <button
              className="flex items-center bg-[#363642] rounded-md text-white p-1"
              onClick={() => signIn("AniListProvider")}
            >
              <h1 className="px-1 font-bold font-karla">{t("nav.loginWithAniList")}</h1>
              <div className="scale-[60%] pb-[1px]">
                <AniList />
              </div>
            </button>
          </div>
        )}
      </Modal>

      {/* The in-page "report" button (down by the share row) opens
          this modal pre-targeted at the current anime + episode so
          users land directly on the structured Anime-bug tab. */}
      <ReportModal
        isOpen={isOpen}
        setIsOpen={setIsOpen}
        animeContext={
          info
            ? {
                animeId: info.id,
                animeTitle: pickTitle(info.title, titlePref),
                episode: parseInt(epiNumber),
              }
            : null
        }
      />

      <main className="w-screen h-full">
        <RateModal
          toggle={ratingModalState.isOpen}
          setToggle={setRatingModalState}
          session={sessions}
        />

        <Navbar
          info={info}
          scrollP={20}
          withNav={true}
          shrink={true}
          paddingY={`py-2 ${theaterMode ? "" : "lg:py-4"}`}
        />
        <MobileNav hideProfile={true} />

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
                  ref={playerBoxRef}
                  className={`w-full flex-center ${
                    aspectRatio === "4/3" ? "aspect-video" : ""
                  }`}
                >
                  {playerNode}
                </div>
              )}

              {/* Watch-Party panel (mobile) — sits directly under the player,
                  above the server picker. Desktop renders it beside the episode
                  list instead (`hidden lg:block` there, `lg:hidden` here). */}
              {partyPanelBlock && (
                <div className="px-3 pt-4 lg:hidden">{partyPanelBlock}</div>
              )}

              {/* Server selector */}

              <div className="px-3 lg:px-0">
                <ServerSelector
                  activeServer={activeServer}
                  onChange={handleServerChange}
                  failedServers={failedServers}
                  confirmedServers={confirmedServers}
                  degradedServers={degradedServers}
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
                        {episodeNavigation?.playing?.title || (info?.title && pickTitle(info.title, titlePref)) || t("common.loading")}
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
                    {!partyUIOpen && info?.id && (
                      <button
                        type="button"
                        onClick={() => {
                          setPartyUIOpen(true);
                          setPartyPanelHidden(false);
                        }}
                        className="flex items-center gap-2 rounded-md bg-action/20 px-3 py-2 text-sm font-medium text-action transition hover:bg-action/30"
                      >
                        <UsersIcon className="h-5 w-5" />
                        <span className="hidden lg:block">{t("party.watchTogether")}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleShareClick}
                      className="flex items-center gap-2 px-3 py-1 ring-[1px] ring-white/20 rounded overflow-hidden"
                    >
                      <ShareIcon className="w-5 h-5" />
                      <span className="hidden lg:block">{t("anime.share")}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsOpen(true)}
                      className="flex items-center gap-2 px-3 py-1 ring-[1px] ring-white/20 rounded overflow-hidden"
                    >
                      <FlagIcon className="w-5 h-5" />
                      <span className="hidden lg:block">{t("nav.report")}</span>
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
              className={`relative ${theaterMode ? "pt-5" : "pt-4 lg:pt-0"} lg:pl-4`}
            >
              {/* Desktop placement — beside the episode list. On mobile the
                  panel renders in the primary column under the player instead. */}
              {partyPanelBlock && (
                <div className="hidden px-3 lg:block lg:px-0">{partyPanelBlock}</div>
              )}
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

// Build a watch URL with the TWO path segments the [...info] route needs
// (`/{aniId}/{provider}`). Pushing a single-segment pathname made Next update
// the URL bar without re-running getServerSideProps, so a party redirect changed
// the address but not the page ("redirigé mais la page ne se met pas à jour").
// Mirrors the form used everywhere else in the app, with ?party preserved.
function buildWatchUrl(aniId, ep, dub, server, roomId) {
  const provider = server || "megaplay";
  const params = new URLSearchParams({
    id: `${provider}-${ep}`,
    num: String(ep),
  });
  if (dub) params.set("dub", "true");
  if (roomId) params.set("party", String(roomId));
  return `/en/anime/watch/${aniId}/${provider}?${params.toString()}`;
}

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
