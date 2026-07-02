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
type Theme = {
  slug: string;
  kind: "op" | "ed";
  sequence: number;
  song: string | null;
  artists: string[];
  video: {
    url: string;
    nc: boolean;
    resolution: number | null;
    source: string | null;
    episodes: string | null;
  } | null;
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
export default function OpEdPanel({
  data,
  loading,
}: {
  data: SeasonThemes[];
  loading: boolean;
}) {
  const { t } = useTranslation();
  const [playing, setPlaying] = useState<{
    theme: Theme;
    seasonLabel: string;
  } | null>(null);

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
      {data.map((g) => (
        <div key={String(g.season.id)} style={styles.section}>
          <div style={styles.sectionHead}>
            <span style={styles.sectionTitle}>{g.season.label}</span>
            <span style={styles.sectionCount}>{g.themes.length}</span>
          </div>
          <div style={styles.list}>
            {g.themes.map((th) => (
              <ThemeRow
                key={`${g.season.id}-${th.slug}`}
                theme={th}
                onPlay={() => setPlaying({ theme: th, seasonLabel: g.season.label })}
              />
            ))}
          </div>
        </div>
      ))}

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

function ThemeRow({ theme, onPlay }: { theme: Theme; onPlay: () => void }) {
  const { t } = useTranslation();
  const isOp = theme.kind === "op";
  const kindLabel = theme.slug || (isOp ? "OP" : "ED");
  const artists = theme.artists.join(", ");
  const eps = theme.video?.episodes;

  return (
    <button type="button" onClick={onPlay} style={styles.row}>
      <span
        style={{
          ...styles.kindBadge,
          background: isOp ? "var(--accent-soft)" : "rgba(120,140,255,0.12)",
          color: isOp ? "var(--accent)" : "#8a9bff",
        }}
      >
        {kindLabel}
      </span>
      <div style={styles.info}>
        <div style={styles.title}>{theme.song || kindLabel}</div>
        <div style={styles.meta}>
          {[
            artists || null,
            eps ? t("anime.themeEpisodes", { eps, defaultValue: `Ep ${eps}` }) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
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

/* Overlay clip player — native <video> for the selected NC OP/ED (short clips,
   so the full Vidstack chrome would be overkill). Portalled to <body>. */
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  const isOp = theme.kind === "op";
  const kindWord = isOp
    ? t("anime.opening", { defaultValue: "Opening" })
    : t("anime.ending", { defaultValue: "Ending" });

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
          <button type="button" onClick={onClose} style={styles.closeBtn} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="6" y1="18" x2="18" y2="6" />
            </svg>
          </button>
        </div>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video ref={videoRef} src={theme.video?.url} controls autoPlay playsInline style={styles.video} />
      </div>
    </div>,
    document.body,
  );
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
  kindBadge: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.03em",
    padding: "10px 12px",
    borderRadius: 7,
    flexShrink: 0,
    minWidth: 54,
    textAlign: "center",
  },
  info: { flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
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
