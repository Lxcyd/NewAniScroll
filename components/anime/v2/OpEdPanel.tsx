import {
  CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { SeasonEntry } from "@/lib/anilist/seasonChain";
import type { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";

/* One theme as returned by /api/v2/themes/{id}. Mirrors lib/animethemes/themes.ts. */
type ThemeVideo = {
  url: string;
  nc: boolean;
  overlap: string | null;
  resolution: number | null;
  source: string | null;
  episodes: string | null;
};
type Theme = {
  slug: string;
  kind: "op" | "ed";
  sequence: number;
  song: string | null;
  artists: string[];
  /** NC-preferred default clip (kept for the row thumbnail / play entry). */
  video: ThemeVideo | null;
  /** Creditless rip, or null if only credited exists. */
  videoNc: ThemeVideo | null;
  /** Credited rip, or null if AnimeThemes has no credited version. */
  videoCredited: ThemeVideo | null;
};

type SeasonThemes = { season: SeasonEntry; themes: Theme[] };

/** Fetch OP/ED themes for a franchise, grouped by season, keeping only playable
 *  entries. Shared by the panel and the tab-button count. Returns loading state
 *  and the grouped data. */
export function useOpEdThemes(
  info: AniListInfoTypes,
  seasonList: SeasonEntry[],
): { loading: boolean; data: SeasonThemes[]; opCount: number; edCount: number } {
  const titlePref = useTitlePref();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<SeasonThemes[]>([]);

  const seasons: SeasonEntry[] = useMemo(() => {
    if (seasonList && seasonList.length > 0) return seasonList;
    return [
      {
        id: info.id,
        idMal: info.idMal ?? null,
        number: 1,
        label: pickTitle(info.title, titlePref),
        year: info.seasonYear ?? null,
        episodes: info.episodes ?? null,
        format: info.format ?? null,
        status: info.status ?? null,
        title: info.title ?? null,
        coverImage: info.coverImage ?? null,
        variants: null,
      } as SeasonEntry,
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seasonList, info.id]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all(
      seasons.map((s) =>
        fetch(`/api/v2/themes/${s.id}${s.idMal ? `?malId=${s.idMal}` : ""}`)
          .then((r) => (r.ok ? r.json() : { themes: [] }))
          .then((j) => ({
            season: s,
            themes: (j?.themes || []).filter(
              (th: Theme) => th?.video?.url,
            ) as Theme[],
          }))
          .catch(() => ({ season: s, themes: [] as Theme[] })),
      ),
    ).then((results) => {
      if (cancelled) return;
      setData(results.filter((r) => r.themes.length > 0));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [seasons]);

  const { opCount, edCount } = useMemo(() => {
    let op = 0;
    let ed = 0;
    for (const g of data)
      for (const th of g.themes) th.kind === "op" ? op++ : ed++;
    return { opCount: op, edCount: ed };
  }, [data]);

  return { loading, data, opCount, edCount };
}

/**
 * OP/ED panel — inline content shown when the "OP / ED" tab button is active
 * (REPLACES the episode list, like switching seasons). Openings & endings are
 * rendered as episode-style rows, grouped by season, and clicking one plays the
 * clean (NC) AnimeThemes clip in an overlay player.
 */
type ViewMode = "detailed" | "compact" | "grid";

export default function OpEdPanel({
  data,
  loading,
  filter = "",
  view = "detailed",
}: {
  data: SeasonThemes[];
  loading: boolean;
  /** Free-text query from the shared header search — matches song, artist, or
   *  the OP1/ED2 slug across every season group. */
  filter?: string;
  /** Shared header view mode: detailed rows / compact list / cover grid. */
  view?: ViewMode;
}) {
  const { t } = useTranslation();
  const [playing, setPlaying] = useState<{
    theme: Theme;
    seasonLabel: string;
  } | null>(null);

  const q = filter.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return data;
    return data
      .map((g) => ({
        ...g,
        themes: g.themes.filter(
          (th) =>
            (th.song ?? "").toLowerCase().includes(q) ||
            th.artists.some((a) => a.toLowerCase().includes(q)) ||
            th.slug.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.themes.length > 0);
  }, [data, q]);

  if (loading) {
    return (
      <div style={styles.empty}>{t("common.loading", { defaultValue: "Loading…" })}</div>
    );
  }
  if (data.length === 0) {
    return <div style={styles.empty}>{t("anime.noThemes", { defaultValue: "No openings or endings found." })}</div>;
  }

  return (
    <div>
      {filtered.map((g) => (
        <div key={String(g.season.id)} style={styles.section}>
          <div style={styles.sectionHead}>
            <span style={styles.sectionTitle}>{g.season.label}</span>
            <span style={styles.sectionCount}>{g.themes.length}</span>
          </div>
          {view === "grid" ? (
            <div style={styles.grid}>
              {g.themes.map((th) => (
                <ThemeTile
                  key={`${g.season.id}-${th.slug}`}
                  theme={th}
                  cover={
                    g.season.coverImage?.large ||
                    g.season.coverImage?.extraLarge ||
                    null
                  }
                  onPlay={() => setPlaying({ theme: th, seasonLabel: g.season.label })}
                />
              ))}
            </div>
          ) : (
            <div style={styles.list}>
              {g.themes.map((th) => (
                <ThemeRow
                  key={`${g.season.id}-${th.slug}`}
                  theme={th}
                  cover={
                    g.season.coverImage?.large ||
                    g.season.coverImage?.extraLarge ||
                    null
                  }
                  compact={view === "compact"}
                  onPlay={() => setPlaying({ theme: th, seasonLabel: g.season.label })}
                />
              ))}
            </div>
          )}
        </div>
      ))}

      {filtered.length === 0 && (
        <div style={styles.empty}>
          {t("anime.noThemeMatch", {
            defaultValue: "No opening or ending matches your search.",
          })}
        </div>
      )}

      {playing && (
        <ThemePlayerModal
          theme={playing.theme}
          seasonLabel={playing.seasonLabel}
          onClose={() => setPlaying(null)}
        />
      )}
    </div>
  );
}

/* Row thumbnail. We tried grabbing a real frame from each OP/ED clip (a muted,
   lazily-attached <video> seeked past the black lead-in), but seeking dozens of
   webm clips over range requests was unreliable — frames often never resolved
   and the extra concurrent loads made the actual clip playback flaky. So the
   thumbnail is the season cover (static, instant, always loads); the OP/ED label
   lives as a text chip beside the song, not on the image. */
function ThemeThumb({ cover }: { cover: string | null }) {
  return (
    <div style={styles.thumb}>
      {cover ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={cover}
          alt=""
          style={{ ...styles.thumbFill, objectFit: "cover" }}
          loading="lazy"
          decoding="async"
        />
      ) : null}
    </div>
  );
}

/** Kind chip colours, shared by every view mode. */
function chipStyle(isOp: boolean): CSSProperties {
  return {
    ...styles.kindChip,
    background: isOp ? "var(--accent-soft)" : "rgba(120,140,255,0.12)",
    color: isOp ? "var(--accent)" : "#8a9bff",
  };
}

/** A theme has a credits toggle inside the player only when BOTH a creditless
 *  and a credited rip exist — signal that upfront on the row so the toggle isn't
 *  a hidden surprise. Mirrors ThemePlayerModal's `showToggle` gate. */
function hasCreditsToggle(theme: Theme): boolean {
  return !!(theme.videoNc && theme.videoCredited);
}

/** Small "CC" badge marking rows whose player exposes the credits toggle. */
function CreditsBadge() {
  const { t } = useTranslation();
  return (
    <span
      style={styles.creditsBadge}
      title={t("anime.creditsAvailable", {
        defaultValue: "Creditless & with-credits versions available",
      })}
    >
      CC
    </span>
  );
}

function ThemeRow({
  theme,
  cover,
  onPlay,
  compact = false,
}: {
  theme: Theme;
  /** Season cover — the row's static artwork. */
  cover: string | null;
  onPlay: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const isOp = theme.kind === "op";
  const kindLabel = theme.slug || (isOp ? "OP" : "ED");
  const artists = theme.artists.join(", ");
  const eps = theme.video?.episodes;
  const metaText = [
    artists || null,
    eps ? t("anime.themeEpisodes", { eps, defaultValue: `Ep ${eps}` }) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // COMPACT — dense single-line row: chip · song · meta · play chevron.
  if (compact) {
    return (
      <button type="button" onClick={onPlay} style={styles.compactRow}>
        <span style={chipStyle(isOp)}>{kindLabel}</span>
        <span style={styles.compactTitle} title={theme.song || kindLabel}>
          {theme.song || kindLabel}
        </span>
        {hasCreditsToggle(theme) && <CreditsBadge />}
        {metaText && <span style={styles.compactMeta}>{metaText}</span>}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ color: "var(--txt-3)", flexShrink: 0 }}>
          <polygon points="8 5 19 12 8 19" />
        </svg>
      </button>
    );
  }

  // DETAILED — cover + chip/song + play.
  return (
    <button type="button" onClick={onPlay} style={styles.row}>
      <ThemeThumb cover={cover} />
      <div style={styles.info}>
        <div style={styles.titleRow}>
          <span style={chipStyle(isOp)}>{kindLabel}</span>
          <span style={styles.title}>{theme.song || kindLabel}</span>
          {hasCreditsToggle(theme) && <CreditsBadge />}
        </div>
        <div style={styles.meta}>{metaText}</div>
      </div>
      <span style={styles.playIcon}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="6 4 20 12 6 20" />
        </svg>
        {t("anime.playTheme", { defaultValue: "Play" })}
      </span>
    </button>
  );
}

/* GRID — cover tile with a play overlay + chip/song beneath. */
function ThemeTile({
  theme,
  cover,
  onPlay,
}: {
  theme: Theme;
  cover: string | null;
  onPlay: () => void;
}) {
  const isOp = theme.kind === "op";
  const kindLabel = theme.slug || (isOp ? "OP" : "ED");
  const artists = theme.artists.join(", ");
  return (
    <button type="button" onClick={onPlay} style={styles.tile}>
      <div style={styles.tilePoster}>
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={cover}
            alt=""
            style={{ ...styles.thumbFill, objectFit: "cover" }}
            loading="lazy"
            decoding="async"
          />
        ) : null}
        <span style={{ ...chipStyle(isOp), ...styles.tileChip }}>{kindLabel}</span>
        <span style={styles.tilePlay}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff">
            <polygon points="6 4 20 12 6 20" />
          </svg>
        </span>
      </div>
      <div style={styles.tileTitleRow}>
        <span style={styles.tileTitle} title={theme.song || kindLabel}>
          {theme.song || kindLabel}
        </span>
        {hasCreditsToggle(theme) && <CreditsBadge />}
      </div>
      {artists && (
        <div style={styles.tileMeta} title={artists}>
          {artists}
        </div>
      )}
    </button>
  );
}

/* Overlay clip player — native <video> for the selected OP/ED (short clips, so
   the full Vidstack chrome would be overkill). A credits/no-credits toggle picks
   between the credited and creditless (NC) AnimeThemes rips of the same theme;
   the side with no rip is disabled. Portalled to <body>. */
function ThemePlayerModal({
  theme,
  seasonLabel,
  onClose,
}: {
  theme: Theme;
  seasonLabel: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);

  const nc = theme.videoNc;
  const credited = theme.videoCredited;
  // Default = WITHOUT credits (NC) when available; only fall back to credited if
  // no NC rip exists. `showCredits` therefore starts false unless NC is missing.
  const [showCredits, setShowCredits] = useState<boolean>(!nc);
  const active = showCredits ? credited : nc;
  const activeUrl = active?.url ?? theme.video?.url ?? undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Preserve playback position across a credits/no-credits switch: capture the
  // current time before the src swaps, restore it once the new clip can seek.
  const resumeAt = useRef(0);
  const switchVariant = (toCredits: boolean) => {
    if (videoRef.current) resumeAt.current = videoRef.current.currentTime || 0;
    setShowCredits(toCredits);
  };
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !resumeAt.current) return;
    const target = resumeAt.current;
    const onLoaded = () => {
      try {
        el.currentTime = Math.min(target, (el.duration || target) - 0.1);
      } catch {
        /* seeking not ready yet — ignore */
      }
    };
    el.addEventListener("loadedmetadata", onLoaded, { once: true });
    return () => el.removeEventListener("loadedmetadata", onLoaded);
  }, [activeUrl]);

  if (typeof document === "undefined") return null;

  const isOp = theme.kind === "op";
  const kindWord = isOp
    ? t("anime.opening", { defaultValue: "Opening" })
    : t("anime.ending", { defaultValue: "Ending" });

  const showToggle = !!(nc && credited);

  return createPortal(
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={styles.dialogHead}>
          <div style={{ minWidth: 0 }}>
            <div style={styles.dialogTitle}>
              {theme.slug || kindWord} · {theme.song || kindWord}
            </div>
            <div style={styles.dialogSub}>
              {[seasonLabel, theme.artists.join(", ") || null]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
          <div style={styles.headActions}>
            {showToggle ? (
              <div style={styles.creditsControl}>
                <span style={styles.creditsLabel}>
                  {t("anime.creditsToggle", { defaultValue: "Credits" })}
                </span>
                <div style={styles.segmented} role="group" aria-label={t("anime.creditsToggle", { defaultValue: "Credits" })}>
                  <button
                    type="button"
                    onClick={() => switchVariant(false)}
                    disabled={!nc}
                    aria-pressed={!showCredits}
                    style={segBtnStyle(!showCredits, !nc)}
                  >
                    {t("anime.noCredits", { defaultValue: "No credits" })}
                  </button>
                  <button
                    type="button"
                    onClick={() => switchVariant(true)}
                    disabled={!credited}
                    aria-pressed={showCredits}
                    style={segBtnStyle(showCredits, !credited)}
                  >
                    {t("anime.withCredits", { defaultValue: "With credits" })}
                  </button>
                </div>
              </div>
            ) : (
              // Only one rip exists — explain the absence rather than silently
              // hiding the control, so the toggle never feels "missing".
              <span style={styles.creditsOnlyHint}>
                {credited
                  ? t("anime.onlyWithCredits", { defaultValue: "With credits only" })
                  : t("anime.onlyNoCredits", { defaultValue: "Creditless only" })}
              </span>
            )}
            <button type="button" onClick={onClose} style={styles.closeBtn} aria-label="Close">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="6" y1="18" x2="18" y2="6" />
              </svg>
            </button>
          </div>
        </div>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video ref={videoRef} src={activeUrl} controls autoPlay playsInline style={styles.video} />
      </div>
    </div>,
    document.body,
  );
}

/** Segmented-toggle button style. `active` = currently selected variant;
 *  `disabled` = that variant has no rip (greyed out, not clickable). */
function segBtnStyle(active: boolean, disabled: boolean): CSSProperties {
  return {
    padding: "5px 10px",
    fontSize: 11.5,
    fontWeight: 600,
    fontFamily: "inherit",
    border: "none",
    borderRadius: 6,
    cursor: disabled ? "not-allowed" : "pointer",
    color: disabled
      ? "var(--txt-3)"
      : active
        ? "var(--txt-0)"
        : "var(--txt-2)",
    background: active ? "var(--bg-1)" : "transparent",
    boxShadow: active ? "0 1px 3px rgba(0,0,0,0.25)" : "none",
    opacity: disabled ? 0.45 : 1,
    transition: "all 0.12s",
    whiteSpace: "nowrap",
  };
}

const styles: Record<string, CSSProperties> = {
  empty: {
    padding: 16,
    background: "var(--bg-2)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    color: "var(--txt-3)",
    fontSize: 13,
  },
  section: { marginBottom: 16 },
  sectionHead: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
    padding: "0 2px",
  },
  sectionTitle: { fontSize: 13, fontWeight: 700, color: "var(--txt-0)" },
  sectionCount: {
    fontSize: 10,
    color: "var(--txt-3)",
    padding: "2px 6px",
    background: "var(--bg-2)",
    border: "1px solid var(--line)",
    borderRadius: 4,
  },
  list: { display: "flex", flexDirection: "column", gap: 8 },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    padding: 10,
    border: "1px solid var(--line)",
    borderRadius: 10,
    background: "var(--bg-2)",
    textAlign: "left",
    fontFamily: "inherit",
    cursor: "pointer",
    width: "100%",
    transition: "all 0.15s",
  },
  thumb: {
    position: "relative",
    width: 100,
    height: 56,
    borderRadius: 7,
    overflow: "hidden",
    flexShrink: 0,
    background: "var(--bg-3)",
  },
  thumbFill: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
  },

  /* Compact single-line row */
  compactRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "9px 12px",
    border: "1px solid var(--line)",
    borderRadius: 8,
    background: "var(--bg-2)",
    textAlign: "left",
    fontFamily: "inherit",
    cursor: "pointer",
    width: "100%",
    minHeight: 40,
    transition: "background 0.12s",
  },
  compactTitle: {
    flex: 1,
    fontSize: 13,
    fontWeight: 500,
    color: "var(--txt-0)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  compactMeta: {
    fontSize: 11,
    color: "var(--txt-3)",
    flexShrink: 0,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: 220,
  },

  /* Cover grid */
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
    gap: 12,
  },
  tile: {
    display: "flex",
    flexDirection: "column",
    gap: 5,
    background: "transparent",
    border: "none",
    padding: 0,
    textAlign: "left",
    fontFamily: "inherit",
    cursor: "pointer",
  },
  tilePoster: {
    position: "relative",
    width: "100%",
    aspectRatio: "16 / 9",
    borderRadius: 8,
    overflow: "hidden",
    background: "var(--bg-3)",
    border: "1px solid var(--line)",
  },
  tileChip: {
    position: "absolute",
    top: 6,
    left: 6,
    backdropFilter: "blur(4px)",
    WebkitBackdropFilter: "blur(4px)",
  },
  tilePlay: {
    position: "absolute",
    right: 6,
    bottom: 6,
    width: 28,
    height: 28,
    borderRadius: 14,
    display: "grid",
    placeItems: "center",
    paddingLeft: 2,
    background: "color-mix(in srgb, var(--accent) 85%, transparent)",
  },
  tileTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: 12.5,
    fontWeight: 600,
    color: "var(--txt-0)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  tileMeta: {
    fontSize: 10.5,
    color: "var(--txt-3)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  info: { flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
  titleRow: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
  kindChip: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.03em",
    padding: "2px 6px",
    borderRadius: 4,
    flexShrink: 0,
  },
  title: {
    fontSize: 14,
    fontWeight: 600,
    color: "var(--txt-0)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  meta: {
    fontSize: 11.5,
    color: "var(--txt-3)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  playIcon: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 16px",
    background: "var(--bg-3)",
    border: "1px solid var(--line-2)",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 600,
    color: "var(--txt-0)",
    flexShrink: 0,
  },
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 999,
    background: "rgba(0,0,0,0.7)",
    backdropFilter: "blur(6px)",
    WebkitBackdropFilter: "blur(6px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  dialog: {
    width: "min(880px, 100%)",
    background: "var(--bg-1)",
    border: "1px solid var(--line-2)",
    borderRadius: 14,
    overflow: "hidden",
    boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
  },
  dialogHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "12px 14px",
    borderBottom: "1px solid var(--line)",
  },
  dialogTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: "var(--txt-0)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  dialogSub: {
    fontSize: 11.5,
    color: "var(--txt-3)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    marginTop: 2,
  },
  headActions: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexShrink: 0,
  },
  creditsControl: {
    display: "flex",
    alignItems: "center",
    gap: 7,
  },
  creditsLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.03em",
    textTransform: "uppercase",
    color: "var(--txt-3)",
    whiteSpace: "nowrap",
  },
  creditsOnlyHint: {
    fontSize: 11,
    color: "var(--txt-3)",
    whiteSpace: "nowrap",
    padding: "4px 8px",
    borderRadius: 6,
    background: "var(--bg-3)",
    border: "1px solid var(--line)",
  },
  creditsBadge: {
    flexShrink: 0,
    fontSize: 9.5,
    fontWeight: 700,
    letterSpacing: "0.04em",
    padding: "1px 5px",
    borderRadius: 4,
    color: "var(--accent)",
    background: "var(--accent-soft)",
    border: "1px solid color-mix(in srgb, var(--accent) 35%, transparent)",
    lineHeight: 1.6,
  },
  tileTitleRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
  },
  segmented: {
    display: "flex",
    gap: 2,
    padding: 2,
    borderRadius: 8,
    background: "var(--bg-3)",
    border: "1px solid var(--line)",
  },
  closeBtn: {
    display: "grid",
    placeItems: "center",
    width: 32,
    height: 32,
    borderRadius: 8,
    border: "1px solid var(--line)",
    background: "var(--bg-2)",
    color: "var(--txt-1)",
    cursor: "pointer",
    flexShrink: 0,
  },
  video: {
    display: "block",
    width: "100%",
    maxHeight: "70vh",
    background: "#000",
    aspectRatio: "16 / 9",
  },
};
