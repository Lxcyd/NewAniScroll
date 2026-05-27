import { useEffect, useRef } from "react";
import { toast } from "sonner";

/**
 * AnilistHealthBanner
 *
 * Site-wide watchdog that pings /api/v2/anilist-health on mount and
 * every 60s. When AniList is down, surfaces a persistent toast so the
 * user knows degraded behaviour they're seeing is upstream — not us.
 *
 * - Uses a fixed toast id so repeated checks update the same toast in
 *   place instead of stacking dupes.
 * - Dismisses the toast automatically the moment AniList comes back.
 * - The endpoint itself has a 60s Redis cache so this widget never
 *   adds load to AniList during outages: thousands of concurrent
 *   visitors hit the cached value, not the upstream API.
 */
// AniList outages aren't fleeting — when the API goes down it's usually
// minutes-to-hours, not 30-second blips. Polling every 60 s was overkill
// (121 invocations / 12 h on Vercel for a single banner). 5 min is plenty
// to surface a real outage, and the browser's `online`/`offline` events
// already trigger an immediate re-check when local connectivity changes.
const POLL_MS = 5 * 60_000;
const TOAST_ID = "anilist-down";

export default function AnilistHealthBanner() {
  // Track which kind of toast (if any) is currently shown so we can swap
  // it cleanly when the failure cause changes (e.g. user comes back online
  // but the server still reports AniList down).
  const shownRef = useRef<null | "anilist" | "network">(null);

  useEffect(() => {
    let cancelled = false;

    const dismiss = () => {
      if (shownRef.current) {
        toast.dismiss(TOAST_ID);
        shownRef.current = null;
      }
    };

    const showAnilistDown = (message: string | null) => {
      if (shownRef.current === "anilist") return;
      toast.error("AniList is currently unavailable", {
        id: TOAST_ID,
        description:
          (message ? `${message}. ` : "") +
          "Some features (search, list updates, fresh metadata) may not work for the moment. Cached data is still being served.",
        duration: Infinity,
      });
      shownRef.current = "anilist";
    };

    const showNetworkIssue = () => {
      if (shownRef.current === "network") return;
      toast.error("Connection issue", {
        id: TOAST_ID,
        description:
          "We can't reach the server right now — this looks like a local network problem. Some features may be unavailable until the connection is back.",
        duration: Infinity,
      });
      shownRef.current = "network";
    };

    async function check() {
      // 0. Browser already knows we're offline — no point pinging anything.
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        if (!cancelled) showNetworkIssue();
        return;
      }

      // 1. Bound the request so a hung TCP socket doesn't keep the toast
      //    in limbo. 6 s is well above our server's own 3 s upstream timeout
      //    plus normal RTT, so anything beyond it is a real client-side
      //    connectivity problem — not just AniList being slow.
      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), 6000);
      let res: Response;
      try {
        res = await fetch("/api/v2/anilist-health", {
          // Keep this exempt from the SW cache so we never see stale
          // "up" status for minutes after recovery.
          cache: "no-store",
          signal: ctrl.signal,
        });
      } catch {
        // fetch failed — either we're offline or the server itself is
        // unreachable from this client. Either way, blaming AniList is
        // wrong; show the connection-issue toast instead.
        if (!cancelled) showNetworkIssue();
        return;
      } finally {
        clearTimeout(timeoutId);
      }

      if (!res.ok) {
        // Our endpoint returned 5xx — server is reachable but degraded.
        // Surface as a network issue rather than an AniList outage.
        if (!cancelled) showNetworkIssue();
        return;
      }

      let data: { up: boolean; message: string | null };
      try {
        data = await res.json();
      } catch {
        if (!cancelled) showNetworkIssue();
        return;
      }
      if (cancelled) return;

      if (!data.up) {
        showAnilistDown(data.message);
      } else {
        dismiss();
      }
    }

    check();
    const id = setInterval(check, POLL_MS);

    // Re-check immediately when the browser tells us we're back online —
    // the next scheduled poll could be up to 60 s away, which feels broken
    // when the user just fixed their wifi.
    const onOnline = () => check();
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", () => {
      if (!cancelled) showNetworkIssue();
    });

    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  return null;
}
