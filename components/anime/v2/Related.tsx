import { CSSProperties } from "react";
import Link from "next/link";
import { Edge } from "types/info/AnilistInfoTypes";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";

type Props = {
  relations: Edge[];
  currentId: number;
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

export default function Related({ relations, currentId }: Props) {
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
  const nodes = (relations || [])
    .filter((e) => KEEP.has(e.relationType))
    .slice(0, 8);

  if (nodes.length === 0) {
    return <div style={emptyStyle}>No related entries.</div>;
  }

  return (
    <div style={rStyles.row}>
      {nodes.map((edge, i) => {
        const n = edge.node;
        const color = RELATION_COLORS[edge.relationType] || "#8a8fa3";
        const isCurrent = n.id === currentId;
        const kind =
          FORMAT_LABEL[n.format] ||
          n.format ||
          (n.type === "MANGA" ? "MANGA" : "ANIME");
        const href =
          n.type === "ANIME"
            ? `/en/anime/${n.id}`
            : n.type === "MANGA"
            ? `/en/manga/${n.id}`
            : `/en/anime/${n.id}`;

        const meta = [
          n.type === "ANIME" ? "Anime" : n.type === "MANGA" ? "Manga" : null,
          n.episodes ? `${n.episodes} EP` : null,
          n.seasonYear ? String(n.seasonYear) : null,
          edge.relationType.replace(/_/g, " ").toLowerCase(),
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
    /* overflow: visible (no auto): if it were auto, the layout would
       reserve a horizontal scrollbar even when hidden by the global
       CSS, shaving a few px off card height and breaking the baseline
       alignment with Details. The card count is bounded so overflow
       in practice doesn't happen. */
    overflowX: "visible",
    /* No paddingBottom: the parent section already has it, and adding
       it here would push the cards above the Details card's bottom
       edge by 6px. */
    height: "100%",
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
    /* Force the card to fill the row's height. Without this Safari
       and older Chromium leave the card at intrinsic height even
       when the row is align-stretch. */
    height: "100%",
    minHeight: 0,
  },
  cover: {
    position: "relative",
    width: "100%",
    /* Take whatever vertical space the body doesn't need. The 3:4
       ratio still kicks in as a *minimum* via minHeight so very
       short rows don't squash the artwork. */
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
