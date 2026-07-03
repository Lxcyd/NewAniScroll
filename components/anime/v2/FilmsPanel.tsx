import { CSSProperties } from "react";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import type { FilmVariant } from "@/lib/anilist/resolveSeason";

/** Locale-aware info-page href for a film id (lands on its Episodes tab, where
 *  the existing MOVIE resolution plays it). Mirrors Episodes.tsx's infoHref. */
function infoHref(id: number, locale: string): string {
  const lang = locale === "fr" ? "fr" : "en";
  return `/${lang}/anime/${id}#episodes`;
}

/**
 * Films panel — the inline content shown when the "Films" tab button is active
 * (it REPLACES the episode list, same as switching seasons). Bonus films are
 * rendered as episode-style rows and split into two labelled sections:
 *
 *   • Films        — genuine standalone movies (AniList SIDE_STORY).
 *   • Compilations — recap movies that condense an arc / season
 *                    (AniList SUMMARY / COMPILATION). Kept apart so a viewer
 *                    isn't surprised by a "film" that's actually re-cut episodes.
 *
 * Each row navigates to that film's own page, where the existing movie path
 * resolves and plays it — no new watch plumbing needed.
 */
type ViewMode = "detailed" | "compact" | "grid";

export default function FilmsPanel({
  films,
  filter = "",
  view = "detailed",
}: {
  films: FilmVariant[];
  /** Free-text query from the shared header search — matches a film's label. */
  filter?: string;
  /** Shared header view mode: detailed cards / compact list / cover grid. */
  view?: ViewMode;
}) {
  const { t, i18n } = useTranslation();

  const q = filter.trim().toLowerCase();
  const matches = (f: FilmVariant) =>
    !q ||
    (f.label ?? "").toLowerCase().includes(q) ||
    String(f.year ?? "").includes(q);
  const movies = films.filter((f) => f.kind !== "compilation" && matches(f));
  const compilations = films.filter((f) => f.kind === "compilation" && matches(f));

  const section = (
    heading: string,
    list: FilmVariant[],
    subtitle?: string,
  ) =>
    list.length === 0 ? null : (
      <div style={styles.section}>
        <div style={styles.sectionHead}>
          <span style={styles.sectionTitle}>{heading}</span>
          <span style={styles.sectionCount}>{list.length}</span>
          {subtitle && <span style={styles.sectionSub}>{subtitle}</span>}
        </div>
        {view === "grid" ? (
          <div style={styles.grid}>
            {list.map((f, i) => (
              <FilmTile key={String(f.id)} film={f} n={i + 1} locale={i18n.language} />
            ))}
          </div>
        ) : (
          <div style={styles.list}>
            {list.map((f, i) => (
              <FilmRow
                key={String(f.id)}
                film={f}
                n={i + 1}
                locale={i18n.language}
                compact={view === "compact"}
              />
            ))}
          </div>
        )}
      </div>
    );

  const empty = movies.length === 0 && compilations.length === 0;

  return (
    <div>
      {/* Compilations lead the panel (recap movies condensing an arc), then the
          genuine standalone films — the user asked to surface recaps first. */}
      {section(
        t("anime.compilations", { defaultValue: "Compilations" }),
        compilations,
        t("anime.compilationsHint", {
          defaultValue: "Recap movies condensing an arc",
        }),
      )}
      {section(
        t("anime.formatFilmsPlural", { count: movies.length, defaultValue: "Films" }),
        movies,
      )}
      {empty && (
        <div style={styles.emptyMatch}>
          {t("anime.noFilmMatch", { defaultValue: "No film matches your search." })}
        </div>
      )}
    </div>
  );
}

/** Label + meta shared by all three view modes. */
function useFilmText(film: FilmVariant) {
  const { t } = useTranslation();
  const label =
    film.label ||
    (film.index
      ? t("anime.formatFilmNumbered", { n: film.index, defaultValue: `Film ${film.index}` })
      : t("anime.formatFilm", { defaultValue: "Film" }));
  const meta = [
    film.duration ? `${film.duration} min` : film.episodes ? `${film.episodes} EP` : null,
    film.year ?? null,
    film.averageScore ? `★ ${(film.averageScore / 10).toFixed(1)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return { label, meta };
}

/* Poster shown WHOLE (object-fit: contain) — a film's cover is a key-art poster;
   cropping it to a strip lost the title/character framing. Box is 2:3. */
function coverEl(cover: string | null, n: number, fit: "contain" | "cover") {
  return cover ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={cover}
      alt=""
      style={{ width: "100%", height: "100%", objectFit: fit }}
      loading="lazy"
      decoding="async"
    />
  ) : (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: `linear-gradient(135deg, hsl(${(n * 40) % 360},30%,18%), hsl(${(n * 40 + 40) % 360},40%,28%))`,
      }}
    />
  );
}

function FilmRow({
  film,
  n,
  locale,
  compact = false,
}: {
  film: FilmVariant;
  n: number;
  locale: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const cover = film.coverImage?.large || film.coverImage?.extraLarge || null;
  const { label, meta } = useFilmText(film);

  // COMPACT — dense single-line row: number · title · meta · chevron.
  if (compact) {
    return (
      <Link href={infoHref(film.id, locale)} style={styles.compactRow}>
        <span className="mono" style={styles.compactNum}>
          {String(n).padStart(2, "0")}
        </span>
        {film.kind === "compilation" && (
          <span style={styles.recapTagSm}>
            {t("anime.compilationTag", { defaultValue: "RECAP" })}
          </span>
        )}
        <span style={styles.compactTitle} title={label}>{label}</span>
        {meta && <span style={styles.compactMeta}>{meta}</span>}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ color: "var(--txt-3)", flexShrink: 0 }}>
          <polygon points="8 5 19 12 8 19" />
        </svg>
      </Link>
    );
  }

  // DETAILED — card with poster + info + play.
  return (
    <Link href={infoHref(film.id, locale)} style={styles.row}>
      <div style={styles.thumb}>{coverEl(cover, n, "contain")}</div>
      <div style={styles.info}>
        <div style={styles.rowHead}>
          <span className="mono" style={styles.num}>
            {String(n).padStart(2, "0")}
          </span>
          {film.kind === "compilation" && (
            <span style={styles.recapTag}>
              {t("anime.compilationTag", { defaultValue: "RECAP" })}
            </span>
          )}
        </div>
        <div style={styles.title}>{label}</div>
        {meta && <div style={styles.meta}>{meta}</div>}
      </div>
      <span style={{ ...styles.play, pointerEvents: "none" }}>
        {t("anime.play", { defaultValue: "Play" })}
      </span>
    </Link>
  );
}

/* GRID — poster tile with the title + meta beneath (recap tag overlaid). */
function FilmTile({
  film,
  n,
  locale,
}: {
  film: FilmVariant;
  n: number;
  locale: string;
}) {
  const { t } = useTranslation();
  const cover = film.coverImage?.large || film.coverImage?.extraLarge || null;
  const { label, meta } = useFilmText(film);
  return (
    <Link href={infoHref(film.id, locale)} style={styles.tile}>
      <div style={styles.tilePoster}>
        {coverEl(cover, n, "cover")}
        {film.kind === "compilation" && (
          <span style={styles.tileRecapTag}>
            {t("anime.compilationTag", { defaultValue: "RECAP" })}
          </span>
        )}
      </div>
      <div style={styles.tileTitle} title={label}>{label}</div>
      {meta && <div style={styles.tileMeta}>{meta}</div>}
    </Link>
  );
}

const styles: Record<string, CSSProperties> = {
  emptyMatch: {
    padding: 16,
    background: "var(--bg-2)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    color: "var(--txt-3)",
    fontSize: 13,
    textAlign: "center",
  },
  section: { marginBottom: 16 },
  sectionHead: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
    padding: "0 2px",
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: "var(--txt-0)",
    letterSpacing: "0.01em",
  },
  sectionCount: {
    fontSize: 10,
    color: "var(--txt-3)",
    padding: "2px 6px",
    background: "var(--bg-2)",
    border: "1px solid var(--line)",
    borderRadius: 4,
  },
  sectionSub: {
    fontSize: 11,
    color: "var(--txt-3)",
    marginLeft: 2,
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
    textDecoration: "none",
    color: "inherit",
    transition: "all 0.15s",
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
    textDecoration: "none",
    color: "inherit",
    minHeight: 40,
    transition: "background 0.12s",
  },
  compactNum: {
    fontSize: 11,
    color: "var(--txt-3)",
    letterSpacing: "0.08em",
    width: 22,
    flexShrink: 0,
    textAlign: "right",
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
  },
  recapTagSm: {
    fontSize: 8.5,
    fontWeight: 700,
    color: "#c9a227",
    padding: "1px 5px",
    background: "rgba(201,162,39,0.12)",
    borderRadius: 3,
    letterSpacing: "0.05em",
    flexShrink: 0,
  },

  /* Cover grid */
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))",
    gap: 12,
  },
  tile: {
    display: "flex",
    flexDirection: "column",
    gap: 5,
    textDecoration: "none",
    color: "inherit",
  },
  tilePoster: {
    position: "relative",
    width: "100%",
    aspectRatio: "2 / 3",
    borderRadius: 8,
    overflow: "hidden",
    background: "var(--bg-3)",
    border: "1px solid var(--line)",
  },
  tileRecapTag: {
    position: "absolute",
    top: 5,
    left: 5,
    fontSize: 8.5,
    fontWeight: 700,
    color: "#fff",
    padding: "2px 5px",
    background: "rgba(201,162,39,0.9)",
    borderRadius: 3,
    letterSpacing: "0.05em",
  },
  tileTitle: {
    fontSize: 12,
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
  thumb: {
    position: "relative",
    width: 62,
    height: 88,
    borderRadius: 7,
    overflow: "hidden",
    flexShrink: 0,
    background: "var(--bg-3)",
    display: "grid",
    placeItems: "center",
  },
  info: { flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
  rowHead: { display: "flex", alignItems: "center", gap: 8 },
  num: { fontSize: 10.5, color: "var(--txt-3)", letterSpacing: "0.08em" },
  recapTag: {
    fontSize: 9,
    fontWeight: 700,
    color: "#c9a227",
    padding: "2px 6px",
    background: "rgba(201,162,39,0.12)",
    borderRadius: 3,
    letterSpacing: "0.06em",
  },
  title: {
    fontSize: 14,
    fontWeight: 600,
    color: "var(--txt-0)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  meta: { fontSize: 11.5, color: "var(--txt-3)" },
  play: {
    padding: "8px 16px",
    background: "var(--bg-3)",
    border: "1px solid var(--line-2)",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 600,
    color: "var(--txt-0)",
    flexShrink: 0,
  },
};
