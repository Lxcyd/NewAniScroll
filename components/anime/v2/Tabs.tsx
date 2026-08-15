import { CSSProperties, useEffect, useState } from "react";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import Overview from "./Overview";
import Episodes from "./Episodes";
import CharactersTab from "./CharactersTab";
import Artworks from "./Artworks";
import ScoresTab from "./ScoresTab";
import type { FanartsMeta } from "./helpers";
import type { SeasonEntry } from "@/lib/anilist/seasonChain";
import type { FilmVariant } from "@/lib/anilist/resolveSeason";
import { useTranslation } from "react-i18next";
import { replaceUrlPreservingState } from "@/lib/navigation/replaceUrl";

type TabId = "overview" | "episodes" | "scores" | "characters" | "artworks";
const VALID_TABS: TabId[] = ["overview", "episodes", "scores", "characters", "artworks"];

type Props = {
  info: AniListInfoTypes;
  /* Counts only — see FanartsMeta. The rows live behind useFanarts and are
     fetched by whichever tab body needs them, i.e. on click. */
  fanartsMeta: FanartsMeta | null;
  progress: number;
  seasonList?: SeasonEntry[];
  bonusFilms?: FilmVariant[];
};

/* Persist the active tab in `location.hash` so:
   1. reloading the page restores the tab the user was on (the SSR
      hydrates with "overview", then this effect re-syncs on mount)
   2. the tab is shareable via URL
   3. the browser back/forward buttons move between tabs */
function readTabFromHash(): TabId {
  if (typeof window === "undefined") return "overview";
  const h = window.location.hash.replace(/^#/, "") as TabId;
  return VALID_TABS.indexOf(h) >= 0 ? h : "overview";
}

export default function Tabs({ info, fanartsMeta, progress, seasonList, bonusFilms }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabId>("overview");
  // Real loaded episode count reported by <Episodes>. AniList's info.episodes is
  // null for long-running airing shows (One Piece), which left the "Épisodes"
  // tab with no badge; the fetched list length fills that in.
  const [episodeCount, setEpisodeCount] = useState<number | null>(null);
  // Reset when navigating to another anime (client-side nav keeps this mounted).
  useEffect(() => setEpisodeCount(null), [info.id]);

  // Restore tab from hash on mount + on hashchange AND popstate (back/forward).
  // hashchange fires when the hash itself changes, but a back/forward that lands
  // on the same hash — or swaps to a different anime page on the same [...id]
  // route — only emits popstate, so we sync on both. We also re-sync whenever
  // the route's id changes (client-side nav between anime keeps this component
  // mounted, so the hash from the previous anime must be re-read). We can't seed
  // useState from the hash (SSR has no window → hydration mismatch).
  useEffect(() => {
    const sync = () => setTab(readTabFromHash());
    sync();
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, [info.id]);

  // NOTE: this used to idle-prefetch /api/v2/episode-scores on every info-page
  // load so the Scores tab felt instant on click. Removed deliberately: it fired
  // for EVERY visitor, but only the small fraction who actually open Scores ever
  // used the result. On Vercel a request is billed as an Edge Request whether it
  // HITs the CDN or not, so a speculative warm-up is never free — and Edge
  // Requests are the account's highest-consumption meter. The tab now fetches on
  // activation, like every other section here (each tab body below is only
  // mounted once its tab is selected, so episodes / characters / artworks
  // already behave this way).
  function switchTab(next: TabId) {
    setTab(next);
    if (typeof window === "undefined") return;
    // overview is the default → keep the URL clean (no #overview).
    const newHash = next === "overview" ? "" : `#${next}`;
    const url = window.location.pathname + window.location.search + newHash;
    // replaceState (not pushState) so hammering tabs doesn't pollute the back
    // stack — routed through the helper so Next's history state survives and
    // back/forward into this entry still re-renders the page.
    replaceUrlPreservingState(url);
  }

  const tabs: Array<{ id: TabId; label: string; count: number | null }> = [
    { id: "overview", label: t("anime.overview"), count: null },
    {
      id: "episodes",
      label: t("anime.episodes"),
      // Prefer the real fetched count (fills in for airing shows AniList
      // reports no episode count for). Before the Episodes tab has loaded, fall
      // back to AniList's metadata, then to the already-aired count derived from
      // nextAiringEpisode so a long-running airing show still shows a badge.
      count:
        episodeCount ??
        info.episodes ??
        (info.nextAiringEpisode?.episode
          ? info.nextAiringEpisode.episode - 1
          : null),
    },
    {
      id: "scores",
      label: t("anime.scores"),
      count: null,
    },
    {
      id: "characters",
      label: t("anime.characters"),
      /* `characters` is no longer in the SSR payload; the SSR replaced it with
         this count so the badge is right on first paint. Falls back to the live
         array for any caller that still passes the full object. */
      count:
        (info as any).charactersCount ?? info.characters?.edges?.length ?? null,
    },
    {
      id: "artworks",
      label: t("anime.artworks"),
      count: fanartsMeta?.artworkCount || null,
    },
  ];

  return (
    <div style={tStyles.wrap}>
      <div style={tStyles.tabBar}>
        {tabs.map((tb) => {
          const active = tab === tb.id;
          return (
            <button
              key={tb.id}
              onClick={() => switchTab(tb.id)}
              style={{
                ...tStyles.tab,
                color: active ? "var(--txt-0)" : "var(--txt-2)",
                borderColor: active ? "var(--accent)" : "transparent",
              }}
            >
              {tb.label}
              {tb.count != null && (
                <span
                  className="mono"
                  style={{
                    ...tStyles.tabCount,
                    background: active ? "var(--accent-soft)" : "var(--bg-3)",
                    color: active ? "var(--accent)" : "var(--txt-3)",
                  }}
                >
                  {tb.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div>
        {tab === "overview" && (
          <Overview info={info} />
        )}
        {tab === "episodes" && (
          <Episodes
            info={info}
            progress={progress}
            seasonList={seasonList}
            bonusFilms={bonusFilms}
            onEpisodeCount={setEpisodeCount}
          />
        )}
        {tab === "scores" && (
          <ScoresTab info={info} seasonList={seasonList} />
        )}
        {tab === "characters" && <CharactersTab info={info} />}
        {tab === "artworks" && (
          <Artworks
            animeId={info.id}
            coverFallback={info.coverImage?.extraLarge || info.coverImage?.large}
            bannerFallback={info.bannerImage}
          />
        )}
      </div>
    </div>
  );
}

const tStyles: Record<string, CSSProperties> = {
  wrap: { display: "flex", flexDirection: "column", gap: 0 },
  tabBar: {
    display: "flex",
    gap: 4,
    borderBottom: "1px solid var(--line)",
    marginBottom: 18,
    overflowX: "auto",
  },
  tab: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "12px 14px",
    fontSize: 13.5,
    fontWeight: 600,
    borderBottom: "2px solid",
    transition: "all 0.15s",
    whiteSpace: "nowrap",
    background: "transparent",
    cursor: "pointer",
  },
  tabCount: {
    fontSize: 10.5,
    fontWeight: 600,
    padding: "1px 6px",
    borderRadius: 4,
  },
};
