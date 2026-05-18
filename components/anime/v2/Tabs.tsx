import { CSSProperties, useEffect, useState } from "react";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import Overview from "./Overview";
import Episodes from "./Episodes";
import CharactersTab from "./CharactersTab";
import Artworks from "./Artworks";
import { FanartResponse, collectArtworks } from "./helpers";

type TabId = "overview" | "episodes" | "characters" | "artworks";
const VALID_TABS: TabId[] = ["overview", "episodes", "characters", "artworks"];

type Props = {
  info: AniListInfoTypes;
  fanarts: FanartResponse | null;
  progress: number;
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

export default function Tabs({ info, fanarts, progress }: Props) {
  const [tab, setTab] = useState<TabId>("overview");

  // Restore tab from hash on mount + listen to hashchange (back/forward).
  // We can't use the hash as the initial useState value because SSR has
  // no window — that would cause a hydration mismatch.
  useEffect(() => {
    const sync = () => setTab(readTabFromHash());
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  function switchTab(next: TabId) {
    setTab(next);
    if (typeof window === "undefined") return;
    // overview is the default → keep the URL clean (no #overview).
    const newHash = next === "overview" ? "" : `#${next}`;
    const url = window.location.pathname + window.location.search + newHash;
    // replaceState (not pushState) so hammering tabs doesn't pollute
    // the back stack with one entry per click.
    window.history.replaceState(null, "", url);
  }

  const tabs: Array<{ id: TabId; label: string; count: number | null }> = [
    { id: "overview", label: "Overview", count: null },
    {
      id: "episodes",
      label: "Episodes",
      count: info.episodes ?? null,
    },
    {
      id: "characters",
      label: "Characters",
      count: info.characters?.edges?.length ?? null,
    },
    {
      id: "artworks",
      label: "Artworks",
      count: collectArtworks(fanarts).length || null,
    },
  ];

  return (
    <div style={tStyles.wrap}>
      <div style={tStyles.tabBar}>
        {tabs.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => switchTab(t.id)}
              style={{
                ...tStyles.tab,
                color: active ? "var(--txt-0)" : "var(--txt-2)",
                borderColor: active ? "var(--accent)" : "transparent",
              }}
            >
              {t.label}
              {t.count != null && (
                <span
                  className="mono"
                  style={{
                    ...tStyles.tabCount,
                    background: active ? "var(--accent-soft)" : "var(--bg-3)",
                    color: active ? "#ff7a91" : "var(--txt-3)",
                  }}
                >
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div>
        {tab === "overview" && <Overview info={info} />}
        {tab === "episodes" && <Episodes info={info} progress={progress} />}
        {tab === "characters" && <CharactersTab info={info} />}
        {tab === "artworks" && (
          <Artworks
            fanarts={fanarts}
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
