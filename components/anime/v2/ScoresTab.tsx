import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import type { SeasonEntry } from "@/lib/anilist/seasonChain";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { useTranslation } from "react-i18next";

/**
 * Per-season / per-episode score grid, styled after the "Screen Score" format
 * (one column per season, one row per episode, cells colour-coded by tier).
 *
 * Data:
 *   - Per-episode scores come from Jikan (MyAnimeList) via
 *     /api/v2/episode-scores, keyed on each AniList season's MAL id so the
 *     episode mapping is exact. MAL scores are /5, doubled to /10.
 *   - An episode with no rating (not aired yet, or no community votes) renders
 *     as a grey "—" cell — never a stand-in number.
 *
 * Layout:
 *   - Single season            → rows of 20 cells, labelled by range (E1–20).
 *   - Multiple seasons         → side-by-side column table (one col per season).
 *   The grid can be panned/zoomed and opened fullscreen (see PanZoom).
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
  source: "jikan" | "none";
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
              idMal: info.idMal ?? null,
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
      // Episode count: prefer AniList's own `episodes` for this entry — it
      // defines THIS season's boundary, so we don't bleed a neighbouring
      // season's episodes in (e.g. MAL's "AoT S3" lists 22 eps spanning S3+S3
      // Part 2, but AniList's S3 entry is 12). When AniList's count is unknown
      // (ongoing show), fall back to the aired count from nextAiringEpisode, and
      // only then let Jikan top it up. Never below 1 so the column always shows.
      const aniKnown = s.episodes != null;
      const fromAni =
        s.episodes ?? (s.id === info.id ? airedFromNext : 0) ?? 0;
      return {
        ...s,
        seasonScore: toScore10(s.averageScore),
        aniEpCount: Math.max(0, fromAni),
        aniKnown,
      };
    });
  }, [seasonList, info, airedFromNext]);

  // Fetch real per-episode scores (Jikan). Keyed by aniId → episodes map.
  const [epScores, setEpScores] = useState<Map<number, Map<number, number | null>>>(
    new Map(),
  );

  useEffect(() => {
    let cancelled = false;
    // Each season carries its own MAL id; Jikan returns that entry's exact
    // episodes, so there's no season-number guessing server-side.
    const payload = seasons.map((s) => ({ aniId: s.id, idMal: s.idMal ?? null }));
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
          if (s.source !== "jikan") continue;
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

  // Final per-season episode count.
  //   - AniList knows this season's length → use it verbatim (the column ends
  //     exactly where the season does; we don't pull in a MAL entry's extra
  //     episodes that belong to the next AniList season).
  //   - AniList doesn't (ongoing show) → take the larger of the aired-count
  //     fallback and Jikan's highest episode number.
  const seasonsWithCount = useMemo(() => {
    return seasons.map((s) => {
      const epMap = epScores.get(s.id);
      const jikanMax =
        epMap && epMap.size > 0 ? Math.max(...Array.from(epMap.keys())) : 0;
      const epCount = s.aniKnown
        ? Math.max(1, s.aniEpCount)
        : Math.max(1, s.aniEpCount, jikanMax);
      return { ...s, epCount };
    });
  }, [seasons, epScores]);

  // Header average — mean of the real per-episode (Jikan) scores actually shown.
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

  // Column header per season. Each entry already carries its true season number
  // (S1…S4 for AoT, with the Final Season correctly numbered 4). A split-cours
  // season repeats a number (AoT "S3" + "S3 Part 2"); we disambiguate the
  // repeat with a part marker — "S3", "S3 Pt. 2", "S4", "S4 Pt. 2" — so it reads
  // as the same season's second cour rather than a different season.
  const colLabels = useMemo(() => {
    const seen = new Map<number, number>();
    return seasonsWithCount.map((season) => {
      const n = season.number;
      const part = (seen.get(n) || 0) + 1;
      seen.set(n, part);
      return part === 1 ? `S${n}` : `S${n} Pt. ${part}`;
    });
  }, [seasonsWithCount]);

  const maxEpisodes = useMemo(
    () => Math.max(1, ...seasonsWithCount.map((s) => s.epCount)),
    [seasonsWithCount],
  );

  const [fullscreen, setFullscreen] = useState(false);

  // Viewport width drives how many episode cells fit per row in the single-
  // season grid. Wide screens keep the dense 20-wide layout; narrow ones (phones
  // in fullscreen) drop to fewer columns so each cell stays legible instead of
  // being crushed. Tracked on resize.
  const [vw, setVw] = useState<number>(
    typeof window !== "undefined" ? window.innerWidth : 1280,
  );
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Episodes per row in the single-season grid — responsive so cells stay
  // readable on small screens. Each row is labelled on the left with its range.
  // Fullscreen has the whole viewport to work with, so it packs many more
  // episodes per row (≈ one cell per 70px of width) and fills the screen instead
  // of leaving big empty margins; inline keeps the compact 6/10/15/20 steps.
  const ROW_SIZE = fullscreen
    ? Math.max(vw < 480 ? 6 : vw < 768 ? 10 : 20, Math.min(60, Math.floor((vw - 120) / 70)))
    : vw < 480
      ? 6
      : vw < 768
        ? 10
        : vw < 1100
          ? 15
          : 20;

  // Close fullscreen on Escape.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    // Lock body scroll while the overlay is open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [fullscreen]);

  // The grid itself (table for multi-season, rows for single season). Wrapped by
  // PanZoom so it can be dragged + zoomed, both inline and in fullscreen.
  // One score cell (shared by both table orientations).
  const scoreCell = (season: (typeof seasonsWithCount)[number], epNum: number) => {
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
  };

  // Multi-season orientation flips with the viewport:
  //   - PC / wide → seasons down the rows, episodes across the columns
  //     (the wide screen has room for a long horizontal episode axis).
  //   - Mobile / narrow → seasons across the columns, episodes down the rows
  //     (the classic table; a phone scrolls vertically through episodes).
  const transposed = vw >= 768;

  const grid = multiSeason ? (
        transposed ? (
          // ── Transposed (PC): one ROW per season, one column per episode ──
          <div style={s.gridPad}>
            <table style={s.table} className="mono">
              <thead>
                <tr>
                  <th style={{ ...s.th, ...s.rowHeadCell }} />
                  {Array.from({ length: maxEpisodes }).map((_, ci) => (
                    <th key={ci} style={s.thEp}>
                      E{ci + 1}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {seasonsWithCount.map((season, ri) => (
                  <tr key={season.id}>
                    <td style={s.rowHeadSeasonCell}>
                      <div style={s.rowHeadSeason}>
                        <span>{colLabels[ri]}</span>
                        {season.seasonScore != null && (
                          <span style={s.rowHeadAvg}>
                            ★ {season.seasonScore.toFixed(1)}
                          </span>
                        )}
                      </div>
                    </td>
                    {Array.from({ length: maxEpisodes }).map((_, ci) =>
                      scoreCell(season, ci + 1),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          // ── Classic (mobile): one column per season, one row per episode ──
          <div style={s.gridPad}>
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
                      {seasonsWithCount.map((season) => scoreCell(season, epNum))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : (
        // ── Single season: rows of N episode cells (N responsive), labelled by
        //    range ("E1–20" on desktop, "E1–6" on a phone) ──
        // Inline it's full-width (100%). In fullscreen the PanZoom content
        // wrapper is max-content, which would shrink-wrap a 100%-width child to
        // nothing — so we give it an explicit viewport-derived width so the grid
        // actually spans the screen instead of hugging the centre.
        <div
          style={
            fullscreen
              ? { ...s.seasonsPad, width: vw - 80 }
              : s.seasonsPad
          }
        >
          {seasonsWithCount.map((season) => {
            const epMap = epScores.get(season.id);
            const rows = Math.ceil(season.epCount / ROW_SIZE);
            // Fixed column count per row so cells line up vertically even on the
            // last, partially-filled row.
            const cellsGrid: CSSProperties = {
              ...s.epRowCells,
              gridTemplateColumns: `repeat(${ROW_SIZE}, minmax(0, 1fr))`,
            };
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
                      <div style={cellsGrid}>
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
      );

  const body = (
    <>
      <div style={s.header}>
        <div style={s.headerTitle}>
          {pickTitle(info.title, titlePref)}
          <span style={s.headerSub}>{t("anime.scoreGridTitle")}</span>
        </div>
        <div style={s.headerRight}>
          {overall != null && (
            <div style={s.overall} className="mono">
              <span style={s.star}>★</span>
              {overall.toFixed(1)}
              <span style={s.overallLabel}>{t("anime.avgScore")}</span>
            </div>
          )}
          <button
            type="button"
            style={s.fsBtn}
            onClick={() => setFullscreen((v) => !v)}
            title={fullscreen ? t("common.close") : t("anime.fullscreen")}
            aria-label={fullscreen ? t("common.close") : t("anime.fullscreen")}
          >
            {fullscreen ? <IconExitFs /> : <IconEnterFs />}
          </button>
        </div>
      </div>

      <div style={s.legend}>
        {TIERS.map((tier) => (
          <div key={tier.key} style={s.legendItem}>
            <span style={{ ...s.legendDot, background: tier.color }} />
            <span style={s.legendLabel}>{t(`anime.tier.${tier.key}`)}</span>
          </div>
        ))}
      </div>

      {/* Inline = a plain scrollable box (normal page behaviour). Fullscreen =
          a pan/zoom canvas you can drag + zoom. The multi-season table is
          fixed-width content, so we centre it horizontally when it's narrower
          than the box (it still scrolls when wider). The single-season grid is
          already full-width and shouldn't be centred. */}
      {fullscreen ? (
        <PanZoom centreContent={multiSeason}>{grid}</PanZoom>
      ) : (
        <div
          style={
            multiSeason
              ? { ...s.inlineScroller, ...s.inlineScrollerCentred }
              : s.inlineScroller
          }
        >
          {grid}
        </div>
      )}

      <p style={s.footnote}>{t("anime.scoreGridNote")}</p>
    </>
  );

  if (fullscreen) {
    return (
      <div style={s.fsOverlay}>
        <div style={s.fsInner}>{body}</div>
      </div>
    );
  }

  return <div style={s.root}>{body}</div>;
}

/* ── Pan + zoom canvas (fullscreen only) ──────────────────────
   Left-click drag to pan, scroll wheel to zoom toward the cursor, double-click
   to re-centre. The content is centred in the viewport on open. */
function PanZoom({
  children,
  centreContent = true,
}: {
  children: React.ReactNode;
  /** When true (multi-season), centre the content horizontally even if it's
   *  narrower than the box. The single-season grid is full-width so it pins to
   *  the left edge instead. */
  centreContent?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [tf, setTf] = useState({ x: 0, y: 0, scale: 1 });
  const drag = useRef({ active: false, sx: 0, sy: 0, ox: 0, oy: 0 });

  // Centre the content within the box (horizontally when requested; vertically
  // only when it fits, otherwise pin to the top so the first rows are visible).
  const centre = () => {
    const box = boxRef.current;
    const content = contentRef.current;
    if (!box || !content) return;
    const bw = box.clientWidth;
    const bh = box.clientHeight;
    // contentRef is the OUTER (translate-only) wrapper — translate doesn't
    // affect clientWidth/scrollWidth, so this reads the natural 1× size no
    // matter the current zoom. The reset lands at scale 1, so natural == final.
    const cw = content.scrollWidth;
    const ch = content.scrollHeight;
    const x = centreContent ? Math.max(0, (bw - cw) / 2) : 0;
    const y = ch < bh ? (bh - ch) / 2 : 0;
    setTf({ x, y, scale: 1 });
  };

  useEffect(() => {
    // Centre once the overlay has laid out.
    const id = requestAnimationFrame(centre);
    return () => cancelAnimationFrame(id);
  }, []);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const box = boxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    setTf((prev) => {
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const scale = Math.min(6, Math.max(0.3, prev.scale * factor));
      const k = scale / prev.scale;
      // Keep the point under the cursor fixed while zooming.
      return { x: px - (px - prev.x) * k, y: py - (py - prev.y) * k, scale };
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { active: true, sx: e.clientX, sy: e.clientY, ox: tf.x, oy: tf.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current.active) return;
    setTf((prev) => ({
      ...prev,
      x: drag.current.ox + (e.clientX - drag.current.sx),
      y: drag.current.oy + (e.clientY - drag.current.sy),
    }));
  };
  const endDrag = (e: React.PointerEvent) => {
    drag.current.active = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  return (
    <div
      ref={boxRef}
      style={s.panBoxFs}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
      onDoubleClick={centre}
    >
      {/* Pan (translate) and zoom are split across two elements:
          - the OUTER wrapper translates → smooth panning, GPU-composited.
          - the INNER content uses the CSS `zoom` property to scale. Unlike
            `transform: scale()`, `zoom` re-runs layout + rasterisation at the
            new size, so text stays razor-sharp at any zoom instead of being a
            blurry bitmap upscale. The cursor-anchored zoom math is identical
            (the box→content mapping is the same), so onWheel is unchanged. */}
      <div
        ref={contentRef}
        style={{
          transform: `translate(${tf.x}px, ${tf.y}px)`,
          transformOrigin: "0 0",
          width: "max-content",
          willChange: "transform",
        }}
      >
        <div
          style={{
            // `zoom` isn't in the React CSSProperties type but is widely
            // supported (Chrome/Edge/Safari, Firefox 126+); cast to satisfy TS.
            zoom: tf.scale,
            width: "max-content",
          } as CSSProperties}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function IconEnterFs() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}
function IconExitFs() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />
    </svg>
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
  headerRight: { display: "flex", alignItems: "center", gap: 14 },
  fsBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 34,
    height: 34,
    borderRadius: 8,
    border: "1px solid var(--line)",
    background: "var(--bg-2)",
    color: "var(--txt-2)",
    cursor: "pointer",
    flexShrink: 0,
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
  // Single-season grid: fills the available width so the cells stretch edge to
  // edge (no narrow centred column). gridPad is for the multi-season table,
  // which is fixed-width content (max-content) and scrolls horizontally instead.
  seasonsPad: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
    padding: 16,
    width: "100%",
  },
  gridPad: { padding: 12, width: "max-content", margin: "0 auto", textAlign: "left" },
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
  table: {
    borderCollapse: "separate",
    borderSpacing: 6,
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
  // Portrait (mobile) multi-season table: episode column headers across the top,
  // season row labels (with avg) down the left.
  thEp: {
    fontSize: 11,
    fontWeight: 700,
    color: "var(--txt-2)",
    padding: "2px 4px",
    textAlign: "center",
    minWidth: 56,
  },
  rowHeadSeasonCell: { paddingRight: 10, whiteSpace: "nowrap", verticalAlign: "middle" },
  rowHeadSeason: {
    display: "flex",
    flexDirection: "column",
    gap: 1,
    fontSize: 12.5,
    fontWeight: 700,
    color: "var(--txt-1)",
    textAlign: "left",
  },
  rowHeadAvg: { fontSize: 10, fontWeight: 600, color: "var(--txt-3)" },
  cellWrap: { padding: 0 },
  cellEmpty: { minWidth: 56 },
  footnote: { fontSize: 11.5, color: "var(--txt-3)", lineHeight: 1.5 },

  // ── Inline (non-fullscreen) container ──
  // Full-width framed box. Scrolls inside on its own (horizontally for a wide
  // multi-season table, vertically for a tall single-season grid) — normal page
  // behaviour, no pan/zoom. Numbers aren't selectable.
  inlineScroller: {
    width: "100%",
    maxHeight: "80vh",
    overflow: "auto",
    borderRadius: 12,
    border: "1px solid var(--line)",
    background: "var(--bg-1)",
    userSelect: "none",
    WebkitUserSelect: "none",
  },
  // Multi-season: centre the fixed-width table horizontally when it fits, while
  // staying scrollable when it's wider than the box. `margin-inline:auto` on the
  // max-content child (gridPad) does exactly this without the left-edge clipping
  // that flex `justify-content:center` causes on overflow.
  inlineScrollerCentred: {
    textAlign: "center",
  },

  // ── Pan / zoom canvas (fullscreen only) ──
  // The box clips and owns the drag/zoom gestures and fills the overlay height.
  // `touchAction: none` so a drag doesn't also scroll the page on touch devices.
  panBoxFs: {
    position: "relative",
    overflow: "hidden",
    borderRadius: 12,
    border: "1px solid var(--line)",
    background: "var(--bg-1)",
    flex: 1,
    minHeight: 0,
    cursor: "grab",
    touchAction: "none",
    userSelect: "none",
    WebkitUserSelect: "none",
  },
  fsOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 10000,
    background: "var(--surface-bg, #0e0e16)",
    display: "flex",
    flexDirection: "column",
  },
  fsInner: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: 14,
    height: "100%",
    boxSizing: "border-box",
  },
};
