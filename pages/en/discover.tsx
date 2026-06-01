import { useEffect, useState, useCallback, useRef } from "react";
import Head from "next/head";
import { useSession, signIn } from "next-auth/react";
import { toast } from "sonner";
import { XMarkIcon, BookmarkIcon, ArrowPathIcon } from "@heroicons/react/24/solid";
import { Navbar } from "@/components/shared/NavBar";
import SwipeCard, { SwipeAnime } from "@/components/discover/SwipeCard";
import { useTranslation } from "react-i18next";

/* The page fetch is now served by /api/v2/discover/<page> (Redis-cached
   server-side) so concurrent visitors share one upstream AniList call. */

// Map swipe direction → AniList list status
// Right = "PLANNING" (add to plan-to-watch); Left = dismiss (no list change, just skip)
async function addToAniListPlanning(mediaId: number, token: string) {
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      query: `mutation ($mediaId: Int) { SaveMediaListEntry(mediaId: $mediaId, status: PLANNING) { id status } }`,
      variables: { mediaId },
    }),
  });
  if (!res.ok) throw new Error(`AniList mutation failed: ${res.status}`);
  return res.json();
}

export default function Discover() {
  const { t } = useTranslation();
  const { data: session }: any = useSession();
  const [queue, setQueue] = useState<SwipeAnime[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const seenIds = useRef<Set<number>>(new Set());

  const loadPage = useCallback(async (pageNum: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/v2/discover/${pageNum}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const media: SwipeAnime[] = json?.media || [];
      const fresh = media.filter((m) => !seenIds.current.has(m.id));
      fresh.forEach((m) => seenIds.current.add(m.id));
      setQueue((prev) => [...prev, ...fresh]);
    } catch (e: any) {
      console.error(e);
      toast.error(t("discover.failedToLoad"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // Initial load
  useEffect(() => {
    loadPage(1);
  }, [loadPage]);

  // Auto-load more when queue gets short
  useEffect(() => {
    if (queue.length <= 3 && !loading) {
      setPage((p) => {
        const next = p + 1;
        loadPage(next);
        return next;
      });
    }
  }, [queue.length, loading, loadPage]);

  const handleSwipe = useCallback(
    async (direction: "left" | "right") => {
      const top = queue[0];
      if (!top) return;

      // Remove from visible stack
      setQueue((q) => q.slice(1));

      if (direction === "right") {
        // Add to AniList Planning if logged in
        if (session?.user?.token) {
          try {
            await addToAniListPlanning(top.id, session.user.token);
            toast.success(t("discover.addedToPlanning", { title: top.title?.english || top.title?.romaji }));
          } catch {
            toast.error(t("discover.couldntSave"));
          }
        } else {
          // Not signed in — save locally so the choice isn't lost
          try {
            const key = "discover_planning";
            const current = JSON.parse(localStorage.getItem(key) || "[]");
            if (!current.includes(top.id)) {
              current.push(top.id);
              localStorage.setItem(key, JSON.stringify(current));
            }
            toast(t("discover.savedLocally"));
          } catch {}
        }
      }
    },
    [queue, session, t]
  );

  // Action button handlers (same logic as swipe)
  const pass = () => handleSwipe("left");
  const plan = () => handleSwipe("right");

  const top = queue[0];
  const next = queue[1];

  return (
    <>
      <Head>
        <title>Discover — AniScroll</title>
        <meta name="description" content="Swipe through trending anime and build your Planning list." />
      </Head>

      <Navbar scrollP={20} withNav={true} shrink={true} paddingY="py-2 lg:py-4" />

      <main
        className="flex min-h-screen flex-col items-center justify-center bg-as-bg px-4 pb-28 pt-20 md:pt-28"
        style={{ paddingBottom: "calc(7rem + env(safe-area-inset-bottom))" }}
      >
        {!session && (
          <div className="mb-4 max-w-md rounded-card bg-as-card/70 p-3 text-center font-karla text-xs text-white/70 ring-1 ring-white/5">
            <button
              type="button"
              onClick={() => signIn("AniListProvider")}
              className="font-bold text-as-accent hover:underline"
            >
              {t("nav.signInWithAniList")}
            </button>{" "}
            {t("discover.signInHint")}
          </div>
        )}

        {/* Card stack */}
        <div className="relative flex h-[600px] w-full max-w-md items-center justify-center">
          {queue.length === 0 && !loading && (
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="text-white/70 font-karla">{t("discover.noMore")}</div>
              <button
                type="button"
                onClick={() => {
                  seenIds.current.clear();
                  setPage(1);
                  setQueue([]);
                  loadPage(1);
                }}
                className="inline-flex items-center gap-2 rounded-pill bg-as-accent px-4 py-2 text-sm font-karla font-bold text-white shadow-glow"
              >
                <ArrowPathIcon className="h-4 w-4" />
                {t("discover.reload")}
              </button>
            </div>
          )}

          {queue.length > 0 && loading && queue.length < 2 && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="h-10 w-10 animate-spin rounded-full border-2 border-as-accent border-t-transparent" />
            </div>
          )}

          {/* Render TOP two cards (top on top, next underneath) */}
          {next && <SwipeCard key={`n-${next.id}`} anime={next} isTop={false} onSwipe={() => {}} />}
          {top && <SwipeCard key={`t-${top.id}`} anime={top} isTop={true} onSwipe={handleSwipe} />}
        </div>

        {/* Action buttons under the card */}
        {top && (
          <div className="mt-6 flex items-center gap-6">
            <button
              type="button"
              onClick={pass}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-as-card ring-2 ring-as-dropped/60 transition-transform hover:scale-110"
              aria-label={t("discover.pass")}
            >
              <XMarkIcon className="h-7 w-7 text-as-dropped" />
            </button>
            <button
              type="button"
              onClick={plan}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-as-card ring-2 ring-as-watching/60 transition-transform hover:scale-110"
              aria-label={t("discover.addToPlanning")}
            >
              <BookmarkIcon className="h-7 w-7 text-as-watching" />
            </button>
          </div>
        )}

        <div className="mt-4 font-karla text-[11px] text-white/40">
          {t("discover.swipeHint")}
        </div>
      </main>
    </>
  );
}
