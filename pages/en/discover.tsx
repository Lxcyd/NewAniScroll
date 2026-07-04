import { useEffect, useState, useCallback, useRef } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { Cog6ToothIcon, SparklesIcon } from "@heroicons/react/24/solid";
import { useTranslation } from "react-i18next";
import { Navbar } from "@/components/shared/NavBar";
import ScrollCard, { ScrollAnime } from "@/components/discover/ScrollCard";
import ScrollerSettingsPanel from "@/components/discover/ScrollerSettingsPanel";
import ForYouPanel from "@/components/discover/ForYouPanel";
import { useCardDrag, DragEndInfo } from "@/components/discover/useCardDrag";
import { saveMediaListEntry } from "@/lib/list/anilistPush";
import { prefetchTranslations } from "@/lib/i18n/useTranslatedText";
import { animeHref, useClickTarget } from "@/lib/prefs/clickTarget";
import {
  SwipeSettings,
  loadSwipeSettings,
  saveSwipeSettings,
  STATUS_LABEL_KEY,
} from "@/lib/discover/swipeSettings";
import styles from "@/components/discover/scroll.module.css";

/* The page fetch is served by /api/v2/discover/<page> (Redis-cached
   server-side) so concurrent visitors share one upstream AniList call. */

// Only render cards within ±RENDER_WINDOW of the current index.
const RENDER_WINDOW = 5;
// Pull the next page when the current index gets within this many of the end.
const PRELOAD_THRESHOLD = 6;

export default function Discover() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const { data: session }: any = useSession();
  const clickTarget = useClickTarget();

  const [animes, setAnimes] = useState<ScrollAnime[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [cardHeight, setCardHeight] = useState(800);
  const [showSettings, setShowSettings] = useState(false);
  const [showForYou, setShowForYou] = useState(false);
  const [settings, setSettings] = useState<SwipeSettings>(() => loadSwipeSettings());
  // anime id → status it was just swiped into, so a card scrolled back to can
  // show an "Undo" badge and we can revert the AniList entry.
  const [swiped, setSwiped] = useState<Record<number, import("@/lib/list/types").Status>>({});

  const seenIds = useRef<Set<number>>(new Set());
  // anime id → AniList mediaListEntry id, needed to DeleteMediaListEntry on undo.
  const entryIds = useRef<Record<number, number>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  // Keep a live ref of state the drag callback reads without re-subscribing.
  const idxRef = useRef(currentIndex);
  idxRef.current = currentIndex;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // ── Viewport height drives card height (re-measured on resize) ──
  useEffect(() => {
    const measure = () => setCardHeight(window.innerHeight);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // ── Data loading ──
  const loadPage = useCallback(
    async (pageNum: number) => {
      setLoading(true);
      try {
        const res = await fetch(`/api/v2/discover/${pageNum}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const media: ScrollAnime[] = json?.media || [];
        const fresh = media.filter((m) => !seenIds.current.has(m.id));
        fresh.forEach((m) => seenIds.current.add(m.id));
        setAnimes((prev) => [...prev, ...fresh]);
        // Warm the translation cache for these synopses so they render in the
        // active language with no English flash by the time the user swipes to
        // them (no-op when the UI language is English).
        prefetchTranslations(
          fresh.map((m) => m.description?.replace(/<[^>]+>/g, "")),
          i18n.language || "en"
        );
      } catch (e) {
        console.error(e);
        toast.error(t("discover.failedToLoad"));
      } finally {
        setLoading(false);
      }
    },
    [t, i18n.language]
  );

  useEffect(() => {
    loadPage(1);
  }, [loadPage]);

  // Preload the next page as the user nears the end of the loaded set.
  useEffect(() => {
    if (loading) return;
    if (currentIndex >= animes.length - PRELOAD_THRESHOLD && animes.length > 0) {
      setPage((p) => {
        const next = p + 1;
        loadPage(next);
        return next;
      });
    }
  }, [currentIndex, animes.length, loading, loadPage]);

  // ── Undo a swipe: delete the AniList entry (or drop the local record) ──
  const undoSwipe = useCallback(
    async (anime: ScrollAnime) => {
      // Clear the badge optimistically.
      setSwiped((prev) => {
        const next = { ...prev };
        delete next[anime.id];
        return next;
      });

      if (session?.user?.token) {
        const entryId = entryIds.current[anime.id];
        if (entryId) {
          try {
            await fetch("https://graphql.anilist.co/", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${session.user.token}`,
              },
              body: JSON.stringify({
                query: `mutation ($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }`,
                variables: { id: entryId },
              }),
            });
          } catch {
            /* non-fatal */
          }
          delete entryIds.current[anime.id];
        }
      } else {
        try {
          const key = "discover_swipes";
          const cur = JSON.parse(localStorage.getItem(key) || "[]");
          localStorage.setItem(
            key,
            JSON.stringify(cur.filter((e: any) => e.id !== anime.id))
          );
        } catch {
          /* non-fatal */
        }
      }
      toast(t("discover.removed"));
    },
    [session, t]
  );

  // ── List action on horizontal swipe ──
  const applyListAction = useCallback(
    async (anime: ScrollAnime, isRight: boolean) => {
      const status = isRight
        ? settingsRef.current.rightStatus
        : settingsRef.current.leftStatus;
      const label = t(`discover.status.${STATUS_LABEL_KEY[status]}`);

      // Record the swipe so a card scrolled back to shows an Undo badge.
      setSwiped((prev) => ({ ...prev, [anime.id]: status }));

      const undoAction = {
        label: t("discover.undo"),
        onClick: () => undoSwipe(anime),
      };

      if (session?.user?.token) {
        const saved = await saveMediaListEntry(session.user.token, {
          mediaId: anime.id,
          status,
        });
        if (saved) {
          entryIds.current[anime.id] = saved.id;
          toast.success(t("discover.addedTo", { status: label }), {
            action: undoAction,
            className: "discover-toast",
          });
        } else {
          toast.error(t("discover.couldntSave"));
          setSwiped((prev) => {
            const next = { ...prev };
            delete next[anime.id];
            return next;
          });
        }
      } else {
        // Signed out — remember the choice locally so it isn't lost.
        try {
          const key = "discover_swipes";
          const cur = JSON.parse(localStorage.getItem(key) || "[]");
          cur.push({ id: anime.id, status });
          localStorage.setItem(key, JSON.stringify(cur));
        } catch {
          /* non-fatal */
        }
        toast(t("discover.savedLocally"), {
          action: undoAction,
          className: "discover-toast",
        });
      }
    },
    [session, t, undoSwipe]
  );

  // ── Resolve a drag/wheel gesture (ported from Index.razor) ──
  const handleDragEnd = useCallback(
    (info: DragEndInfo) => {
      const idx = idxRef.current;

      if (info.axis === "horizontal") {
        const isRight = info.xOffset > 0;
        applyListAction(animes[idx], isRight);
        // Advance to the next card (no vertical transition — fly-off handled it).
        setCurrentIndex((i) => Math.min(i + 1, animes.length - 1));
        return;
      }

      // Vertical (or wheel): up = next, down = prev. Snap back otherwise.
      const threshold = cardHeight * 0.06;
      setTransitioning(true);
      if (info.yOffset <= -threshold) {
        setCurrentIndex((i) => Math.min(i + 1, animes.length - 1));
      } else if (info.yOffset >= threshold) {
        setCurrentIndex((i) => Math.max(i - 1, 0));
      }
      // Re-paint at base positions; the CSS transition animates the snap.
      window.setTimeout(() => setTransitioning(false), 280);
    },
    [animes, applyListAction, cardHeight]
  );

  useCardDrag({
    containerRef,
    cardHeight,
    onDragEnd: handleDragEnd,
    enabled: !showSettings && animes.length > 0,
  });

  const onSettingsChange = useCallback((s: SwipeSettings) => {
    setSettings(s);
    saveSwipeSettings(s);
  }, []);

  // Honour the "click target" preference (Settings → Browsing): default opens
  // the info page; "watchPage" jumps straight into the player.
  const openDetails = useCallback(
    (anime: ScrollAnime) => router.push(animeHref(anime.id, clickTarget)),
    [router, clickTarget]
  );

  const initialLoading = loading && animes.length === 0;

  return (
    <>
      <Head>
        <title>Discover — AniScroll</title>
        <meta
          name="description"
          content="Scroll and swipe through trending anime to build your AniList."
        />
      </Head>

      <Navbar scrollP={20} withNav={true} />

      <div ref={containerRef} className={styles.app}>
        <div className={styles.mainScroll}>
          {animes.map((anime, index) => {
            const distance = Math.abs(index - currentIndex);
            if (distance > RENDER_WINDOW) return null;
            return (
              <ScrollCard
                key={anime.id}
                anime={anime}
                translateY={(index - currentIndex) * cardHeight}
                cardHeight={cardHeight}
                isActive={index === currentIndex}
                transition={transitioning}
                settings={settings}
                swipedStatus={swiped[anime.id]}
                onUndo={undoSwipe}
                onOpenDetails={openDetails}
              />
            );
          })}

          {initialLoading && (
            <div className={styles.loadingArea}>
              <div className={styles.loadingBox}>
                <div className={styles.spinner} />
                <p className={styles.loadingSubtitle}>{t("discover.loading")}</p>
              </div>
            </div>
          )}
        </div>

        {/* Overlay: For You + settings buttons (top-right) */}
        {animes.length > 0 && (
          <>
            <button
              type="button"
              className={styles.forYouBtn}
              onClick={() => setShowForYou(true)}
              title={t("recommend.title")}
              aria-label={t("recommend.title")}
            >
              <SparklesIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              className={styles.swsetOpenBtn}
              onClick={() => setShowSettings(true)}
              title={t("discover.swipeSettings")}
              aria-label={t("discover.swipeSettings")}
            >
              <Cog6ToothIcon className="h-4 w-4" />
            </button>
          </>
        )}
      </div>

      <ScrollerSettingsPanel
        isVisible={showSettings}
        current={settings}
        onChange={onSettingsChange}
        onClose={() => setShowSettings(false)}
      />

      <ForYouPanel isVisible={showForYou} onClose={() => setShowForYou(false)} />
    </>
  );
}
