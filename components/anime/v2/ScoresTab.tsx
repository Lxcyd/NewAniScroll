import { CSSProperties, useEffect, useMemo, useState } from "react";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import type { SeasonEntry } from "@/lib/anilist/seasonChain";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { useTranslation } from "react-i18next";

/**
 * Per-season / per-episode score grid, styled after the "Screen Score" format
 * (one column per season, one row per episode, cells colour-coded by tier).
 *
 * Data:
 *   - Real per-episode scores come from TMDB via /api/v2/episode-scores
 *     (vote_average /10). Painted whenever TMDB has the episode.
 *   - When TMDB has no key / no match / no rating for an episode, the cell
 *     falls back to that season's AniList averageScore — so the grid is never
 *     empty and degrades gracefully.
 *
 * Adaptive layout:
 *   - ≤ 30 episodes  → full grid (one cell per episode).
 *   - more episodes  → "banded" mode (E1–10, E11–20…) so a 1000-episode show
 *     stays readable. Banded cells use the season average (per-episode detail
 *     isn't meaningful at that zoom).
 */

type Props = {
  info: AniListInfoTypes;
  seasonList?: SeasonEntry[];
};

type Tier = {
  key: string;
  label: string;
  color: string;
  text: string;
  /** Inclusive lower bound on the /10 score. */
  min: number;
};

// Conventional, self-explanatory tiers mapped onto a /10 score. The score
// number is always white for a consistent look across every tier.
const TIERS: Tier[] = [
  { key: "masterpiece", label: "Masterpiece", color: "#2f80ed", text: "#fff", min: 9.0 },
  { key: "great", label: "Great", color: "#1f7a3f", text: "#fff", min: 8.0 },
  { key: "good", label: "Good", color: "#4caf50", text: "#fff", min: 7.0 },
  { key: "average", label: "Average", color: "#e0c000", text: "#fff", min: 6.0 },
  { key: "weak", label: "Weak", color: "#e8862b", text: "#fff", min: 5.0 },
  { key: "poor", label: "Poor", color: "#e0413e", text: "#fff", min: 0 },
];

// Unrated / not-yet-aired episodes: a clearly muted grey cell so it reads as
// "no score" rather than a real rating.
const NA_TIER: Tier = { key: "na", label: "—", color: "#2b2b33", text: "#6b6b78", min: 0 };

function tierFor(score10: number | null): Tier {
  if (score10 == null) return NA_TIER;
  return TIERS.find((tier) => score10 >= tier.min) || TIERS[TIERS.length - 1];
}

/** AniList averageScore (0-100) → /10 with one decimal, or null. */
function toScore10(avg: number | null | undefined): number | null {
  if (avg == null || !Number.isFinite(avg)) return null;
  return Math.round((avg / 10) * 10) / 10;
}

type ApiSeason = {
  aniId: number;
  episodes: { number: number; score: number | null }[];
  source: "tmdb" | "none";
};

export default function ScoresTab({ info, seasonList }: Props) {
  const { t } = useTranslation();
  const titlePref = useTitlePref();

  // Last-aired episode for the CURRENT AniList entry, used when `episodes` is
  // null (ongoing shows like One Piece report episodes:null but expose the next
  // airing episode — episode N means N-1 have aired).
  const airedFromNext = info.nextAiringEpisode?.episode
    ? info.nextAiringEpisode.episode - 1
    : 0;

  // Season columns — prefer the resolved chain, else a single column from info.
  const seasons = useMemo(() => {
    const base: SeasonEntry[] =
      seasonList && seasonList.length > 0
        ? seasonList
        : [
            {
              id: info.id,
              number: 1,
              label: "Season 1",
              year: info.seasonYear ?? info.startDate?.year ?? null,
              episodes: info.episodes ?? null,
              averageScore: info.averageScore ?? null,
              format: info.format ?? null,
              title: info.title,
            } as SeasonEntry,
          ];
    return base.map((s) => {
      // Episode count: AniList `episodes` when known; otherwise, for the entry
      // that matches this page (the current info), fall back to the aired count
      // derived from nextAiringEpisode. TMDB's count (loaded async) tops this up
      // later via `tmdbEpCount`. Never below 1 so the column always shows.
      const fromAni =
        s.episodes ?? (s.id === info.id ? airedFromNext : 0) ?? 0;
      return {
        ...s,
        seasonScore: toScore10(s.averageScore),
        aniEpCount: Math.max(0, fromAni),
      };
    });
  }, [seasonList, info, airedFromNext]);

  // Fetch real per-episode scores (TMDB). Keyed by aniId → episodes map.
  const [epScores, setEpScores] = useState<Map<number, Map<number, number | null>>>(
    new Map(),
  );

  useEffect(() => {
    let cancelled = false;
    const payload = seasons.map((s) => ({
      aniId: s.id,
      title: { romaji: s.title?.romaji ?? null, english: s.title?.english ?? null },
      year: s.year ?? null,
      episodeCount: s.episodes ?? null,
    }));
    if (payload.length === 0) return;
    fetch(
      `/api/v2/episode-scores/${info.id}?seasons=${encodeURIComponent(
        JSON.stringify(payload),
      )}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { enabled?: boolean; seasons?: ApiSeason[] } | null) => {
        if (cancelled || !data?.seasons?.length) return;
        const next = new Map<number, Map<number, number | null>>();
        for (const s of data.seasons) {
          if (s.source !== "tmdb") continue;
          const m = new Map<number, number | null>();
          for (const e of s.episodes) m.set(e.number, e.score);
          next.set(s.aniId, m);
        }
        if (next.size > 0) setEpScores(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.id, seasons.map((s) => s.id).join(",")]);

  // Final per-season episode count: the larger of AniList's count and the
  // highest episode number TMDB returned (TMDB sometimes knows more aired
  // episodes than AniList's stale `episodes` field). Always ≥ 1.
  const seasonsWithCount = useMemo(() => {
    return seasons.map((s) => {
      const tmdbMap = epScores.get(s.id);
      const tmdbMax =
        tmdbMap && tmdbMap.size > 0 ? Math.max(...Array.from(tmdbMap.keys())) : 0;
      const epCount = Math.max(1, s.aniEpCount, tmdbMax);
      return { ...s, epCount };
    });
  }, [seasons, epScores]);

  // Episodes per row in the grid — each row is labelled on the left with its
  // episode range ("E1–20"). EVERY episode keeps its own cell; this is purely
  // how the flat episode list wraps into rows.
  const ROW_SIZE = 20;

  // Header average — mean of the real per-episode (TMDB) scores actually shown.
  // Falls back to the mean of season averages when no per-episode data exists
  // (no key / no match / nothing aired yet) so the header never disappears.
  const overall = useMemo(() => {
    const epVals: number[] = [];
    for (const season of seasonsWithCount) {
      const m = epScores.get(season.id);
      if (!m) continue;
      for (const v of Array.from(m.values())) if (v != null) epVals.push(v);
    }
    const pool =
      epVals.length > 0
        ? epVals
        : seasonsWithCount
            .map((s) => s.seasonScore)
            .filter((v): v is number => v != null);
    if (pool.length === 0) return null;
    return Math.round((pool.reduce((a, b) => a + b, 0) / pool.length) * 10) / 10;
  }, [seasonsWithCount, epScores]);

  // Multi-season shows use a SIDE-BY-SIDE COLUMN table (one column per season,
  // one row per episode) — the original layout. A single season with many
  // episodes instead flows as rows of 20 cells so it stays compact.
  const multiSeason = seasonsWithCount.length > 1;

  // Unique column header per season. Most chains number cleanly (S1…S6), but a
  // split-cours season can repeat a number (AoT "S3" + "S3 Part 2"); fall back
  // to a sequential index so no two columns read identically.
  const colLabels = useMemo(() => {
    const seen = new Map<number, number>();
    return seasonsWithCount.map((season, idx) => {
      const n = season.number;
      const count = (seen.get(n) || 0) + 1;
      seen.set(n, count);
      // First occurrence keeps "S{n}"; a repeat becomes "S{idx+1}" (its chain
      // position) so the column is still distinct and ordered.
      return count === 1 ? `S${n}` : `S${idx + 1}`;
    });
  }, [seasonsWithCount]);

  const maxEpisodes = useMemo(
    () => Math.max(1, ...seasonsWithCount.map((s) => s.epCount)),
    [seasonsWithCount],
  );

  return (
    <div style={s.root}>
      <div style={s.header}>
        <div style={s.headerTitle}>
          {pickTitle(info.title, titlePref)}
          <span style={s.headerSub}>{t("anime.scoreGridTitle")}</span>
        </div>
        {overall != null && (
          <div style={s.overall} className="mono">
            <span style={s.star}>★</span>
            {overall.toFixed(1)}
            <span style={s.overallLabel}>{t("anime.avgScore")}</span>
          </div>
        )}
      </div>

      <div style={s.legend}>
        {TIERS.map((tier) => (
          <div key={tier.key} style={s.legendItem}>
            <span style={{ ...s.legendDot, background: tier.color }} />
            <span style={s.legendLabel}>{t(`anime.tier.${tier.key}`)}</span>
          </div>
        ))}
      </div>

      {multiSeason ? (
        // ── Column table: one column per season, one row per episode ──
        <div style={s.scroller}>
          <table style={s.table} className="mono">
            <thead>
              <tr>
                <th style={{ ...s.th, ...s.rowHeadCell }} />
                {seasonsWithCount.map((season, ci) => (
                  <th key={season.id} style={s.th}>
                    <div style={s.thInner}>
                      <span>{colLabels[ci]}</span>
                      {season.seasonScore != null && (
                        <span style={s.thAvg}>★ {season.seasonScore.toFixed(1)}</span>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: maxEpisodes }).map((_, rowIdx) => {
                const epNum = rowIdx + 1;
                return (
                  <tr key={rowIdx}>
                    <td style={s.rowHead}>E{epNum}</td>
                    {seasonsWithCount.map((season) => {
                      if (epNum > season.epCount) {
                        return <td key={season.id} style={s.cellEmpty} />;
                      }
                      const score = epScores.get(season.id)?.get(epNum) ?? null;
                      const tier = tierFor(score);
                      return (
                        <td key={season.id} style={s.cellWrap}>
                          <span
                            style={{
                              ...s.cell,
                              minWidth: 56,
                              background: tier.color,
                              color: tier.text,
                              ...(score != null
                                ? { textShadow: "0 1px 2px rgba(0,0,0,0.45)" }
                                : null),
                            }}
                          >
                            {score != null ? score.toFixed(1) : "—"}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        // ── Single season: rows of 20 episode cells, labelled by range ──
        <div style={s.seasons}>
          {seasonsWithCount.map((season) => {
            const epMap = epScores.get(season.id);
            const rows = Math.ceil(season.epCount / ROW_SIZE);
            return (
              <section key={season.id} style={s.seasonBlock}>
                {Array.from({ length: rows }).map((_, rowIdx) => {
                  const from = rowIdx * ROW_SIZE + 1;
                  const to = Math.min((rowIdx + 1) * ROW_SIZE, season.epCount);
                  return (
                    <div key={rowIdx} style={s.epRow}>
                      <span style={s.epRowLabel}>
                        {from === to ? `E${from}` : `E${from}–${to}`}
                      </span>
                      <div style={s.epRowCells}>
                        {Array.from({ length: to - from + 1 }).map((__, i) => {
                          const epNum = from + i;
                          const score = epMap?.get(epNum) ?? null;
                          const tier = tierFor(score);
                          return (
                            <span
                              key={epNum}
                              title={`${t("common.episode")} ${epNum}`}
                              style={{
                                ...s.cell,
                                background: tier.color,
                                color: tier.text,
                                ...(score != null
                                  ? { textShadow: "0 1px 2px rgba(0,0,0,0.45)" }
                                  : null),
                              }}
                            >
                              {score != null ? score.toFixed(1) : "—"}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      )}

      <p style={s.footnote}>{t("anime.scoreGridNote")}</p>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: 16 },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    flexWrap: "wrap",
  },
  headerTitle: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    fontSize: 18,
    fontWeight: 800,
    color: "var(--txt-0)",
  },
  headerSub: {
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: 0.5,
    textTransform: "uppercase",
    color: "var(--txt-3)",
  },
  overall: {
    display: "flex",
    alignItems: "baseline",
    gap: 6,
    fontSize: 24,
    fontWeight: 800,
    color: "var(--txt-0)",
  },
  star: { color: "#f5c518", fontSize: 18 },
  overallLabel: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    color: "var(--txt-3)",
  },
  legend: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px 16px",
    padding: "10px 12px",
    borderRadius: 10,
    background: "var(--bg-2)",
  },
  legendItem: { display: "flex", alignItems: "center", gap: 6 },
  legendDot: { width: 11, height: 11, borderRadius: "50%", display: "inline-block" },
  legendLabel: { fontSize: 12, color: "var(--txt-2)" },
  seasons: {
    display: "flex",
    flexDirection: "column",
    gap: 18,
    padding: 16,
    borderRadius: 12,
    border: "1px solid var(--line)",
    background: "var(--bg-1)",
  },
  seasonBlock: { display: "flex", flexDirection: "column", gap: 6 },
  // One row of the grid: a fixed-width range label on the left, then the
  // episode cells flowing to the right. The label column is fixed so every
  // row's cells line up vertically into clean columns.
  epRow: { display: "flex", alignItems: "center", gap: 10 },
  epRowLabel: {
    flex: "0 0 auto",
    width: 76,
    textAlign: "right",
    fontSize: 11.5,
    fontWeight: 600,
    color: "var(--txt-2)",
    whiteSpace: "nowrap",
  },
  epRowCells: {
    display: "grid",
    gridTemplateColumns: "repeat(20, minmax(0, 1fr))",
    gap: 5,
    flex: 1,
    minWidth: 0,
  },
  cell: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 0,
    height: 30,
    borderRadius: 6,
    fontSize: 12.5,
    fontWeight: 700,
  },
  // ── Multi-season column table ──
  scroller: {
    overflowX: "auto",
    borderRadius: 12,
    border: "1px solid var(--line)",
    background: "var(--bg-1)",
  },
  table: {
    borderCollapse: "separate",
    borderSpacing: 6,
    margin: "4px auto",
    minWidth: "max-content",
  },
  th: {
    fontSize: 13,
    fontWeight: 700,
    color: "var(--txt-1)",
    padding: "4px 8px",
    textAlign: "center",
    minWidth: 56,
  },
  thInner: { display: "flex", flexDirection: "column", alignItems: "center", gap: 1 },
  thAvg: { fontSize: 10.5, fontWeight: 600, color: "var(--txt-3)" },
  rowHeadCell: { minWidth: 44 },
  rowHead: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--txt-2)",
    textAlign: "right",
    paddingRight: 8,
    whiteSpace: "nowrap",
  },
  cellWrap: { padding: 0 },
  cellEmpty: { minWidth: 56 },
  footnote: { fontSize: 11.5, color: "var(--txt-3)", lineHeight: 1.5 },
};
