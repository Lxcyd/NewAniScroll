import { useEffect, useRef } from "react";
import { notify } from "@/lib/notifications/noticeStore";
import { useTranslation } from "react-i18next";

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

// Stays on the Vercel route (NOT offloaded to the Worker): AniList 403s requests
// from Cloudflare Worker egress IPs, so the probe must run from Vercel's IP. The
// cost is negligible — the route is Redis-cached (60s) and this poll is gated to
// the visible tab below, so it's only a few seconds of CPU per day. The
// per-connection SSE drain (the real CPU problem) was the thing worth moving.
const HEALTH_URL = "/api/v2/anilist-health";

export default function AnilistHealthBanner() {
  const { t } = useTranslation();
  // Track which kind of toast (if any) is currently shown so we can swap
  // it cleanly when the failure cause changes (e.g. user comes back online
  // but the server still reports AniList down).
  const shownRef = useRef<null | "anilist" | "network">(null);

  useEffect(() => {
    let cancelled = false;

    const dismiss = () => {
      if (shownRef.current) {
        notify.dismiss(TOAST_ID);
        shownRef.current = null;
      }
    };

    const showAnilistDown = (message: string | null) => {
      if (shownRef.current === "anilist") return;
      notify.error(t("health.anilistDown"), {
        id: TOAST_ID,
        description:
          (message ? `${message}. ` : "") + t("health.anilistDownDesc"),
        duration: Infinity,
      });
      shownRef.current = "anilist";
    };

    const showNetworkIssue = () => {
      if (shownRef.current === "network") return;
      notify.error(t("health.connectionIssue"), {
        id: TOAST_ID,
        description: t("health.connectionIssueDesc"),
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
        res = await fetch(HEALTH_URL, {
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

    // On-focus gating: only poll while the tab is VISIBLE. A backgrounded tab
    // doesn't need to keep checking AniList health — we stop the timer when
    // hidden and re-check on return so a recovery/outage surfaces promptly.
    let id: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => {
      if (id == null) id = setInterval(check, POLL_MS);
    };
    const stopPolling = () => {
      if (id != null) {
        clearInterval(id);
        id = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        check();
        startPolling();
      } else {
        stopPolling();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    check();
    if (typeof document === "undefined" || document.visibilityState === "visible") {
      startPolling();
    }

    // Re-check immediately when the browser tells us we're back online —
    // the next scheduled poll could be up to 5 min away, which feels broken
    // when the user just fixed their wifi.
    const onOnline = () => check();
    const onOffline = () => {
      if (!cancelled) showNetworkIssue();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      cancelled = true;
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [t]);

  return null;
}
