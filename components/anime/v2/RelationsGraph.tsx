import { CSSProperties, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Edge } from "types/info/AnilistInfoTypes";
import type { SeasonEntry } from "@/lib/anilist/seasonChain";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { animeHref, useClickTarget } from "@/lib/prefs/clickTarget";
import { useTranslation } from "react-i18next";

/**
 * Interactive, pan-with-mouse franchise map.
 *
 * Opened from the "Relations" section. Reuses the SAME data the info page
 * already has (info.relations.edges + the server-resolved seasonList) — no new
 * request. Lays the franchise out as a chronological timeline:
 *   • Main row  — the real seasons (seasonList), left→right by air year.
 *   • Side rows — movies / OVA / specials / alternate versions, attached near
 *     their closest season, colour-coded by relationType.
 * The whole board pans on drag and zooms on wheel (lightweight CSS transform —
 * no graph library). Clicking a node navigates to its page.
 */

const RELATION_COLORS: Record<string, string> = {
  PREQUEL: "#2dd47a",
  SEQUEL: "#ff3b5c",
  SIDE_STORY: "#4a8fff",
  PARENT: "#b07cff",
  ALTERNATIVE: "#f6c544",
  ADAPTATION: "#b07cff",
  SPIN_OFF: "#4a8fff",
  OTHER: "#8a8fa3",
};

type GraphNode = {
  id: number;
  title: any;
  format: string;
  year: number | null;
  cover: string | null;
  relationType: string;
  isSeason: boolean; // main-row season vs side entry
};

type Props = {
  open: boolean;
  onClose: () => void;
  relations: Edge[];
  seasonList?: SeasonEntry[];
  currentId: number;
};

const SEASON_FORMATS = new Set(["TV", "TV_SHORT", "ONA"]);

export default function RelationsGraph({
  open,
  onClose,
  relations,
  seasonList,
  currentId,
}: Props) {
  const { t } = useTranslation();
  const titlePref = useTitlePref();
  const clickTarget = useClickTarget();

  // Pan/zoom state.
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Escape to close + lock page scroll while open (same approach as Artworks).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const html = document.documentElement;
    const body = document.body;
    const prev = { htmlOverflow: html.style.overflow, bodyOverflow: body.style.overflow };
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      html.style.overflow = prev.htmlOverflow;
      body.style.overflow = prev.bodyOverflow;
    };
  }, [open, onClose]);

  // Reset view each time the modal opens.
  useEffect(() => {
    if (open) {
      setScale(1);
      setOffset({ x: 0, y: 0 });
    }
  }, [open]);

  if (!open) return null;

  // ── Build nodes from the data we already have ──────────────────────────────
  const seasonNodes: GraphNode[] = (seasonList || [])
    .slice()
    .sort((a, b) => (a.year ?? Infinity) - (b.year ?? Infinity))
    .map((s) => ({
      id: s.id,
      title: s.title || { romaji: s.label },
      format: s.format || "TV",
      year: s.year ?? null,
      cover: s.coverImage?.extraLarge || s.coverImage?.large || null,
      relationType: "SEQUEL",
      isSeason: true,
    }));

  const seasonIds = new Set(seasonNodes.map((n) => n.id));

  const sideNodes: GraphNode[] = (relations || [])
    .filter(
      (e) =>
        e.node?.id != null &&
        !seasonIds.has(Number(e.node.id)) &&
        e.node.type !== "MANGA" &&
        e.relationType !== "CHARACTER" &&
        e.relationType !== "SUMMARY"
    )
    .map((e) => ({
      id: Number(e.node.id),
      title: e.node.title,
      format: e.node.format || "OVA",
      year: e.node.seasonYear ?? null,
      cover: e.node.coverImage?.extraLarge || (e.node.coverImage as any)?.large || null,
      relationType: e.relationType,
      isSeason: SEASON_FORMATS.has(e.node.format || ""),
    }))
    .sort((a, b) => (a.year ?? Infinity) - (b.year ?? Infinity));

  const hasAny = seasonNodes.length + sideNodes.length > 0;

  // ── Pointer handlers (pan + zoom) ──────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent) => {
    // Don't start a pan when the click lands on a node link.
    if ((e.target as HTMLElement).closest("a")) return;
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setOffset({
      x: drag.current.ox + (e.clientX - drag.current.x),
      y: drag.current.oy + (e.clientY - drag.current.y),
    });
  };
  const onPointerUp = () => {
    drag.current = null;
    setDragging(false);
  };
  const onWheel = (e: React.WheelEvent) => {
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setScale((s) => Math.min(2.5, Math.max(0.35, s * factor)));
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("anime.relationsGraphTitle", { defaultValue: "Franchise timeline" })}
      style={gStyles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={gStyles.header}>
        <span style={gStyles.title}>
          {t("anime.relationsGraphTitle", { defaultValue: "Franchise timeline" })}
        </span>
        <button
          onClick={onClose}
          aria-label={t("anime.relationsGraphClose", { defaultValue: "Close" })}
          style={gStyles.closeBtn}
        >
          ✕
        </button>
      </div>

      <div
        style={{ ...gStyles.canvas, cursor: dragging ? "grabbing" : "grab" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onWheel={onWheel}
      >
        {!hasAny ? (
          <div style={gStyles.empty}>{t("anime.noRelated")}</div>
        ) : (
          <div
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              transformOrigin: "0 0",
              padding: 40,
              display: "inline-flex",
              flexDirection: "column",
              gap: 40,
            }}
          >
            {/* Main row — seasons in chronological order */}
            <Row
              label={t("anime.graphSeasons", { defaultValue: "Seasons" })}
              nodes={seasonNodes}
              currentId={currentId}
              titlePref={titlePref}
              clickTarget={clickTarget}
              connected
            />
            {/* Side row — movies / OVA / specials / alternate versions */}
            {sideNodes.length > 0 && (
              <Row
                label={t("anime.graphOther", { defaultValue: "Movies & others" })}
                nodes={sideNodes}
                currentId={currentId}
                titlePref={titlePref}
                clickTarget={clickTarget}
              />
            )}
          </div>
        )}
      </div>
      <div style={gStyles.hint}>
        {t("anime.graphHint", { defaultValue: "Drag to pan · scroll to zoom" })}
      </div>
    </div>
  );
}

function Row({
  label,
  nodes,
  currentId,
  titlePref,
  clickTarget,
  connected,
}: {
  label: string;
  nodes: GraphNode[];
  currentId: number;
  titlePref: any;
  clickTarget: any;
  connected?: boolean;
}) {
  if (nodes.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <span style={gStyles.rowLabel}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
        {nodes.map((n, i) => {
          const color = RELATION_COLORS[n.relationType] || "#8a8fa3";
          const isCurrent = n.id === currentId;
          return (
            <span key={n.id} style={{ display: "flex", alignItems: "center" }}>
              <Link
                href={animeHref(n.id, clickTarget)}
                style={{
                  ...gStyles.node,
                  borderColor: isCurrent ? color : "var(--line)",
                  boxShadow: isCurrent ? `0 0 0 2px ${color}66` : "none",
                }}
              >
                <div style={gStyles.nodeCover}>
                  {n.cover ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={n.cover} alt="" style={gStyles.nodeImg} />
                  ) : (
                    <div style={{ ...gStyles.nodeImg, background: `${color}33` }} />
                  )}
                </div>
                <div style={gStyles.nodeBody}>
                  <span style={{ ...gStyles.nodeTag, color, borderColor: `${color}55` }}>
                    {n.format}
                  </span>
                  <span style={gStyles.nodeTitle} title={pickTitle(n.title, titlePref)}>
                    {pickTitle(n.title, titlePref)}
                  </span>
                  {n.year != null && <span style={gStyles.nodeYear}>{n.year}</span>}
                </div>
              </Link>
              {connected && i < nodes.length - 1 && (
                <div style={gStyles.connector}>
                  <svg width="20" height="12" viewBox="0 0 24 12" stroke="var(--txt-3)" strokeWidth={2} fill="none">
                    <line x1="0" y1="6" x2="20" y2="6" />
                    <polyline points="15 2 21 6 15 10" />
                  </svg>
                </div>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

const gStyles: Record<string, CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.82)",
    backdropFilter: "blur(18px)",
    zIndex: 200,
    display: "flex",
    flexDirection: "column",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 20px",
    borderBottom: "1px solid var(--line)",
  },
  title: { fontSize: 15, fontWeight: 700, letterSpacing: "0.02em" },
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    border: "1px solid var(--line)",
    background: "var(--bg-2)",
    color: "var(--txt-1)",
    cursor: "pointer",
    fontSize: 14,
  },
  canvas: {
    flex: 1,
    overflow: "hidden",
    position: "relative",
    touchAction: "none",
  },
  empty: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    color: "var(--txt-3)",
    fontSize: 13,
  },
  rowLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: "var(--txt-3)",
  },
  node: {
    flex: "0 0 168px",
    width: 168,
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: 8,
    borderRadius: 10,
    border: "1px solid",
    background: "var(--bg-2)",
    textDecoration: "none",
    color: "inherit",
  },
  nodeCover: {
    width: "100%",
    aspectRatio: "3 / 4",
    borderRadius: 6,
    overflow: "hidden",
    background: "var(--bg-3)",
  },
  nodeImg: { width: "100%", height: "100%", objectFit: "cover" },
  nodeBody: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0 },
  nodeTag: {
    alignSelf: "flex-start",
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: "0.06em",
    padding: "1px 5px",
    border: "1px solid",
    borderRadius: 4,
  },
  nodeTitle: {
    fontSize: 12,
    fontWeight: 600,
    lineHeight: 1.3,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  nodeYear: { fontSize: 10.5, color: "var(--txt-3)" },
  connector: { display: "grid", placeItems: "center", width: 24, flexShrink: 0 },
  hint: {
    textAlign: "center",
    padding: "10px",
    fontSize: 11,
    color: "var(--txt-3)",
    borderTop: "1px solid var(--line)",
  },
};
