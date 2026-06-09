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

// Conventional, self-explanatory tiers mapped onto a /10 score.
const TIERS: Tier[] = [
  { key: "masterpiece", label: "Masterpiece", color: "#2f80ed", text: "#fff", min: 9.0 },
  { key: "great", label: "Great", color: "#1f7a3f", text: "#fff", min: 8.0 },
  { key: "good", label: "Good", color: "#4caf50", text: "#0b2010", min: 7.0 },
  { key: "average", label: "Average", color: "#e0c000", text: "#2a2400", min: 6.0 },
  { key: "weak", label: "Weak", color: "#e8862b", text: "#2a1500", min: 5.0 },
  { key: "poor", label: "Poor", color: "#e0413e", text: "#fff", min: 0 },
];

const NA_TIER: Tier = { key: "na", label: "—", color: "var(--bg-3)", text: "var(--txt-3)", min: 0 };

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
    return base.map((s) => ({
      ...s,
      seasonScore: toScore10(s.averageScore),
      epCount: Math.max(1, s.episodes ?? 0) || 1,
    }));
  }, [seasonList, info]);

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

  const maxEpisodes = useMemo(
    () => Math.max(1, ...seasons.map((s) => s.epCount)),
    [seasons],
  );

  const BAND_THRESHOLD = 30;
  const banded = maxEpisodes > BAND_THRESHOLD;

  const bandSize = useMemo(() => {
    if (!banded) return 1;
    const targetBands = 14;
    const raw = Math.ceil(maxEpisodes / targetBands);
    const steps = [5, 10, 25, 50, 100, 200, 500];
    return steps.find((step) => step >= raw) || raw;
  }, [banded, maxEpisodes]);

  const rowCount = banded ? Math.ceil(maxEpisodes / bandSize) : maxEpisodes;

  // Resolve a cell's score: real per-episode (TMDB) when present, else the
  // season average. In banded mode we always use the season average.
  const cellScore = (
    season: (typeof seasons)[number],
    rowIdx: number,
  ): number | null => {
    if (banded) return season.seasonScore;
    const epNum = rowIdx + 1;
    const perEp = epScores.get(season.id)?.get(epNum);
    if (perEp != null) return perEp;
    return season.seasonScore;
  };

  // Header average — mean of every painted cell so it reflects what's shown.
  const overall = useMemo(() => {
    const vals: number[] = [];
    for (const season of seasons) {
      const rows = banded ? Math.ceil(season.epCount / bandSize) : season.epCount;
      for (let i = 0; i < rows; i++) {
        const v = cellScore(season, i);
        if (v != null) vals.push(v);
      }
    }
    if (vals.length === 0) return null;
    return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seasons, epScores, banded, bandSize]);

  const rowLabel = (i: number) => {
    if (!banded) return `E${i + 1}`;
    const from = i * bandSize + 1;
    const to = Math.min((i + 1) * bandSize, maxEpisodes);
    return from === to ? `E${from}` : `E${from}–${to}`;
  };

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

      <div style={s.scroller}>
        <table style={s.table} className="mono">
          <thead>
            <tr>
              <th style={{ ...s.th, ...s.rowHeadCell }} />
              {seasons.map((season) => (
                <th key={season.id} style={s.th}>
                  S{season.number}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rowCount }).map((_, rowIdx) => (
              <tr key={rowIdx}>
                <td style={s.rowHead}>{rowLabel(rowIdx)}</td>
                {seasons.map((season) => {
                  const seasonRows = banded
                    ? Math.ceil(season.epCount / bandSize)
                    : season.epCount;
                  if (rowIdx >= seasonRows) {
                    return <td key={season.id} style={s.cellEmpty} />;
                  }
                  const score = cellScore(season, rowIdx);
                  const tier = tierFor(score);
                  return (
                    <td key={season.id} style={s.cellWrap}>
                      <span
                        style={{ ...s.cell, background: tier.color, color: tier.text }}
                      >
                        {score != null ? score.toFixed(1) : "—"}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
  rowHeadCell: { minWidth: 52 },
  rowHead: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--txt-2)",
    textAlign: "right",
    paddingRight: 8,
    whiteSpace: "nowrap",
  },
  cellWrap: { padding: 0 },
  cell: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 56,
    height: 34,
    borderRadius: 7,
    fontSize: 14,
    fontWeight: 700,
  },
  cellEmpty: { minWidth: 56 },
  footnote: { fontSize: 11.5, color: "var(--txt-3)", lineHeight: 1.5 },
};
