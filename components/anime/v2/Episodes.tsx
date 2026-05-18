import { CSSProperties, useEffect, useState } from "react";
import Link from "next/link";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";

type EpisodeRow = {
  number: number;
  id: string;
  title: string;
  duration: number | null;
};

type Props = {
  info: AniListInfoTypes;
  progress: number;
};

export default function Episodes({ info, progress }: Props) {
  const [eps, setEps] = useState<EpisodeRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDub, setIsDub] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(
      `/api/v2/episode/${info.id}?releasing=${
        info.status === "RELEASING" ? "true" : "false"
      }${isDub ? "&dub=true" : ""}`
    )
      .then((r) => r.json())
      .then((data: any[]) => {
        if (cancelled) return;
        const provider = (data || []).find((p) => p?.providerId === "megaplay") || data?.[0];
        const list: EpisodeRow[] = (provider?.episodes || []).map((e: any) => ({
          number: e.number,
          id: e.id,
          title: e.title || `Episode ${e.number}`,
          duration: info.duration ?? null,
        }));
        setEps(list);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e?.message || "Failed to load episodes");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [info.id, info.status, info.duration, isDub]);

  return (
    <div>
      {/* Header row */}
      <div style={tStyles.seasonRow}>
        <div style={tStyles.seasonTabs}>
          <div
            style={{
              ...tStyles.seasonTab,
              background: "var(--bg-3)",
              borderColor: "var(--line-2)",
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 1,
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--txt-0)" }}>
                {info.title.english || info.title.romaji}
              </span>
              <span style={{ fontSize: 10.5, color: "var(--txt-3)" }}>
                {info.status === "RELEASING" ? "Airing" : "Completed"}
                {info.seasonYear ? ` · ${info.seasonYear}` : ""}
              </span>
            </div>
            <span className="mono" style={tStyles.seasonCount}>
              {info.episodes
                ? `${info.episodes} EP`
                : eps
                ? `${eps.length} EP`
                : "— EP"}
              {info.duration ? ` · ${info.duration}min` : ""}
            </span>
          </div>
        </div>
        <div style={tStyles.epActions}>
          <button
            style={{
              ...tStyles.smallBtn,
              background: isDub ? "var(--accent-soft)" : "var(--bg-2)",
              color: isDub ? "var(--accent)" : "var(--txt-1)",
              borderColor: isDub ? "rgba(255,59,92,0.3)" : "var(--line)",
            }}
            onClick={() => setIsDub((b) => !b)}
          >
            {isDub ? "Dub" : "Sub"}
          </button>
        </div>
      </div>

      {/* Episode list */}
      {loading && <SkeletonList />}
      {error && (
        <div
          style={{
            padding: 16,
            background: "var(--bg-2)",
            border: "1px solid var(--line)",
            borderRadius: 10,
            color: "var(--txt-2)",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}
      {!loading && !error && eps && eps.length === 0 && (
        <div
          style={{
            padding: 16,
            background: "var(--bg-2)",
            border: "1px solid var(--line)",
            borderRadius: 10,
            color: "var(--txt-3)",
            fontSize: 13,
          }}
        >
          No episodes available yet.
        </div>
      )}
      {!loading && !error && eps && eps.length > 0 && (
        <div style={tStyles.epList}>
          {eps.map((ep) => {
            const watched = progress >= ep.number;
            const current = progress === ep.number - 1;
            const aired =
              info.nextAiringEpisode?.episode != null &&
              ep.number >= info.nextAiringEpisode.episode;
            const locked = aired;
            const href = `/en/anime/watch/${info.id}/megaplay?id=${ep.id}&num=${ep.number}${
              isDub ? "&dub=true" : ""
            }`;
            return (
              <Link
                key={ep.number}
                href={locked ? "#" : href}
                style={{
                  ...tStyles.epRow,
                  opacity: locked ? 0.55 : 1,
                  borderColor: current
                    ? "rgba(255,59,92,0.4)"
                    : "var(--line)",
                  background: current
                    ? "linear-gradient(90deg, rgba(255,59,92,0.06), var(--bg-2))"
                    : "var(--bg-2)",
                  textDecoration: "none",
                  color: "inherit",
                  pointerEvents: locked ? "none" : "auto",
                }}
              >
                <div style={tStyles.epThumb}>
                  <div
                    style={{
                      ...tStyles.epThumbBg,
                      background: `linear-gradient(135deg, hsl(${
                        (ep.number * 30) % 360
                      }, 30%, 18%), hsl(${(ep.number * 30 + 40) % 360}, 40%, 28%))`,
                    }}
                  />
                  <span className="mono" style={tStyles.epThumbN}>
                    {String(ep.number).padStart(2, "0")}
                  </span>
                  {current && (
                    <div style={tStyles.epPlayOverlay}>
                      <div style={tStyles.epPlayBtn}>
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="white"
                        >
                          <polygon points="5 3 19 12 5 21" />
                        </svg>
                      </div>
                    </div>
                  )}
                  {locked && (
                    <div style={tStyles.epLockOverlay}>
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <rect x="3" y="11" width="18" height="11" rx="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                    </div>
                  )}
                </div>
                <div style={tStyles.epInfo}>
                  <div style={tStyles.epHead}>
                    <span className="mono" style={tStyles.epNum}>
                      EP {String(ep.number).padStart(2, "0")}
                    </span>
                    {watched && (
                      <span style={tStyles.watchedTag}>✓ Watched</span>
                    )}
                    {current && (
                      <span style={tStyles.currentTag}>● Up next</span>
                    )}
                  </div>
                  <div style={tStyles.epTitle}>{ep.title}</div>
                  <div style={tStyles.epMeta}>
                    {ep.duration && <span>{ep.duration} min</span>}
                    {ep.duration && <span style={tStyles.dotSep} />}
                    <span>{isDub ? "Dub" : "Sub"}</span>
                  </div>
                </div>
                <span
                  style={{
                    ...tStyles.epPlay,
                    pointerEvents: "none",
                  }}
                >
                  {locked ? "Locked" : current ? "Resume" : watched ? "Replay" : "Play"}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SkeletonList() {
  return (
    <div style={tStyles.epList}>
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          style={{
            ...tStyles.epRow,
            borderColor: "var(--line)",
            background: "var(--bg-2)",
          }}
        >
          <div
            style={{
              ...tStyles.epThumb,
              background: "var(--bg-3)",
            }}
          />
          <div style={{ ...tStyles.epInfo, gap: 8 }}>
            <div
              style={{
                width: 80,
                height: 11,
                background: "var(--bg-3)",
                borderRadius: 4,
              }}
            />
            <div
              style={{
                width: "60%",
                height: 14,
                background: "var(--bg-3)",
                borderRadius: 4,
              }}
            />
            <div
              style={{
                width: 120,
                height: 11,
                background: "var(--bg-3)",
                borderRadius: 4,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

const tStyles: Record<string, CSSProperties> = {
  seasonRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 14,
    flexWrap: "wrap",
  },
  seasonTabs: {
    display: "flex",
    gap: 6,
    padding: 4,
    background: "var(--bg-2)",
    border: "1px solid var(--line)",
    borderRadius: 10,
  },
  seasonTab: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "8px 12px",
    border: "1px solid",
    borderRadius: 7,
    transition: "all 0.15s",
  },
  seasonCount: {
    fontSize: 10,
    color: "var(--txt-3)",
    letterSpacing: "0.05em",
    padding: "2px 6px",
    background: "var(--bg-0)",
    borderRadius: 4,
  },
  epActions: { display: "flex", gap: 6 },
  smallBtn: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 12px",
    fontSize: 12,
    color: "var(--txt-1)",
    background: "var(--bg-2)",
    border: "1px solid var(--line)",
    borderRadius: 8,
    cursor: "pointer",
  },
  epList: { display: "flex", flexDirection: "column", gap: 8 },
  epRow: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    padding: 10,
    border: "1px solid",
    borderRadius: 10,
    transition: "all 0.15s",
  },
  epThumb: {
    position: "relative",
    width: 124,
    height: 70,
    borderRadius: 7,
    overflow: "hidden",
    flexShrink: 0,
  },
  epThumbBg: { position: "absolute", inset: 0 },
  epThumbN: {
    position: "absolute",
    bottom: 6,
    left: 8,
    fontSize: 16,
    fontWeight: 700,
    color: "rgba(255,255,255,0.85)",
  },
  epPlayOverlay: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    background: "rgba(0,0,0,0.4)",
  },
  epPlayBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    background: "rgba(255,59,92,0.9)",
    display: "grid",
    placeItems: "center",
    paddingLeft: 2,
  },
  epLockOverlay: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    background: "rgba(0,0,0,0.5)",
    color: "var(--txt-3)",
  },
  epInfo: { flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
  epHead: { display: "flex", alignItems: "center", gap: 8 },
  epNum: { fontSize: 10.5, color: "var(--txt-3)", letterSpacing: "0.08em" },
  watchedTag: {
    fontSize: 9.5,
    fontWeight: 600,
    color: "#2dd47a",
    padding: "2px 6px",
    background: "rgba(45,212,122,0.1)",
    borderRadius: 3,
    letterSpacing: "0.04em",
  },
  currentTag: {
    fontSize: 9.5,
    fontWeight: 600,
    color: "var(--accent)",
    padding: "2px 6px",
    background: "var(--accent-soft)",
    borderRadius: 3,
    letterSpacing: "0.04em",
  },
  epTitle: { fontSize: 14, fontWeight: 600, color: "var(--txt-0)" },
  epMeta: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 11.5,
    color: "var(--txt-3)",
  },
  dotSep: { width: 3, height: 3, borderRadius: 2, background: "var(--txt-3)" },
  epPlay: {
    padding: "8px 16px",
    background: "var(--bg-3)",
    border: "1px solid var(--line-2)",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 600,
    color: "var(--txt-0)",
  },
};
