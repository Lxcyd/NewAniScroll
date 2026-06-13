import "../styles/globals.css";
import "react-loading-skeleton/dist/skeleton.css";
import Script from "next/script";
import { useRouter } from "next/router";
import { motion as m } from "framer-motion";
import NextNProgress from "nextjs-progressbar";
import { SessionProvider } from "next-auth/react";
import { SkeletonTheme } from "react-loading-skeleton";
import SearchPalette from "@/components/searchPalette";
import { SearchProvider } from "@/lib/context/isOpenState";
import { WatchPageProvider } from "@/lib/context/watchPageProvider";
import I18nProvider from "@/lib/i18n/I18nProvider";
import { useEffect } from "react";
import { unixTimestampToRelativeTime } from "@/utils/getTimes";
import { asCssVars, BRAND } from "@/lib/theme";
// import SecretPage from "@/components/secret";
import { Toaster, toast } from "sonner";
import ChangeLogs from "../components/shared/changelogs";
import AnilistHealthBanner from "../components/shared/AnilistHealthBanner";
import { Analytics } from "@vercel/analytics/react";
import { runAutoPauseSweep } from "@/lib/list/syncEngine";
import type { AppProps } from "next/app";

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
        fetch("/api/v2/track", {
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
        const res = await fetch("/api/v2/admin/broadcast", {
          method: "GET",
          // Let the browser honour the server's Cache-Control header
          // (s-maxage=60). Setting "no-store" here was forcing a network
          // round-trip on every page load even when the response was
          // identical to one we'd just received.
          headers: {
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
        toast.message(heading, {
          id: "global-broadcast",
          position: "bottom-right",
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
    // an admin announcement banner and cuts this endpoint's edge-requests /
    // invocations ~10x per open tab (it was the busiest client poll). The
    // toast carries a fixed id so repeated polls update in place instead of
    // stacking, and any active broadcast still shows immediately on load.
    const interval = setInterval(getBroadcast, 300_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Auto-pause sweep: once per app load, move long-untouched CURRENT entries to
  // PAUSED (local list + AniList push when sync is enabled). No-op unless the
  // user turned on auto-pause in Settings. Deferred to idle so it never blocks
  // first paint, and best-effort (failures are swallowed inside the engine).
  useEffect(() => {
    const run = () => runAutoPauseSweep().catch(() => {});
    const ric = (window as any).requestIdleCallback;
    if (typeof ric === "function") {
      const id = ric(run, { timeout: 4000 });
      return () => (window as any).cancelIdleCallback?.(id);
    }
    const tid = setTimeout(run, 2000);
    return () => clearTimeout(tid);
  }, []);

  const handleCheatCodeEntered = () => {
    alert("Cheat code entered!"); // You can replace this with your desired action
  };

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
                <Toaster richColors theme="dark" closeButton />
                {/* <SecretPage
                  cheatCode={"aofienaef"}
                  onCheatCodeEntered={handleCheatCodeEntered}
                /> */}
                <ChangeLogs />
                <AnilistHealthBanner />
                {/* Per-route fade-in only. We deliberately do NOT use
                    <AnimatePresence mode="wait"> here: on browser back/forward
                    (popstate) the exit animation could stall and leave the new
                    page pinned at opacity:0 — content "didn't load" until you
                    navigated again. A keyless mount that simply animates from
                    0→1 opacity on each render has no exit phase to get stuck on,
                    so back/forward always paints. */}
                <m.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3 }}
                  className="z-50 w-full"
                >
                  <NextNProgress
                    color={BRAND.primary}
                    startPosition={0.3}
                    stopDelayMs={200}
                    height={3}
                    showOnShallow={true}
                  />

                  <SearchPalette />
                  <Component {...pageProps} />
                  {/* Vercel Web Analytics — free, beacon-based, doesn't count
                      against the Hobby function quota and gives us per-page
                      visitor stats on the Vercel dashboard. Replaces / lives
                      alongside our own /api/v2/track (which is the only
                      analytics that sees the visitor IP for moderation). */}
                  <Analytics />
                </m.div>
              </SkeletonTheme>
          </WatchPageProvider>
        </SearchProvider>
        </I18nProvider>
      </SessionProvider>
    </>
  );
}
