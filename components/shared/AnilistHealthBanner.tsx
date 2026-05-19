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
const POLL_MS = 60_000;
const TOAST_ID = "anilist-down";

export default function AnilistHealthBanner() {
  // Track whether the toast is currently shown so we don't re-create
  // it on every poll (sonner deduplicates by id but still triggers a
  // re-render).
  const shownRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const res = await fetch("/api/v2/anilist-health", {
          // Keep this exempt from the SW cache so we never see stale
          // "up" status for minutes after recovery.
          cache: "no-store",
        });
        if (!res.ok) return; // our endpoint itself failed — silent
        const data = (await res.json()) as {
          up: boolean;
          message: string | null;
        };
        if (cancelled) return;

        if (!data.up && !shownRef.current) {
          toast.error("AniList is currently unavailable", {
            id: TOAST_ID,
            description:
              (data.message ? `${data.message}. ` : "") +
              "Some features (search, list updates, fresh metadata) may not work for the moment. Cached data is still being served.",
            duration: Infinity,
            /* The global <Toaster> in _app.tsx is already mounted with
               closeButton enabled, so a manual close button shows up
               here automatically. */
          });
          shownRef.current = true;
        } else if (data.up && shownRef.current) {
          toast.dismiss(TOAST_ID);
          shownRef.current = false;
        }
      } catch {
        // Network errors — don't surface anything; the user already
        // sees other failures if there's a real connectivity issue.
      }
    }

    check();
    const id = setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return null;
}
