import { CSSProperties } from "react";
import Link from "next/link";
import { Edge } from "types/info/AnilistInfoTypes";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import type { SeasonEntry } from "@/lib/anilist/seasonChain";
import styles from "./styles.module.css";
import { useTranslation } from "react-i18next";

type Props = {
  relations: Edge[];
  currentId: number;
  /** Full season chain resolved server-side (walks PREQUEL/SEQUEL across
   *  multiple hops). When provided, every TV-like season in the franchise
   *  shows up — not just the direct neighbours AniList exposes in
   *  `info.relations.edges`. */
  seasonList?: SeasonEntry[];
};

const RELATION_COLORS: Record<string, string> = {
  PREQUEL: "#2dd47a",
  SEQUEL: "#ff3b5c",
  SIDE_STORY: "#4a8fff",
  PARENT: "#b07cff",
  ALTERNATIVE: "#f6c544",
  ADAPTATION: "#b07cff",
  SPIN_OFF: "#4a8fff",
  CHARACTER: "#8a8fa3",
  SUMMARY: "#8a8fa3",
  OTHER: "#8a8fa3",
};

const FORMAT_LABEL: Record<string, string> = {
  TV: "TV",
  TV_SHORT: "TV",
  MOVIE: "MOVIE",
  OVA: "OVA",
  ONA: "ONA",
  SPECIAL: "SP",
  NOVEL: "NOVEL",
  MANGA: "MANGA",
  MANHWA: "MANHWA",
  ONE_SHOT: "ONE-SHOT",
  MUSIC: "MUSIC",
};

export default function Related({ relations, currentId, seasonList }: Props) {
  const { t } = useTranslation();
  const titlePref = useTitlePref();
  // Anime / manga / novels relations only. Drop character / summary noise.
  const KEEP = new Set([
    "PREQUEL",
    "SEQUEL",
    "PARENT",
    "SIDE_STORY",
    "ALTERNATIVE",
    "ADAPTATION",
    "SPIN_OFF",
    "OTHER",
  ]);
  // Sort key: (formatRank, year). All TV seasons land in one chronological
  // run regardless of whether they're tagged sequel, spin-off, or side
  // story — the viewer wants to see every "season" in order first, then
  // movies, then bonus episodes (SP/OVA/ONA), then printed media. The
  // relationType tag stays visible on each card, so the user can still
  // tell at a glance which TV is a direct sequel vs a spin-off.
  //
  // formatRank
  //   0 = TV / TV_SHORT       — full seasons
  //   1 = MOVIE
  //   2 = SPECIAL / OVA / ONA
  //   3 = MUSIC
  //   4 = MANGA / MANHWA / NOVEL / ONE_SHOT
  //
  // year — chronological inside each bucket. Entries without a year
  // (announced-only) sink to the end of their bucket.
  const FORMAT_RANK: Record<string, number> = {
    TV: 0,
    TV_SHORT: 0,
    MOVIE: 1,
    SPECIAL: 2,
    OVA: 2,
    ONA: 2,
    MUSIC: 3,
    MANGA: 4,
    MANHWA: 4,
    NOVEL: 4,
    ONE_SHOT: 4,
  };
  // Start with the direct relations AniList exposes for THIS entry.
  const directEdges = (relations || []).filter((e) => KEEP.has(e.relationType));

  // Promote the full season chain (walked across PREQUEL/SEQUEL hops on
  // the server) into Edge shape so non-direct seasons — e.g. S3, S4 from
  // S1's page — show up alongside the direct edges. We exclude the
  // current entry's own id from the list, then dedup against any season
  // that's ALREADY in directEdges so we don't double-render S2 when it's
  // both a direct sequel AND part of the chain.
  const directIds = new Set(directEdges.map((e) => Number(e.node?.id)));
  const currentEntry = seasonList?.find((s) => s.id === currentId);
  const currentYear = currentEntry?.year ?? null;
  const seasonEdges: Edge[] = (seasonList || [])
    .filter((s) => s.id !== currentId && !directIds.has(s.id))
    .map((s): Edge => {
      // Direction guess: anything aired before the current entry's first
      // air year is a prequel, after is a sequel. Falls back to SEQUEL
      // when years aren't comparable — matches the most common case
      // (current page is S1 → everything walked is downstream).
      const relationType =
        currentYear != null && s.year != null && s.year < currentYear
          ? "PREQUEL"
          : "SEQUEL";
      return {
        id: `season-${s.id}`,
        relationType,
        node: {
          id: s.id,
          type: "ANIME",
          format: s.format || "TV",
          title: (s.title || { romaji: s.label }) as any,
          coverImage: (s.coverImage || {}) as any,
          seasonYear: s.year,
          episodes: s.episodes,
        },
      } as any;
    });

  const nodes = [...directEdges, ...seasonEdges]
    .slice()
    .sort((a, b) => {
      const fA = FORMAT_RANK[a.node.format] ?? 99;
      const fB = FORMAT_RANK[b.node.format] ?? 99;
      if (fA !== fB) return fA - fB;
      const yA = a.node.seasonYear || Number.POSITIVE_INFINITY;
      const yB = b.node.seasonYear || Number.POSITIVE_INFINITY;
      return yA - yB;
    });

  if (nodes.length === 0) {
    return <div style={emptyStyle}>{t("anime.noRelated")}</div>;
  }

  return (
    <div
      // Same scrollbar styling as the Tags / External Sites cards on the
      // same page — `styles.customScroll` opts out of the site-wide hide
      // rule with !important overrides (see styles.module.css). One source
      // of truth means changing scrollbar tokens updates Tags + External
      // Sites + Relations together.
      className={styles.customScroll}
      style={rStyles.row}
    >
      {nodes.map((edge, i) => {
        const n = edge.node;
        const color = RELATION_COLORS[edge.relationType] || "#8a8fa3";
        const isCurrent = n.id === currentId;
        const kindRaw =
          FORMAT_LABEL[n.format] ||
          n.format ||
          (n.type === "MANGA" ? "MANGA" : "ANIME");
        // Only a few format labels differ per-language (FILM/MUSIQUE/ROMAN in
        // FR); the rest (TV/OVA/ONA…) fall through to the English abbreviation.
        const kind = t(`anime.fmt.${n.format}`, { defaultValue: kindRaw });
        const href =
          n.type === "ANIME"
            ? `/en/anime/${n.id}`
            : n.type === "MANGA"
            ? `/en/manga/${n.id}`
            : `/en/anime/${n.id}`;

        const meta = [
          n.type === "ANIME"
            ? t("anime.typeAnime")
            : n.type === "MANGA"
            ? t("anime.typeManga")
            : null,
          n.episodes ? `${n.episodes} ${t("anime.epShort")}` : null,
          n.seasonYear ? String(n.seasonYear) : null,
          t(`anime.rel.${edge.relationType}`, {
            defaultValue: edge.relationType.replace(/_/g, " ").toLowerCase(),
          }),
        ]
          .filter(Boolean)
          .join(" · ");

        return (
          <span key={edge.id} style={{ display: "contents" }}>
            <Link
              href={href}
              style={{
                ...rStyles.card,
                borderColor: isCurrent ? color + "66" : "var(--line)",
                background: isCurrent
                  ? `linear-gradient(160deg, ${color}14, var(--bg-2))`
                  : "var(--bg-2)",
                textDecoration: "none",
                color: "inherit",
              }}
            >
              <div
                style={{
                  ...rStyles.cover,
                  background: n.coverImage?.extraLarge
                    ? "var(--bg-3)"
                    : `linear-gradient(135deg, ${color}33, var(--bg-3))`,
                }}
              >
                {n.coverImage?.extraLarge ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={n.coverImage.extraLarge}
                    alt=""
                    style={{
                      position: "absolute",
                      inset: 0,
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                    }}
                  />
                ) : (
                  <span className="display" style={rStyles.coverGlyph}>
                    {kind}
                  </span>
                )}
                {isCurrent && <span style={rStyles.nowDot} />}
              </div>
              <div style={rStyles.body}>
                <span
                  style={{
                    ...rStyles.tag,
                    color,
                    borderColor: color + "44",
                    background: color + "14",
                  }}
                >
                  {kind}
                </span>
                <div
                  style={rStyles.title}
                  title={pickTitle(n.title, titlePref)}
                >
                  {pickTitle(n.title, titlePref)}
                </div>
                <div style={rStyles.meta}>{meta}</div>
              </div>
            </Link>
            {i < nodes.length - 1 && (
              <div style={rStyles.connector}>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--txt-3)"
                  strokeWidth={2}
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>
            )}
          </span>
        );
      })}
    </div>
  );
}

const emptyStyle: CSSProperties = {
  padding: 16,
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: 10,
  fontSize: 12.5,
  color: "var(--txt-3)",
};

const rStyles: Record<string, CSSProperties> = {
  row: {
    display: "flex",
    /* Stretch so each card fills the parent's vertical band — that
       parent (Overview's grid cell) is sized to match the Details
       card next to it, so Relations ends up the same height. */
    alignItems: "stretch",
    gap: 4,
    /* Horizontal scroll when the franchise has more entries than fit.
       Visual styling for the scrollbar comes from the `cust-scroll`
       Tailwind class on the wrapping div (matches the rest of the
       site: thin track, white/10 thumb, rounded). We just declare
       the overflow + smooth behaviour here. */
    overflowX: "auto",
    overflowY: "hidden",
    scrollBehavior: "smooth",
    WebkitOverflowScrolling: "touch",
    /* Small bottom padding so the thumb doesn't overlap the card's
       bottom edge. `scrollbar-gutter: stable` keeps the row height
       constant whether or not a thumb is currently drawn, so the
       cards don't jump on layout reflow. */
    paddingBottom: 4,
    scrollbarGutter: "stable",
    /* Natural height — works in both layouts. Desktop's grid cell still
       contains us (the cell has no fixed height of its own, it just
       sizes to the natural Details card height next to us). Mobile
       drops us in a normal section so we size to our own content. */
    minHeight: 0,
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    /* Fixed *width*; the row's align-stretch + the cover's flex:1
       below take care of the height so the card matches Details.
       Wider than the original 156 — gives the cover more breathing
       room and balances the visual weight against the Details panel. */
    flex: "0 0 196px",
    width: 196,
    padding: 10,
    border: "1px solid",
    borderRadius: 10,
    transition: "all 0.15s",
    cursor: "pointer",
    /* Let the card take its natural height (cover aspect-ratio +
       body content). Used to be height:100% to match the Details
       card next to it on desktop, but the row now scrolls and we
       want consistent card heights regardless of parent geometry. */
    minHeight: 0,
  },
  cover: {
    position: "relative",
    width: "100%",
    /* Fixed 3:4 aspect ratio. The component is used in two layouts:
       desktop wraps it in a sized grid cell (so the row stretches to
       fill that height), mobile drops it in a natural-flow section
       (so the row sizes to its content). aspectRatio handles both
       without conditional styling. */
    aspectRatio: "3 / 4",
    flex: 1,
    minHeight: 140,
    borderRadius: 7,
    display: "grid",
    placeItems: "center",
    border: "1px solid rgba(255,255,255,0.06)",
    overflow: "hidden",
  },
  coverGlyph: {
    fontSize: 16,
    fontWeight: 700,
    letterSpacing: "0.06em",
    color: "rgba(255,255,255,0.85)",
  },
  nowDot: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 8,
    height: 8,
    borderRadius: 4,
    background: "#ff3b5c",
    boxShadow: "0 0 0 3px rgba(255,59,92,0.3)",
  },
  body: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0 },
  tag: {
    alignSelf: "flex-start",
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: "0.08em",
    padding: "2px 6px",
    border: "1px solid",
    borderRadius: 4,
  },
  title: {
    fontSize: 12.5,
    fontWeight: 600,
    lineHeight: 1.3,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  meta: { fontSize: 10.5, color: "var(--txt-3)" },
  connector: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 18,
  },
};
