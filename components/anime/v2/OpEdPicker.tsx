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

/* A season paired with its resolved OP/ED themes (only ones with a playable
   video are kept — the dropdown plays the clip, so a theme with no video is
   useless here). */
type SeasonThemes = {
  season: SeasonEntry;
  themes: Theme[];
};

/**
 * OP / ED dropdown — a SECOND-family picker rendered next to the season and
 * films dropdowns. It reuses the exact season-picker chrome (trigger pill +
 * dropdown menu) but, instead of episodes/films, it lists the anime's openings
 * and endings, grouped by season the same way the season picker groups its
 * entries. Picking one plays the clean (NC) clip in an overlay player.
 *
 * The count line on the trigger shows how many OPs / EDs exist (across every
 * season, since there can be several per season or across the whole show), and
 * the menu breaks them down season-by-season — "Season 1 → OP1, OP2, ED1 …".
 */
export default function OpEdPicker({
  info,
  seasonList,
}: {
  info: AniListInfoTypes;
  /** Franchise seasons (current included). When empty we fall back to just the
   *  current anime as a single "season" so a standalone still gets a dropdown. */
  seasonList: SeasonEntry[];
}) {
  const { t } = useTranslation();
  const titlePref = useTitlePref();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<SeasonThemes[]>([]);
  const [playing, setPlaying] = useState<{
    theme: Theme;
    seasonLabel: string;
  } | null>(null);

  // The seasons we fetch themes for. Multi-season → every season; standalone →
  // a synthetic single entry built from `info` so the code path is uniform.
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

  // Fetch OP/ED themes for every season in parallel. AnimeThemes maps 1:1 on
  // MAL, so we pass idMal when we have it (AniList id is the fallback the route
  // uses on its own). A season absent from AnimeThemes returns [] and is simply
  // dropped from the grouped menu.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all(
      seasons.map((s) =>
        fetch(
          `/api/v2/themes/${s.id}${s.idMal ? `?malId=${s.idMal}` : ""}`,
        )
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
      // Keep only seasons that actually have at least one playable theme.
      setData(results.filter((r) => r.themes.length > 0));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [seasons]);

  // Close on outside click / Escape — identical behaviour to the season picker.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = () => setOpen(false);
    window.addEventListener("keydown", onKey);
    setTimeout(() => window.addEventListener("click", onClick), 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
    };
  }, [open]);

  const { opCount, edCount, total } = useMemo(() => {
    let op = 0;
    let ed = 0;
    for (const g of data) {
      for (const th of g.themes) {
        if (th.kind === "op") op++;
        else ed++;
      }
    }
    return { opCount: op, edCount: ed, total: op + ed };
  }, [data]);

  // While loading, and when the anime genuinely has no themes, render nothing —
  // the dropdown only appears once there's something to show, so the picker
  // group doesn't flash an empty control (mirrors the Films dropdown, which is
  // absent when there are no bonus films).
  if (loading || total === 0) return null;

  // Count line under the header: "3 OP · 2 ED". Uses the pluralised i18n keys.
  const countLine = [
    opCount > 0
      ? t("anime.opCount", { count: opCount, defaultValue: `${opCount} OP` })
      : null,
    edCount > 0
      ? t("anime.edCount", { count: edCount, defaultValue: `${edCount} ED` })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const triggerInner = (
    <>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          gap: 1,
          minWidth: 0,
        }}
      >
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--txt-0)",
            whiteSpace: "nowrap",
          }}
        >
          {t("anime.opEd", { defaultValue: "OP / ED" })}
        </span>
        <span style={{ fontSize: 10.5, color: "var(--txt-3)" }}>
          {countLine}
        </span>
      </div>
      <span className="mono" style={styles.count}>
        {total}
      </span>
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        style={{
          color: "var(--txt-3)",
          transform: open ? "rotate(180deg)" : "none",
          transition: "transform 0.15s",
        }}
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </>
  );

  return (
    <div style={{ ...styles.tabs, position: "relative" }}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        style={{
          ...styles.tab,
          background: "var(--bg-3)",
          borderColor: open ? "var(--accent)" : "var(--line-2)",
          cursor: "pointer",
        }}
      >
        {triggerInner}
      </button>

      {open && (
        <div onClick={(e) => e.stopPropagation()} style={styles.menu}>
          {data.map((g) => {
            const seasonLabel = g.season.label;
            return (
              <div key={String(g.season.id)} style={styles.group}>
                <div style={styles.groupHeader}>{seasonLabel}</div>
                {g.themes.map((th) => (
                  <ThemeRow
                    key={`${g.season.id}-${th.slug}`}
                    theme={th}
                    onPlay={() => {
                      setPlaying({ theme: th, seasonLabel });
                      setOpen(false);
                    }}
                  />
                ))}
              </div>
            );
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

/* One OP/ED row in the menu — kind badge, song title, artists, and (when
   AnimeThemes maps it) the covered episode range. Clicking plays the clip. */
function ThemeRow({
  theme,
  onPlay,
}: {
  theme: Theme;
  onPlay: () => void;
}) {
  const { t } = useTranslation();
  const isOp = theme.kind === "op";
  const kindLabel = theme.slug || (isOp ? "OP" : "ED");
  const artists = theme.artists.join(", ");
  const eps = theme.video?.episodes;

  return (
    <button type="button" onClick={onPlay} style={styles.item}>
      <span
        style={{
          ...styles.kindBadge,
          background: isOp ? "var(--accent-soft)" : "rgba(120,140,255,0.12)",
          color: isOp ? "var(--accent)" : "#8a9bff",
        }}
      >
        {kindLabel}
      </span>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          minWidth: 0,
          flex: 1,
        }}
      >
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--txt-0)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 210,
          }}
        >
          {theme.song || kindLabel}
        </span>
        <span
          style={{
            fontSize: 10.5,
            color: "var(--txt-3)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 210,
          }}
        >
          {[
            artists || null,
            eps ? t("anime.themeEpisodes", { eps, defaultValue: `Ep ${eps}` }) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      {/* Play glyph */}
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="currentColor"
        style={{ color: "var(--txt-2)", marginLeft: "auto", flexShrink: 0 }}
      >
        <polygon points="6 4 20 12 6 20" />
      </svg>
    </button>
  );
}

/* Overlay clip player — a lightweight <video> for the selected NC OP/ED. Kept
   deliberately simple (native controls, autoplay): these are 90-second clips,
   not full episodes, so the full Vidstack chrome would be overkill. Portalled
   to <body> so it sits above the info page regardless of stacking context. */
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
          <button
            type="button"
            onClick={onClose}
            style={styles.closeBtn}
            aria-label="Close"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="6" y1="18" x2="18" y2="6" />
            </svg>
          </button>
        </div>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={videoRef}
          src={theme.video?.url}
          controls
          autoPlay
          playsInline
          style={styles.video}
        />
      </div>
    </div>,
    document.body,
  );
}

/* Chrome mirrors Episodes.tsx's season-picker styles so the OP/ED dropdown is
   visually indistinguishable from the season one (the user asked for exactly
   the same rendering). Kept local to avoid coupling the two files. */
const styles: Record<string, CSSProperties> = {
  tabs: {
    display: "flex",
    gap: 6,
    padding: 4,
    background: "var(--bg-2)",
    border: "1px solid var(--line)",
    borderRadius: 10,
  },
  tab: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "8px 12px",
    border: "1px solid",
    borderRadius: 7,
    transition: "all 0.15s",
  },
  count: {
    fontSize: 10,
    color: "var(--txt-3)",
    letterSpacing: "0.05em",
    padding: "2px 6px",
    background: "var(--bg-0)",
    borderRadius: 4,
  },
  menu: {
    position: "absolute",
    top: "calc(100% + 6px)",
    left: 0,
    minWidth: 280,
    maxHeight: 360,
    overflowY: "auto",
    padding: 6,
    background: "var(--bg-2)",
    border: "1px solid var(--line-2)",
    borderRadius: 10,
    boxShadow: "0 20px 40px rgba(0,0,0,0.5)",
    zIndex: 20,
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  group: {
    display: "flex",
    flexDirection: "column",
    borderRadius: 7,
  },
  groupHeader: {
    fontSize: 12.5,
    fontWeight: 600,
    color: "var(--txt-0)",
    padding: "9px 10px 4px",
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 10px",
    border: "none",
    borderRadius: 7,
    textAlign: "left",
    cursor: "pointer",
    fontFamily: "inherit",
    width: "100%",
    background: "transparent",
  },
  kindBadge: {
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: "0.03em",
    padding: "3px 7px",
    borderRadius: 5,
    flexShrink: 0,
    minWidth: 34,
    textAlign: "center",
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
