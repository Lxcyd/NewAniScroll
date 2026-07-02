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
export default function FilmsPanel({ films }: { films: FilmVariant[] }) {
  const { t, i18n } = useTranslation();

  const movies = films.filter((f) => f.kind !== "compilation");
  const compilations = films.filter((f) => f.kind === "compilation");

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
        <div style={styles.list}>
          {list.map((f, i) => (
            <FilmRow key={String(f.id)} film={f} n={i + 1} locale={i18n.language} />
          ))}
        </div>
      </div>
    );

  return (
    <div>
      {section(
        t("anime.formatFilmsPlural", { count: movies.length, defaultValue: "Films" }),
        movies,
      )}
      {section(
        t("anime.compilations", { defaultValue: "Compilations" }),
        compilations,
        t("anime.compilationsHint", {
          defaultValue: "Recap movies condensing an arc",
        }),
      )}
    </div>
  );
}

function FilmRow({
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

  return (
    <Link href={infoHref(film.id, locale)} style={styles.row}>
      <div style={styles.thumb}>
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={cover}
            alt=""
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
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
        )}
        <div style={styles.thumbScrim} />
      </div>
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

const styles: Record<string, CSSProperties> = {
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
  thumb: {
    position: "relative",
    width: 88,
    height: 70,
    borderRadius: 7,
    overflow: "hidden",
    flexShrink: 0,
    background: "var(--bg-3)",
  },
  thumbScrim: {
    position: "absolute",
    inset: 0,
    background: "linear-gradient(180deg, rgba(0,0,0,0) 55%, rgba(0,0,0,0.35) 100%)",
    pointerEvents: "none",
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
