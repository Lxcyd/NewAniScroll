import "../styles/globals.css";
import "react-loading-skeleton/dist/skeleton.css";
import Script from "next/script";
import dynamic from "next/dynamic";
import { useRouter } from "next/router";
import NextNProgress from "nextjs-progressbar";
import { SessionProvider, useSession } from "next-auth/react";
import { SkeletonTheme } from "react-loading-skeleton";
import { SearchProvider, useSearch } from "@/lib/context/isOpenState";
import { WatchPageProvider } from "@/lib/context/watchPageProvider";
import I18nProvider from "@/lib/i18n/I18nProvider";
import { useEffect, useState } from "react";
import { unixTimestampToRelativeTime } from "@/utils/getTimes";
import { asCssVars, BRAND } from "@/lib/theme";
import { applyAccent, getAccent } from "@/lib/prefs/accentColor";
import NoticeStack from "@/components/shared/NoticeStack";
import EpisodeTransitionOverlay from "@/components/shared/episodeTransitionOverlay";
import { notify } from "@/lib/notifications/noticeStore";
import { Analytics } from "@vercel/analytics/react";
import { getSyncPrefs, setSyncPrefs } from "@/lib/prefs/syncPrefs";
import { useMountedOnce } from "@/lib/hooks/useMountedOnce";
import { chargerPriorPartage } from "@/lib/watch/serverPerf";
import type { SyncDirection } from "@/components/shared/SyncDirectionModal";
import { useTranslation } from "react-i18next";
import type { AppProps } from "next/app";

/*
 * Everything below is mounted by _app on EVERY page, and none of it renders a
 * single node before something happens — a hover, a keypress, a fetch that says
 * "there is a changelog to show". Static imports put all of it in the shared
 * `_app` chunk, which is the one file no visitor can avoid downloading; a
 * `dynamic` import moves it to its own chunk fetched after hydration (or, for
 * the palette, only on the first open) without changing WHEN any of it appears.
 *
 * ssr:false is correct for all of them because all of them render `null` on the
 * server today: the palette's dialog is closed, the changelog hasn't fetched,
 * the health banner returns null unconditionally, and the hover preview bails on
 * `typeof document === "undefined"`. So the server HTML is byte-identical.
 */
const SearchPalette = dynamic(() => import("@/components/searchPalette"), {
  ssr: false,
});
const ChangeLogs = dynamic(() => import("../components/shared/changelogs"), {
  ssr: false,
});
const AnilistHealthBanner = dynamic(
  () => import("../components/shared/AnilistHealthBanner"),
  { ssr: false },
);
const HoverPreviewProvider = dynamic(
  () => import("@/components/shared/HoverPreview/HoverPreviewProvider"),
  { ssr: false },
);
const SyncDirectionModal = dynamic(
  () => import("@/components/shared/SyncDirectionModal"),
  { ssr: false },
);

/** Mounts the palette on its first open — see useMountedOnce. */
function SearchPaletteMount() {
  const { isOpen } = useSearch();
  return useMountedOnce(isOpen) ? <SearchPalette /> : null;
}

// Cloudflare Worker base. The same Worker that proxies HLS also serves a few
// endpoints offloaded from Vercel to cut Fluid Active CPU: /w/track (analytics),
// /w/broadcast and /w/health (polled banners). Mirrors the default used by the
// player (UniversalPlayer / lib/extractors). When the env var is unset we fall
// back to the Vercel routes so nothing breaks in local dev.
const WORKER_BASE =
  (process.env.NEXT_PUBLIC_PROXY_BASE as string | undefined) ||
  "https://proxy.aniscroll.com";

/**
 * First-login sync bootstrap. Lives INSIDE <SessionProvider> so it can read the
 * live AniList session via useSession(). On the first authenticated load after
 * connecting AniList it:
 *   1. flips the sync master toggle ON (default behaviour),
 *   2. shows a toast confirming sync is now active,
 *   3. opens the one-time direction chooser (AniList → local, or local →
 *      AniList), recording the answer in `directionChosen` so it never re-nags.
 *
 * The `directionChosen` flag is the single guard: once the user has answered
 * (here or in Settings), this component does nothing on subsequent loads and
 * the normal background resync in MyApp takes over.
 */
function SyncBootstrap() {
  const { data: session, status } = useSession();
  const { t } = useTranslation();
  const [showDirection, setShowDirection] = useState(false);
  const [busy, setBusy] = useState(false);

  const isConnected = !!(session as any)?.user?.token;

  useEffect(() => {
    if (status === "loading") return;
    // Disconnected: turn sync off (a logged-out user has no AniList account to
    // sync with) and clear `directionChosen` so a future reconnect re-asks the
    // direction question fresh. Only write when something actually changes, to
    // avoid a redundant storage event on every render.
    if (!isConnected) {
      const p = getSyncPrefs();
      if (p.enabled || p.directionChosen) {
        setSyncPrefs({ enabled: false, directionChosen: false });
      }
      return;
    }
    const prefs = getSyncPrefs();
    if (prefs.directionChosen) return; // already answered once — don't re-nag.

    // First connect → ask whether (and how) to sync. We DON'T pre-enable here:
    // the popup itself is the enable action, and "Don't sync" must leave it off.
    setShowDirection(true);
  }, [isConnected, status]);

  const choose = async (direction: SyncDirection) => {
    // "Don't sync" — leave both lists untouched, sync stays off.
    if (direction === "off") {
      setSyncPrefs({ enabled: false, directionChosen: true });
      notify.message(t("settings.sync.dismissedToast"));
      setShowDirection(false);
      return;
    }

    setBusy(true);
    // Picking a direction enables sync (+ confirmation toast, same style as the
    // "list entry saved" toast).
    setSyncPrefs({ enabled: true });
    notify.success(t("settings.sync.enabledToast"), {
      description: t("settings.sync.enabledToastDesc"),
    });
    try {
      // Loaded here rather than at the top of the file: the sync engine is a
      // reconciler for the whole AniList list, and nothing on the site touches
      // it until the visitor picks a direction (here) or the idle resync below
      // fires — neither of which is on any page's first-paint path.
      const { fullSyncFromAniList, fullSyncToAniList, runAutoPauseSweep } =
        await import("@/lib/list/syncEngine");
      const r =
        direction === "fromAniList"
          ? await fullSyncFromAniList({ replace: true })
          : await fullSyncToAniList();
      if (r.ok) {
        notify.success(
          direction === "fromAniList"
            ? t("settings.sync.synced", { count: r.count })
            : t("settings.sync.pushed", { count: r.count }),
        );
        await runAutoPauseSweep().catch(() => {});
      } else {
        notify.error(t("settings.sync.syncFailed"));
      }
    } finally {
      // Record the answer whatever the outcome so we don't re-prompt on every
      // load after a transient AniList failure — the user can still use
      // "Resync now" / the Settings toggle to retry.
      setSyncPrefs({ directionChosen: true });
      setBusy(false);
      setShowDirection(false);
    }
  };

  const cancel = () => {
    // Dismissing the prompt (backdrop / no pick) = same as "Don't sync": leave
    // sync off, mark it answered so it doesn't reopen on every navigation.
    setSyncPrefs({ enabled: false, directionChosen: true });
    setShowDirection(false);
  };

  return (
    <SyncDirectionModal
      open={showDirection}
      onChoose={choose}
      onCancel={cancel}
      busy={busy}
    />
  );
}

/**
 * Replaces every {{date:VALUE}} placeholder in `text` with a date string
 * formatted in the visitor's local timezone. VALUE can be either:
 *   - a Unix timestamp in seconds  ({{date:1736000000}})
 *   - an ISO date string           ({{date:2026-12-25T15:00}})
 * Anything else is passed through unchanged so a typo doesn't make the
 * message disappear.
 */
function formatBroadcastDates(text: string): string {
  return text.replace(/\{\{\s*date:([^}]+?)\s*\}\}/g, (match, raw) => {
    const trimmed = raw.trim();
    const asNumber = Number(trimmed);
    let d: Date | null = null;
    if (Number.isFinite(asNumber) && asNumber > 0) {
      // Unix seconds vs ms: assume seconds if it's a "small" number.
      d = new Date(asNumber < 1e12 ? asNumber * 1000 : asNumber);
    } else {
      const parsed = new Date(trimmed);
      if (!isNaN(parsed.getTime())) d = parsed;
    }
    if (!d) return match;
    // No timeZoneName — render the date implicitly in the visitor's local
    // timezone without surfacing "UTC+1" or similar TZ suffixes.
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  });
}

export default function App({
  Component,
  pageProps: { session, ...pageProps },
}: AppProps) {
  const router = useRouter();

  // Inject the theme colors from lib/theme.ts as CSS custom properties on
  // :root so every component (Tailwind utilities, raw CSS, inline styles)
  // can read them. Single source of truth; edit lib/theme.ts to rebrand.
  useEffect(() => {
    const vars = asCssVars();
    for (const [k, v] of Object.entries(vars)) {
      document.documentElement.style.setProperty(k, v);
    }
    // User accent override (after the defaults so it wins).
    applyAccent(getAccent());
  }, []);

  // GPU saver: when the tab isn't visible, freeze all CSS animations site-wide
  // by toggling a `tab-hidden` class on <html> (see globals.css). Loaders,
  // pulsing status dots, and entrance animations don't need to keep compositing
  // on the GPU for a tab nobody is looking at. Everything resumes instantly on
  // refocus — no feature is removed, only paused while invisible.
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      if (document.hidden) root.classList.add("tab-hidden");
      else root.classList.remove("tab-hidden");
    };
    apply();
    document.addEventListener("visibilitychange", apply);
    return () => document.removeEventListener("visibilitychange", apply);
  }, []);

  /* Le classement des lecteurs mis en commun, recupere une fois par jour et sur
     temps mort. Ici et pas sur la page de lecture : il sert aussi a la page
     d'anime, qui choisit deja un lecteur par defaut (`pickServerForLangs`).
     Sans effet sur la page en cours — l'ordre y est fige au chargement — il
     prepare la suivante. Voir lib/watch/serverPerf. */
  useEffect(() => {
    chargerPriorPartage();
  }, []);

  // Lightweight pageview analytics — fires on every route change. The
  // visitor_id is a stable random token kept in localStorage so we can
  // count unique visitors without identifying anyone. Fully fire-and-
  // forget; never blocks navigation.
  useEffect(() => {
    let visitorId: string;
    try {
      const KEY = "aniscroll.visitorId";
      visitorId = localStorage.getItem(KEY) || "";
      if (!visitorId) {
        visitorId =
          (crypto as any)?.randomUUID?.() ||
          Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem(KEY, visitorId);
      }
    } catch {
      visitorId = "anon-" + Math.random().toString(36).slice(2);
    }

    // Dedupe consecutive identical paths. Next.js fires routeChangeComplete
    // multiple times for shallow-route updates (slug rewrites, query-only
    // changes) — without this guard we'd ship 3-5 duplicate analytics POSTs
    // per real navigation.
    let lastPath: string | null = null;
    const send = (path: string) => {
      // Normalise: strip the hash + collapse double slashes so /foo and
      // /foo#bar both count as one visit.
      const norm = (path || "/").split("#")[0].replace(/\/+/g, "/");
      if (norm === lastPath) return;
      lastPath = norm;
      try {
        // Offloaded to the Cloudflare Worker (/w/track) so a per-navigation ping
        // no longer invokes a Vercel function. The Worker writes to the same
        // Turso analytics table. Falls back to the Vercel route when no Worker
        // base is configured (local dev).
        const trackUrl = WORKER_BASE.startsWith("http")
          ? `${WORKER_BASE.replace(/\/+$/, "")}/w/track`
          : "/api/v2/track";
        fetch(trackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ visitorId, path: norm }),
          keepalive: true,
        }).catch(() => {});
      } catch {}
    };

    send(router.asPath);
    const onRoute = (url: string) => send(url);
    router.events.on("routeChangeComplete", onRoute);
    return () => router.events.off("routeChangeComplete", onRoute);
  }, [router]);

  useEffect(() => {
    // Sonner's toast.message stacks every call — without a stable `id`,
    // React strict-mode + the fast-refresh dev server double-fires this
    // effect and produces two visible toasts. Passing a fixed `id` makes
    // the second call update the first instead of stacking.
    let cancelled = false;
    async function getBroadcast() {
      if (cancelled) return;
      try {
        // Offloaded to the Cloudflare Worker (/w/broadcast), which serves the
        // value from KV at the edge — so polling no longer invokes a Vercel
        // function. Falls back to the Vercel route in local dev (no Worker base).
        // The X-Broadcast-Key header is only needed by the Vercel route's soft
        // guard; the Worker ignores it.
        const useWorker = WORKER_BASE.startsWith("http");
        const url = useWorker
          ? `${WORKER_BASE.replace(/\/+$/, "")}/w/broadcast`
          : "/api/v2/admin/broadcast";
        const res = await fetch(url, {
          method: "GET",
          // Let the browser honour the server's Cache-Control header
          // (s-maxage=60). Setting "no-store" here was forcing a network
          // round-trip on every page load even when the response was
          // identical to one we'd just received.
          headers: useWorker
            ? { "Content-Type": "application/json" }
            : {
                "Content-Type": "application/json",
                "X-Broadcast-Key": "get-broadcast",
              },
        });
        const data = await res.json();
        if (!data?.show) return;

        // Persistent dismiss: once the user closes a broadcast we keep
        // its signature in localStorage so refresh / nav doesn't bring it
        // back. The signature is the message + start_at — any admin edit
        // (new message OR new schedule) generates a fresh signature and
        // the toast shows again. updated_at would be more precise but the
        // endpoint doesn't expose it yet.
        const signature = `${data.title || ""}|${data.message}|${data.startAt || ""}|${data.endAt || ""}`;
        try {
          const dismissed = localStorage.getItem("aniscroll.broadcast.dismissed");
          if (dismissed === signature) return;
        } catch {}

        // Render dates inside the message in the user's local timezone.
        // The admin types {{date:UNIX_SECONDS}} or {{date:YYYY-MM-DDTHH:mm}}
        // and we replace each occurrence with a localised string.
        const localised = formatBroadcastDates(String(data.message || ""));

        // Optional "until" date (admin can schedule when the broadcast
        // should stop showing). Once we're past it, do not toast at all.
        if (data.endAt && Math.floor(Date.now() / 1000) > Number(data.endAt)) {
          return;
        }

        const description = data?.startAt
          ? `${localised} (${unixTimestampToRelativeTime(data.startAt)})`
          : localised;

        // Admin can customise the heading — fallback to "Update notice"
        // when they leave it empty.
        const heading = (data.title || "").trim() || "Update notice";
        notify.message(heading, {
          id: "global-broadcast",
          important: true,
          duration: Infinity,
          className: "font-karla",
          description,
          // When the visitor closes the toast, persist the dismiss so we
          // don't re-show the same broadcast on the next page load.
          onDismiss: () => {
            try {
              localStorage.setItem("aniscroll.broadcast.dismissed", signature);
            } catch {}
          },
        });
      } catch (err) {
        console.log(err);
      }
    }
    getBroadcast();
    // Poll for freshly-published broadcasts. 5 min (not 30 s) is plenty for
    // an admin announcement banner. The toast carries a fixed id so repeated
    // polls update in place instead of stacking, and any active broadcast still
    // shows immediately on load.
    //
    // On-focus gating: the interval only runs while the tab is VISIBLE. A
    // backgrounded tab that nobody is looking at doesn't need to keep polling;
    // we stop the timer when hidden and poll once on return so a broadcast
    // published while away still appears promptly.
    let interval: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => {
      if (interval == null) interval = setInterval(getBroadcast, 300_000);
    };
    const stopPolling = () => {
      if (interval != null) {
        clearInterval(interval);
        interval = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        getBroadcast();
        startPolling();
      } else {
        stopPolling();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (typeof document === "undefined" || document.visibilityState === "visible") {
      startPolling();
    }
    return () => {
      cancelled = true;
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Once per app load, deferred to idle (never blocks first paint), best-effort:
  //   1. Resync: pull AniList → local when sync is on + connected. Keeps the
  //      local mirror fresh (and recovers it after AniList was down). No-op /
  //      leaves local untouched on failure, so the list survives an outage.
  //   2. Auto-pause sweep on the (now fresh) local list.
  //
  // GATE: skip the auto pull until the user has answered the one-time
  // direction prompt (SyncBootstrap). Before that choice we must NOT pull
  // AniList → local, or a first-time user with a local list would silently lose
  // it to a (non-destructive but overriding) reconcile before they got to pick
  // "push my list up to AniList instead".
  useEffect(() => {
    const run = async () => {
      if (!getSyncPrefs().directionChosen) return;
      const { fullSyncFromAniList, runAutoPauseSweep } = await import(
        "@/lib/list/syncEngine"
      );
      await fullSyncFromAniList().catch(() => {});
      await runAutoPauseSweep().catch(() => {});
    };
    const ric = (window as any).requestIdleCallback;
    if (typeof ric === "function") {
      const id = ric(() => void run(), { timeout: 4000 });
      return () => (window as any).cancelIdleCallback?.(id);
    }
    const tid = setTimeout(() => void run(), 2000);
    return () => clearTimeout(tid);
  }, []);

  return (
    <>
      {/* Google Cast SDK — enables the Chromecast button in the video player */}
      <Script
        src="https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1"
        strategy="afterInteractive"
      />
      {/* SessionProvider polls /api/auth/session every minute by default
          AND on every window focus. Each poll = 1 Vercel function
          invocation. With users keeping tabs open for hours that adds up
          fast on the Hobby tier. We keep the SSR-side session prop (no
          flash on first render) but disable client polling entirely —
          the JWT lives in a cookie that's still validated on every
          server-side request that needs it (getServerSession in API
          routes), so security isn't affected, just the convenience
          refresh on the client. */}
      <SessionProvider
        session={session}
        refetchInterval={0}
        refetchOnWindowFocus={false}
      >
        <I18nProvider>
        <SearchProvider>
          <WatchPageProvider>
            <SkeletonTheme baseColor="#232329" highlightColor="#2a2a32">
                <NoticeStack />
                {/* Holds fullscreen (and shows the pink loading bar) while the
                    player navigates to another episode. Must live OUTSIDE
                    <Component> so it survives the navigation. */}
                <EpisodeTransitionOverlay />
                <ChangeLogs />
                <AnilistHealthBanner />
                <SyncBootstrap />
                {/* Site-wide anime hover preview. One delegated listener +
                    one portal for every card on the page — see
                    lib/preview/anchor.ts for how a card opts in. */}
                <HoverPreviewProvider />
                {/* App-shell fade-in only (CSS keyframe, see globals.css). We
                    deliberately do NOT use an enter/exit transition here: on
                    browser back/forward (popstate) the exit animation could
                    stall and leave the new page pinned at opacity:0 — content
                    "didn't load" until you navigated again. A plain 0→1 fade
                    has no exit phase to get stuck on, so back/forward always
                    paints. */}
                <div className="as-fade-in z-50 w-full">
                  <NextNProgress
                    color={BRAND.primary}
                    startPosition={0.3}
                    stopDelayMs={200}
                    height={3}
                    showOnShallow={true}
                  />

                  <SearchPaletteMount />
                  <Component {...pageProps} />
                  {/* Vercel Web Analytics — free, beacon-based, doesn't count
                      against the Hobby function quota and gives us per-page
                      visitor stats on the Vercel dashboard. Replaces / lives
                      alongside our own /api/v2/track (which is the only
                      analytics that sees the visitor IP for moderation). */}
                  <Analytics />
                </div>
              </SkeletonTheme>
          </WatchPageProvider>
        </SearchProvider>
        </I18nProvider>
      </SessionProvider>
    </>
  );
}
