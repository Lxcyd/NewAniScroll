import { CSSProperties, useMemo } from "react";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import type { SeasonEntry } from "@/lib/anilist/seasonChain";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { useTranslation } from "react-i18next";

/**
 * Per-season score grid, styled after the "Screen Score" episode-grid format
 * (one column per season, one row per episode, each cell colour-coded by tier).
 *
 * AniList exposes a single averageScore per ANIME (per season), not per
 * episode — so every episode cell in a season shares that season's score. This
 * keeps the recognisable SS2 visual while staying 100% backed by data we
 * already have (no third-party episode-rating API).
 *
 * Adaptive layout:
 *   - ≤ ~26 episodes  → full grid (one cell per episode), like the screenshot.
 *   - more episodes   → "banded" mode: instead of N tiny rows we render a few
 *     episode-range bands per season (E1–10, E11–20, …) so a 1000-episode show
 *     (One Piece) doesn't produce a kilometre-long column.
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

// Tiers mirror the SS2 legend, mapped onto AniList's /10 score.
const TIERS: Tier[] = [
  { key: "goat", label: "G.O.A.T", color: "#2f80ed", text: "#fff", min: 9.5 },
  { key: "peak", label: "Peak", color: "#1f7a3f", text: "#fff", min: 8.8 },
  { key: "tight", label: "Tight", color: "#4caf50", text: "#0b2010", min: 8.0 },
  { key: "decent", label: "Decent", color: "#e0c000", text: "#2a2400", min: 7.0 },
  { key: "mid", label: "Mid", color: "#e8862b", text: "#2a1500", min: 6.0 },
  { key: "flat", label: "Flat", color: "#e0413e", text: "#fff", min: 0 },
];

function tierFor(score10: number | null): Tier {
  if (score10 == null) return { key: "na", label: "—", color: "var(--bg-3)", text: "var(--txt-3)", min: 0 };
  return TIERS.find((traw) => score10 >= traw.min) || TIERS[TIERS.length - 1];
}

/** AniList averageScore (0-100) → /10 with one decimal, or null. */
function toScore10(avg: number | null | undefined): number | null {
  if (avg == null || !Number.isFinite(avg)) return null;
  return Math.round((avg / 10) * 10) / 10;
}

export default function ScoresTab({ info, seasonList }: Props) {
  const { t } = useTranslation();
  const titlePref = useTitlePref();

  // Build the season columns. Prefer the resolved season chain; if it's empty
  // (standalone anime / chain unresolved), fall back to a single column built
  // from `info` itself so the tab always shows something useful.
  const seasons = useMemo(() => {
    const list = (seasonList && seasonList.length > 0
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
        ]
    ).map((s) => ({
      ...s,
      score10: toScore10(s.averageScore),
      // Use the season's own episode count; fall back to 1 (movies/specials).
      epCount: Math.max(1, s.episodes ?? 0) || 1,
    }));
    return list;
  }, [seasonList, info]);

  // Longest column drives the number of rows we render.
  const maxEpisodes = useMemo(
    () => Math.max(1, ...seasons.map((s) => s.epCount)),
    [seasons]
  );

  // Switch to banded mode past this many episodes so huge shows stay readable.
  const BAND_THRESHOLD = 30;
  const banded = maxEpisodes > BAND_THRESHOLD;

  // For banded mode, choose a band size that yields ~12-15 bands max.
  const bandSize = useMemo(() => {
    if (!banded) return 1;
    const targetBands = 14;
    const raw = Math.ceil(maxEpisodes / targetBands);
    // Round to a friendly step (5, 10, 25, 50, 100…).
    const steps = [5, 10, 25, 50, 100, 200, 500];
    return steps.find((s) => s >= raw) || raw;
  }, [banded, maxEpisodes]);

  const rowCount = banded ? Math.ceil(maxEpisodes / bandSize) : maxEpisodes;

  // Average score across all scored seasons — shown in the header strip.
  const overall = useMemo(() => {
    const scored = seasons.map((s) => s.score10).filter((v): v is number => v != null);
    if (scored.length === 0) return null;
    return Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 10) / 10;
  }, [seasons]);

  const rowLabel = (i: number) => {
    if (!banded) return `E${i + 1}`;
    const from = i * bandSize + 1;
    const to = Math.min((i + 1) * bandSize, maxEpisodes);
    return from === to ? `E${from}` : `E${from}–${to}`;
  };

  return (
    <div style={s.root}>
      {/* Header / summary strip */}
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

      {/* Legend */}
      <div style={s.legend}>
        {TIERS.map((tier) => (
          <div key={tier.key} style={s.legendItem}>
            <span style={{ ...s.legendDot, background: tier.color }} />
            <span style={s.legendLabel}>{tier.label}</span>
          </div>
        ))}
      </div>

      {/* Grid */}
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
                  // Does this season actually have an episode in this row?
                  const seasonRows = banded
                    ? Math.ceil(season.epCount / bandSize)
                    : season.epCount;
                  const present = rowIdx < seasonRows;
                  if (!present) {
                    return <td key={season.id} style={s.cellEmpty} />;
                  }
                  const tier = tierFor(season.score10);
                  return (
                    <td key={season.id} style={s.cellWrap}>
                      <span
                        style={{
                          ...s.cell,
                          background: tier.color,
                          color: tier.text,
                        }}
                      >
                        {season.score10 != null ? season.score10.toFixed(1) : "—"}
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
  footnote: {
    fontSize: 11.5,
    color: "var(--txt-3)",
    lineHeight: 1.5,
  },
};
