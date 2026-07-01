import { CSSProperties, ReactNode, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import styles from "./styles.module.css";
import type { SeasonEntry } from "@/lib/anilist/seasonChain";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { useHideSpoilers } from "@/lib/prefs/spoilerPrefs";
import { slugifyTitle } from "./helpers";
import { useTranslation } from "react-i18next";

/** Episode title to display — a neutral "Episode N" when spoilers are hidden. */
function epTitle(ep: { number: number; title: string }, hide: boolean): string {
  return hide ? `Episode ${ep.number}` : ep.title;
}

type EpisodeRow = {
  number: number;
  id: string;
  title: string;
  duration: number | null;
  img: string | null;
};

type ViewMode = "detailed" | "compact" | "grid";

/* Which source the episode panel is showing. "episodes" = one season id.
   "films" = one or more MOVIE ids, concatenated into a single numbered list. */
type ActiveSource =
  | { kind: "episodes"; id: number }
  | { kind: "films"; ids: number[]; labels: string[] };

type Props = {
  info: AniListInfoTypes;
  progress: number;
  /** Other seasons of the same franchise (current included). */
  seasonList?: SeasonEntry[];
};

/* Scroll budget: show roughly N rows in each mode before the box
   starts scrolling. We measure in CSS px so a long-running anime
   (One Piece, 1100+ eps) doesn't blow up the page height. */
const VISIBLE_ROWS = {
  detailed: 6, // big thumb rows are ~90px each → ~540px box
  compact: 12, // small rows are ~44px each → ~530px box
  grid: 12, // 4 cols × 3 rows of ~170px tiles → ~510px box
} as const;

const ROW_HEIGHT = {
  detailed: 90,
  compact: 44,
};

export default function Episodes({ info, progress, seasonList }: Props) {
  const titlePref = useTitlePref();
  const { t } = useTranslation();
  const [eps, setEps] = useState<EpisodeRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDub, setIsDub] = useState(false);
  const [view, setView] = useState<ViewMode>("detailed");
  const [filter, setFilter] = useState("");

  /* Active source — defaults to the current anime's episodes. Switching just
     swaps which AniList id(s) we fetch episodes for; the list re-renders below.
     Each entry's `id` IS an AniList anime id, so /api/v2/episode/<id> works
     without changes.

     Dual-format: a season may be watched as EPISODES (one id) or as FILMS
     (one or more MOVIE ids). In "films" mode we fetch every film id and
     concatenate the results into one panel — "Film 1", "Film 2", … — so the
     two movies read as a single continuous watch order. `activeSeasonId` stays
     the primary id (the first film in films mode) for the child views. */
  const [source, setSource] = useState<ActiveSource>({
    kind: "episodes",
    id: info.id,
  });
  const activeSeasonId =
    source.kind === "episodes" ? source.id : source.ids[0];

  useEffect(() => {
    setSource({ kind: "episodes", id: info.id });
  }, [info.id]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const mapProvider = (payload: any): EpisodeRow[] => {
      if (!Array.isArray(payload)) return [];
      const provider =
        payload.find((p: any) => p?.providerId === "megaplay") || payload[0];
      return (provider?.episodes || []).map((e: any) => ({
        number: e.number,
        id: e.id,
        title: e.title || `${t("common.episode")} ${e.number}`,
        duration: info.duration ?? null,
        img: e.img || null,
      }));
    };

    const epUrl = (id: number, releasing: boolean) =>
      `/api/v2/episode/${id}?releasing=${releasing ? "true" : "false"}${
        isDub ? "&dub=true" : ""
      }`;

    if (source.kind === "films") {
      // Fetch each film, then flatten into one numbered "Film N" list. Every
      // returned entry of a film keeps its film's label; multi-part films still
      // group under the same "Film N" heading.
      Promise.all(
        source.ids.map((id) =>
          fetch(epUrl(id, false))
            .then((r) => r.json())
            .then(mapProvider)
            .catch(() => [] as EpisodeRow[])
        )
      )
        .then((perFilm) => {
          if (cancelled) return;
          const flat: EpisodeRow[] = [];
          perFilm.forEach((rows, fi) => {
            const filmLabel =
              source.labels[fi] ||
              t("anime.formatFilmNumbered", {
                n: fi + 1,
                defaultValue: `Film ${fi + 1}`,
              });
            const multiPart = rows.length > 1;
            rows.forEach((r, ri) => {
              flat.push({
                ...r,
                number: flat.length + 1,
                title: multiPart ? `${filmLabel} · ${r.title}` : filmLabel,
              });
            });
          });
          setEps(flat);
          setLoading(false);
        })
        .catch((e) => {
          if (cancelled) return;
          setError(e?.message || "Failed to load films");
          setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }

    const releasing =
      info.status === "RELEASING" && source.id === info.id;
    fetch(epUrl(source.id, releasing))
      .then((r) => r.json())
      .then((payload: any) => {
        if (cancelled) return;
        if (!Array.isArray(payload)) {
          if (payload?.error) setError(String(payload.error));
          setEps([]);
          setLoading(false);
          return;
        }
        setEps(mapProvider(payload));
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
  }, [source, info.id, info.status, info.duration, isDub, t]);

  const filtered = useMemo(() => {
    if (!eps) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return eps;
    return eps.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        String(e.number).padStart(2, "0").includes(q)
    );
  }, [eps, filter]);

  /* The scroll container's max-height drives "show N at a time". We
     compute it from the row geometry so detailed/compact/grid modes
     each stop at their own N. */
  const maxHeight = useMemo(() => {
    if (view === "detailed") return VISIBLE_ROWS.detailed * ROW_HEIGHT.detailed + 8;
    if (view === "compact") return VISIBLE_ROWS.compact * ROW_HEIGHT.compact + 8;
    // grid mode: roughly 3 rows of ~170px (cover + label)
    return 3 * 175 + 8;
  }, [view]);

  return (
    <div>
      {/* Header row */}
      <div style={tStyles.seasonRow}>
        <SeasonPicker
          info={info}
          eps={eps}
          seasonList={seasonList || []}
          activeSeasonId={activeSeasonId}
          activeKind={source.kind}
          onPickSource={setSource}
        />

        {/* Right side: search + sub/dub + view modes */}
        <div style={tStyles.epActions}>
          {/* Search */}
          <div style={tStyles.searchWrap}>
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              style={{ color: "var(--txt-3)", flexShrink: 0 }}
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("anime.filterEpisodes")}
              style={tStyles.searchInput}
            />
          </div>

          <button
            style={{
              ...tStyles.smallBtn,
              background: isDub ? "var(--accent-soft)" : "var(--bg-2)",
              color: isDub ? "var(--accent)" : "var(--txt-1)",
              borderColor: isDub ? "color-mix(in srgb, var(--accent) 30%, transparent)" : "var(--line)",
            }}
            onClick={() => setIsDub((b) => !b)}
          >
            {isDub ? "Dub" : "Sub"}
          </button>

          {/* View-mode segmented control */}
          <div style={tStyles.viewSwitch}>
            <ViewBtn
              active={view === "detailed"}
              onClick={() => setView("detailed")}
              title={t("anime.detailedView")}
            >
              {/* Picture/image icon — this mode is the one that shows
                  the episode thumbnails, so it earns the photo glyph. */}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <circle cx="8.5" cy="9.5" r="1.5" fill="currentColor" stroke="none" />
                <path d="m4 18 5-5 4 4 3-3 4 4" />
              </svg>
            </ViewBtn>
            <ViewBtn
              active={view === "compact"}
              onClick={() => setView("compact")}
              title={t("anime.compactList")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <line x1="4" y1="6" x2="20" y2="6" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="18" x2="20" y2="18" />
              </svg>
            </ViewBtn>
            <ViewBtn
              active={view === "grid"}
              onClick={() => setView("grid")}
              title={t("anime.gridOfNumbers")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
              </svg>
            </ViewBtn>
          </div>
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
          {t("anime.noEpisodesYet")}
        </div>
      )}

      {!loading && !error && eps && eps.length > 0 && (
        <div
          className={styles.customScroll}
          style={{
            maxHeight,
            overflowY: "auto",
            paddingRight: 4,
            /* Layered scroll fade so the bottom edge hints "more below"
               without occluding the last visible row. */
            background:
              filtered.length > VISIBLE_ROWS[view]
                ? "linear-gradient(to bottom, var(--bg-0) 0%, transparent 30px), linear-gradient(to top, var(--bg-0) 0%, transparent 30px) bottom"
                : undefined,
            backgroundRepeat: "no-repeat",
            backgroundSize: "100% 30px",
            backgroundAttachment: "local, local",
          }}
        >
          {filtered.length === 0 ? (
            <div
              style={{
                padding: 16,
                color: "var(--txt-3)",
                fontSize: 13,
                textAlign: "center",
              }}
            >
              No episode matches “{filter}”.
            </div>
          ) : view === "grid" ? (
            <GridView
              eps={filtered}
              progress={progress}
              info={info}
              isDub={isDub}
              activeAnimeId={activeSeasonId}
              otherSeason={activeSeasonId !== info.id}
            />
          ) : view === "compact" ? (
            <CompactList
              eps={filtered}
              progress={progress}
              info={info}
              isDub={isDub}
              activeAnimeId={activeSeasonId}
              otherSeason={activeSeasonId !== info.id}
            />
          ) : (
            <DetailedList
              eps={filtered}
              progress={progress}
              info={info}
              isDub={isDub}
              activeAnimeId={activeSeasonId}
              otherSeason={activeSeasonId !== info.id}
            />
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* View modes                                                         */
/* ------------------------------------------------------------------ */

type ListProps = {
  eps: EpisodeRow[];
  progress: number;
  info: AniListInfoTypes;
  isDub: boolean;
  /** Forwarded to watchHref so episode links go to the active season's
   *  AniList id rather than the page's own id. */
  activeAnimeId: number;
  /** True when the user picked a different season than the page's own
   *  in the season switcher. */
  otherSeason: boolean;
};

function watchHref(
  info: AniListInfoTypes,
  ep: EpisodeRow,
  isDub: boolean,
  /** When set, navigate to the watch page for this AniList id rather
   *  than info.id — used by the season switcher so clicking an episode
   *  of S2 from the S1 info page sends the user to the right player. */
  overrideAnimeId?: number
) {
  const id = overrideAnimeId ?? info.id;
  // Second path segment is now the human-readable anime slug (was "megaplay").
  // It's cosmetic for routing; the watch page re-canonicalizes it from the
  // loaded metadata, so when an override season is picked the slug self-heals
  // to that season's title on arrival. Falls back to "watch" when unresolved.
  const slug = slugifyTitle(info?.title) || "watch";
  return `/en/anime/watch/${id}/${slug}?id=${ep.id}&num=${ep.number}${
    isDub ? "&dub=true" : ""
  }`;
}

function classifyEp(
  info: AniListInfoTypes,
  ep: EpisodeRow,
  progress: number,
  /** When true, we're viewing another season than the page's own —
   *  `progress` and `info.nextAiringEpisode` belong to the page's
   *  anime, not the season being shown, so we suppress the watched
   *  / current / locked badges to avoid lying to the user. */
  otherSeason: boolean = false
) {
  if (otherSeason) {
    return { watched: false, current: false, locked: false };
  }
  const watched = progress >= ep.number;
  const current = progress === ep.number - 1;
  const locked =
    info.nextAiringEpisode?.episode != null &&
    ep.number >= info.nextAiringEpisode.episode;
  return { watched, current, locked };
}

/* Season picker.
   - Single-season anime → renders the original info pill (title +
     status + EP count), unchanged behaviour.
   - Multi-season anime → renders a clickable pill that opens a
     dropdown listing every sibling season. Picking one swaps which
     anime id we hit /api/v2/episode for, without leaving the page. */
function SeasonPicker({
  info,
  eps,
  seasonList,
  activeSeasonId,
  activeKind,
  onPickSource,
}: {
  info: AniListInfoTypes;
  eps: EpisodeRow[] | null;
  seasonList: SeasonEntry[];
  activeSeasonId: number;
  activeKind: ActiveSource["kind"];
  onPickSource: (s: ActiveSource) => void;
}) {
  const seasonTitlePref = useTitlePref();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // Show the picker when there are multiple seasons OR any season also offers a
  // film variant (dual-format: even a single season becomes two menu rows).
  const filmVariantCount = seasonList.reduce(
    (n, s) => n + (s.variants?.length ?? 0),
    0
  );
  const hasMany = seasonList.length + filmVariantCount > 1;
  const active =
    seasonList.find((s) => s.id === activeSeasonId) || null;

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = () => setOpen(false);
    window.addEventListener("keydown", onKey);
    // capture so we close before the click handler on the trigger
    // re-opens us. Use a microtask to skip the click that opened us.
    setTimeout(() => window.addEventListener("click", onClick), 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
    };
  }, [open]);

  // "Season N" is only meaningful when the franchise actually has multiple
  // seasons. For a single-entry franchise (a standalone anime, or a remake we
  // pulled out of its original's timeline like Gundam Origin), show the anime's
  // TITLE instead of a misleading "Season 1".
  const isMultiSeason = seasonList.length > 1;
  const headerLabel =
    isMultiSeason && active?.label
      ? active.label
      : pickTitle(info.title, seasonTitlePref);
  const headerSub = active
    ? `${active.year ?? ""}${active.episodes ? ` · ${active.episodes} EP` : ""}`.trim()
    : `${info.status === "RELEASING" ? t("status.airing") : t("list.completed")}${
        info.seasonYear ? ` · ${info.seasonYear}` : ""
      }`;

  return (
    <div style={{ ...tStyles.seasonTabs, position: "relative" }}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (hasMany) setOpen((o) => !o);
        }}
        style={{
          ...tStyles.seasonTab,
          background: "var(--bg-3)",
          borderColor: open ? "var(--accent)" : "var(--line-2)",
          cursor: hasMany ? "pointer" : "default",
        }}
      >
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
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: 240,
            }}
          >
            {headerLabel}
          </span>
          <span style={{ fontSize: 10.5, color: "var(--txt-3)" }}>
            {headerSub}
          </span>
        </div>
        <span className="mono" style={tStyles.seasonCount}>
          {eps ? `${eps.length} EP` : "— EP"}
          {info.duration ? ` · ${info.duration}min` : ""}
        </span>
        {hasMany && (
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
        )}
      </button>

      {open && hasMany && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={tStyles.seasonMenu}
        >
          {seasonList.map((s) => {
            const films = s.variants ?? [];
            const grouped = films.length > 0;

            const seasonSub =
              s.status === "NOT_YET_RELEASED"
                ? t("anime.notYetReleased")
                : [s.year, s.episodes ? `${s.episodes} EP` : null]
                    .filter(Boolean)
                    .join(" · ") || (s.format ?? "");

            // Simple case — no films: one flat row per season.
            if (!grouped) {
              const rowActive =
                activeKind === "episodes" && s.id === activeSeasonId;
              return (
                <button
                  key={String(s.id)}
                  type="button"
                  onClick={() => {
                    onPickSource({ kind: "episodes", id: s.id });
                    setOpen(false);
                  }}
                  style={{
                    ...tStyles.seasonMenuItem,
                    background: rowActive ? "var(--accent-soft)" : "transparent",
                    color: rowActive ? "var(--accent)" : "var(--txt-0)",
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>{s.label}</span>
                    <span style={{ fontSize: 10.5, color: "var(--txt-3)" }}>{seasonSub}</span>
                  </div>
                  {rowActive && (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} style={{ marginLeft: "auto" }}>
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              );
            }

            // Dual-format — the season can be watched as EPISODES or as FILMS.
            // Render a season header, then a "Watch in:" block with two radio
            // options tied by an accent bar. Picking "Films" hands ALL film ids
            // to the panel, which concatenates them into "Film 1", "Film 2", …
            const filmIds = films.map((v) => v.id);
            const filmLabels = films.map((v) =>
              v.index
                ? t("anime.formatFilmNumbered", {
                    n: v.index,
                    defaultValue: `Film ${v.index}`,
                  })
                : t("anime.formatFilm", { defaultValue: "Film" })
            );
            const filmYears = films
              .map((v) => v.year)
              .filter(Boolean) as number[];
            const yearPart = filmYears.length
              ? filmYears.length > 1
                ? `${Math.min(...filmYears)}–${Math.max(...filmYears)}`
                : String(filmYears[0])
              : "";
            const countPart = t("anime.filmCount", {
              count: films.length,
              defaultValue: films.length > 1 ? `${films.length} films` : "1 film",
            });
            const filmSub = [yearPart, countPart].filter(Boolean).join(" · ");

            const epsActive =
              activeKind === "episodes" && s.id === activeSeasonId;
            const filmsActive = activeKind === "films";

            const radioRow = (
              key: string,
              on: boolean,
              label: ReactNode,
              sub: string,
              onClick: () => void
            ) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  onClick();
                  setOpen(false);
                }}
                style={{
                  ...tStyles.formatItem,
                  background: on ? "var(--accent-soft)" : "transparent",
                }}
              >
                <span
                  style={{
                    ...tStyles.formatDot,
                    borderColor: on ? "var(--accent)" : "var(--txt-3)",
                    background: on ? "var(--accent)" : "transparent",
                    boxShadow: on ? "0 0 0 2px var(--accent-soft)" : "none",
                  }}
                />
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: on ? 600 : 500,
                    color: on ? "var(--accent)" : "var(--txt-0)",
                  }}
                >
                  {label}
                </span>
                <span style={{ fontSize: 10, color: "var(--txt-3)", marginLeft: "auto" }}>
                  {sub}
                </span>
              </button>
            );

            return (
              <div key={`grp-${s.id}`} style={tStyles.seasonGroup}>
                <div style={tStyles.formatSeasonHeader}>{s.label}</div>
                <div style={tStyles.formatWrap}>
                  <div style={tStyles.formatLabel}>
                    {t("anime.watchIn", { defaultValue: "Watch in" })}
                  </div>
                  {radioRow(
                    `${s.id}-eps`,
                    epsActive,
                    t("anime.formatEpisodes", { defaultValue: "Episodes" }),
                    seasonSub,
                    () => onPickSource({ kind: "episodes", id: s.id })
                  )}
                  {radioRow(
                    `${s.id}-films`,
                    filmsActive,
                    t("anime.formatFilmsPlural", {
                      count: films.length,
                      defaultValue: films.length > 1 ? "Films" : "Film",
                    }),
                    filmSub,
                    () =>
                      onPickSource({
                        kind: "films",
                        ids: filmIds,
                        labels: filmLabels,
                      })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* Thumbnail box with multi-tier fallback chain.
   Priority: ep.img → info.bannerImage → info.coverImage → gradient.
   Each <img> upgrade is gated on `onError` so a 404/blocked image
   silently moves to the next source instead of leaving a broken icon. */
function EpisodeThumb({
  ep,
  info,
  current,
  locked,
}: {
  ep: EpisodeRow;
  info: AniListInfoTypes;
  current: boolean;
  locked: boolean;
}) {
  // Ordered list of URLs to try. Skip duplicates so we don't retry the
  // same broken url twice.
  const sources = useMemo(() => {
    const out: string[] = [];
    const push = (u: string | null | undefined) => {
      if (u && !out.includes(u)) out.push(u);
    };
    push(ep.img);
    push(info.bannerImage);
    push(info.coverImage?.extraLarge);
    push(info.coverImage?.large);
    return out;
  }, [ep.img, info.bannerImage, info.coverImage?.extraLarge, info.coverImage?.large]);

  const [idx, setIdx] = useState(0);
  const src = sources[idx];
  const hideSpoilers = useHideSpoilers();

  return (
    <div style={tStyles.epThumb}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          // Re-key on src so a fresh <img> mounts for each fallback —
          // avoids the previous broken state lingering.
          key={src}
          src={src}
          alt=""
          style={{
            ...tStyles.epThumbBg,
            objectFit: "cover",
            filter: hideSpoilers ? "blur(14px)" : undefined,
          }}
          loading="lazy"
          decoding="async"
          onError={() => setIdx((i) => i + 1)}
        />
      ) : (
        /* All sources exhausted (or none) — show the deterministic
           hue gradient so each tile still has a distinct colour. */
        <div
          style={{
            ...tStyles.epThumbBg,
            background: `linear-gradient(135deg, hsl(${
              (ep.number * 30) % 360
            }, 30%, 18%), hsl(${(ep.number * 30 + 40) % 360}, 40%, 28%))`,
          }}
        />
      )}
      <div style={tStyles.epThumbScrim} />
      <span className="mono" style={tStyles.epThumbN}>
        {String(ep.number).padStart(2, "0")}
      </span>
      {current && (
        <div style={tStyles.epPlayOverlay}>
          <div style={tStyles.epPlayBtn}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
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
            <circle cx="12" cy="12" r="9" />
            <polyline points="12 7 12 12 15 14" />
          </svg>
        </div>
      )}
    </div>
  );
}

/* DETAILED — original card-with-thumb-and-meta row. */
function DetailedList({ eps, progress, info, isDub, activeAnimeId, otherSeason }: ListProps) {
  const { t } = useTranslation();
  const hideSpoilers = useHideSpoilers();
  return (
    <div style={tStyles.epList}>
      {eps.map((ep) => {
        const { watched, current, locked } = classifyEp(info, ep, progress, otherSeason);
        return (
          <Link
            key={ep.number}
            href={locked ? "#" : watchHref(info, ep, isDub, activeAnimeId)}
            style={{
              ...tStyles.epRow,
              opacity: locked ? 0.55 : 1,
              borderColor: current ? "color-mix(in srgb, var(--accent) 40%, transparent)" : "var(--line)",
              background: current
                ? "linear-gradient(90deg, color-mix(in srgb, var(--accent) 6%, transparent), var(--bg-2))"
                : "var(--bg-2)",
              textDecoration: "none",
              color: "inherit",
              pointerEvents: locked ? "none" : "auto",
            }}
          >
            <EpisodeThumb ep={ep} info={info} current={current} locked={locked} />
            <div style={tStyles.epInfo}>
              <div style={tStyles.epHead}>
                <span className="mono" style={tStyles.epNum}>
                  EP {String(ep.number).padStart(2, "0")}
                </span>
                {watched && <span style={tStyles.watchedTag}>✓ {t("anime.watched")}</span>}
                {current && <span style={tStyles.currentTag}>● {t("anime.upNext")}</span>}
              </div>
              <div style={tStyles.epTitle}>{epTitle(ep, hideSpoilers)}</div>
              <div style={tStyles.epMeta}>
                {ep.duration && <span>{ep.duration} min</span>}
                {ep.duration && <span style={tStyles.dotSep} />}
                <span>{isDub ? "Dub" : "Sub"}</span>
              </div>
            </div>
            <span style={{ ...tStyles.epPlay, pointerEvents: "none" }}>
              {locked ? t("anime.notReleased") : current ? t("anime.resume") : watched ? t("anime.replay") : t("anime.play")}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

/* COMPACT — small single-line rows: [number] title  ✓/●  Play */
function CompactList({ eps, progress, info, isDub, activeAnimeId, otherSeason }: ListProps) {
  const hideSpoilers = useHideSpoilers();
  return (
    <div style={tStyles.compactList}>
      {eps.map((ep) => {
        const { watched, current, locked } = classifyEp(info, ep, progress, otherSeason);
        return (
          <Link
            key={ep.number}
            href={locked ? "#" : watchHref(info, ep, isDub, activeAnimeId)}
            style={{
              ...tStyles.compactRow,
              opacity: locked ? 0.55 : 1,
              borderColor: current ? "color-mix(in srgb, var(--accent) 40%, transparent)" : "var(--line)",
              background: current
                ? "linear-gradient(90deg, color-mix(in srgb, var(--accent) 6%, transparent), var(--bg-2))"
                : "var(--bg-2)",
              pointerEvents: locked ? "none" : "auto",
            }}
          >
            <span className="mono" style={tStyles.compactNum}>
              {String(ep.number).padStart(2, "0")}
            </span>
            <span style={tStyles.compactTitle} title={epTitle(ep, hideSpoilers)}>
              {epTitle(ep, hideSpoilers)}
            </span>
            {watched && <span style={tStyles.compactBadge}>✓</span>}
            {current && (
              <span style={{ ...tStyles.compactBadge, color: "var(--accent)" }}>
                ●
              </span>
            )}
            {locked && (
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                style={{ color: "var(--txt-3)" }}
              >
                <circle cx="12" cy="12" r="9" />
            <polyline points="12 7 12 12 15 14" />
              </svg>
            )}
          </Link>
        );
      })}
    </div>
  );
}

/* GRID — number-only tiles, useful for One Piece-sized series. */
function GridView({ eps, progress, info, isDub, activeAnimeId, otherSeason }: ListProps) {
  const hideSpoilers = useHideSpoilers();
  return (
    <div style={tStyles.gridWrap}>
      {eps.map((ep) => {
        const { watched, current, locked } = classifyEp(info, ep, progress, otherSeason);
        return (
          <Link
            key={ep.number}
            href={locked ? "#" : watchHref(info, ep, isDub, activeAnimeId)}
            style={{
              ...tStyles.gridTile,
              opacity: locked ? 0.55 : 1,
              borderColor: current
                ? "var(--accent)"
                : watched
                ? "rgba(45,212,122,0.3)"
                : "var(--line)",
              background: current
                ? "var(--accent-soft)"
                : watched
                ? "rgba(45,212,122,0.06)"
                : "var(--bg-2)",
              color: current
                ? "var(--accent)"
                : watched
                ? "#2dd47a"
                : "var(--txt-0)",
              pointerEvents: locked ? "none" : "auto",
            }}
            title={epTitle(ep, hideSpoilers)}
          >
            {ep.number}
          </Link>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Small components                                                   */
/* ------------------------------------------------------------------ */

function ViewBtn({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        ...tStyles.viewBtn,
        background: active ? "var(--bg-3)" : "transparent",
        color: active ? "var(--txt-0)" : "var(--txt-3)",
      }}
    >
      {children}
    </button>
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
            <div style={{ width: 80, height: 11, background: "var(--bg-3)", borderRadius: 4 }} />
            <div style={{ width: "60%", height: 14, background: "var(--bg-3)", borderRadius: 4 }} />
            <div style={{ width: 120, height: 11, background: "var(--bg-3)", borderRadius: 4 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Styles                                                             */
/* ------------------------------------------------------------------ */

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
  seasonMenu: {
    position: "absolute",
    top: "calc(100% + 6px)",
    left: 0,
    minWidth: 260,
    maxHeight: 320,
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
  seasonMenuItem: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "9px 10px",
    border: "none",
    borderRadius: 7,
    textAlign: "left",
    cursor: "pointer",
    fontFamily: "inherit",
    width: "100%",
    background: "transparent",
  },
  // Dual-format: a season watchable as Episodes OR Films. The two format
  // options sit under a "Watch in" label, tied to the season by an accent bar,
  // so they read as one mutually-exclusive choice (not additive content).
  seasonGroup: {
    display: "flex",
    flexDirection: "column",
    borderRadius: 7,
  },
  formatSeasonHeader: {
    fontSize: 12.5,
    fontWeight: 600,
    color: "var(--txt-0)",
    padding: "9px 10px 2px",
  },
  formatWrap: {
    display: "flex",
    flexDirection: "column",
    borderLeft: "2px solid var(--accent)",
    margin: "0 10px 4px 16px",
    paddingLeft: 2,
  },
  formatLabel: {
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "var(--txt-3)",
    padding: "4px 8px 2px",
  },
  formatItem: {
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "7px 8px",
    border: "none",
    borderRadius: 6,
    textAlign: "left",
    cursor: "pointer",
    fontFamily: "inherit",
    width: "100%",
    background: "transparent",
  },
  formatDot: {
    width: 9,
    height: 9,
    borderRadius: "50%",
    border: "1.5px solid var(--txt-3)",
    flex: "none",
  },
  epActions: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" },
  searchWrap: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    background: "var(--bg-2)",
    border: "1px solid var(--line)",
    borderRadius: 8,
    minWidth: 180,
  },
  searchInput: {
    flex: 1,
    background: "transparent",
    border: "none",
    outline: "none",
    color: "var(--txt-0)",
    fontSize: 12,
    fontFamily: "inherit",
    minWidth: 0,
  },
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
  viewSwitch: {
    display: "flex",
    gap: 2,
    padding: 3,
    background: "var(--bg-2)",
    border: "1px solid var(--line)",
    borderRadius: 8,
  },
  viewBtn: {
    display: "grid",
    placeItems: "center",
    width: 30,
    height: 28,
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
    transition: "all 0.12s",
  },

  /* Detailed view (default) */
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
  epThumbBg: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
  },
  epThumbScrim: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: "55%",
    background:
      "linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.7) 100%)",
    pointerEvents: "none",
  },
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
    background: "color-mix(in srgb, var(--accent) 90%, transparent)",
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
  epTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: "var(--txt-0)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
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

  /* Compact view */
  compactList: { display: "flex", flexDirection: "column", gap: 4 },
  compactRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 12px",
    border: "1px solid",
    borderRadius: 8,
    textDecoration: "none",
    color: "var(--txt-0)",
    minHeight: 40,
    transition: "background 0.12s",
  },
  compactNum: {
    fontSize: 11,
    color: "var(--txt-3)",
    letterSpacing: "0.08em",
    width: 28,
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
  },
  compactBadge: {
    fontSize: 12,
    fontWeight: 600,
    color: "#2dd47a",
    flexShrink: 0,
  },

  /* Grid view */
  gridWrap: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(56px, 1fr))",
    gap: 6,
  },
  gridTile: {
    display: "grid",
    placeItems: "center",
    aspectRatio: "1/1",
    border: "1px solid",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    textDecoration: "none",
    transition: "all 0.12s",
    cursor: "pointer",
  },
};
