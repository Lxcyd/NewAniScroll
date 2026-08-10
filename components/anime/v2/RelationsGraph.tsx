import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import dagre from "@dagrejs/dagre";
import { Edge } from "types/info/AnilistInfoTypes";
import type { SeasonEntry } from "@/lib/anilist/seasonChain";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { animeHref, useClickTarget } from "@/lib/prefs/clickTarget";
import { useTranslation } from "react-i18next";

/**
 * Franchise graph — a port of Hayase's relations view.
 *
 * Theirs is `src/lib/components/ui/relations/` in hayase-app/interface:
 * `@dagrejs/dagre` computes the layout, `@xyflow/svelte` draws it, and
 * `TextNode.svelte` is the node. This is the same graph with the same
 * proportions, drawn without the flow library — dagre returns coordinates, and
 * coordinates are all that a few absolutely-positioned divs and one SVG need.
 *
 * What was here before was a timeline: seasons in a row, everything else in a
 * row below, order standing in for relationship. It could not say what a graph
 * says — that Gun Gale is a SPIN OFF rather than a continuation, that
 * Progressive is an ALTERNATIVE of season 1 and not a sequel to anything.
 * Those are the facts you open a franchise map for, and only labelled edges
 * carry them.
 *
 * Faithful except in reach: Hayase walks relations two levels deep, fetching
 * each neighbour's own relations. We draw the level the info page already
 * holds — see the note on depth in the layout memo.
 */

/** Hayase's dagre settings, unchanged — Relations.svelte#getLayoutedElements. */
const RANK_DIR = "LR";
const NODE_SEP = 50;
const EDGE_SEP = 50;
const RANK_SEP = 120;
const RANKER = "tight-tree";

/** TextNode.svelte is `w-[150px]`; the height follows its two stacked rows. */
const NODE_W = 150;
const NODE_BASE_H = 49;
const NODE_LINE_H = 19;
const CHARS_PER_LINE = 20;
/** Board margin, so the outermost nodes aren't flush against the edge. */
const PAD = 40;

/** Hayase's own exclusion: a character is not a work. */
const EXCLUDED_RELATIONS = new Set(["CHARACTER"]);

const nodeHeight = (title: string) =>
  NODE_BASE_H + Math.ceil((title.length || 1) / CHARS_PER_LINE) * NODE_LINE_H;

type Props = {
  open: boolean;
  onClose: () => void;
  relations: Edge[];
  /** Unused by the graph now; kept so the callers' props still typecheck. */
  seasonList?: SeasonEntry[];
  currentId: number;
  currentTitle?: any;
  currentFormat?: string | null;
  currentEpisodes?: number | null;
};

type GNode = {
  id: number;
  title: string;
  format: string;
  episodes: number | null;
  status: string | null;
  current: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
};

type GEdge = { from: number; to: number; label: string };

type ExpandedNode = {
  id: number;
  format: string | null;
  status: string | null;
  episodes: number | null;
  title: any;
  edges: { relationType: string; node: any }[];
};

/** Hayase stops expanding at depth 2; so the fan-out is one level, bounded. */
const MAX_EXPANDED = 24;
/** Parallel fetches. Enough to feel instant, few enough to stay polite. */
const FETCH_BATCH = 6;

const FORMAT_LABEL: Record<string, string> = {
  TV: "TV Series",
  TV_SHORT: "TV Short",
  MOVIE: "Movie",
  SPECIAL: "Special",
  OVA: "OVA",
  ONA: "ONA",
  MUSIC: "Music",
};

export default function RelationsGraph({
  open,
  onClose,
  relations,
  currentId,
  currentTitle,
  currentFormat,
  currentEpisodes,
}: Props) {
  const { t } = useTranslation();
  const titlePref = useTitlePref();
  const clickTarget = useClickTarget();

  /**
   * The second level of the tree, fetched when the graph opens.
   *
   * The info page carries THIS entry's relations, which is enough to draw its
   * neighbours but not to connect them to each other — so Sword Art Online
   * stopped at five nodes and never reached Alicization or Gun Gale, which is
   * most of the franchise. Hayase walks two levels for exactly this reason
   * (`_generateRelationsTree`, depth >= 2 stops expanding), and so do we: one
   * request per neighbour against an endpoint that caches for a day.
   */
  const [expansion, setExpansion] = useState<Map<number, ExpandedNode>>(new Map());

  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  /** Cleared whenever the board changes size, so the fit runs again. */
  const fittedFor = useRef<string>("");

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


  // Pull the neighbours' own relations once the graph is open. Not before: the
  // info page should not pay for a view nobody opened.
  useEffect(() => {
    if (!open) return;
    const ids = (relations || [])
      .map((e: any) => Number(e?.node?.id))
      .filter((id) => Number.isFinite(id) && id > 0)
      .slice(0, MAX_EXPANDED);
    if (ids.length === 0) return;

    let cancelled = false;
    (async () => {
      for (let i = 0; i < ids.length; i += FETCH_BATCH) {
        if (cancelled) return;
        const slice = ids.slice(i, i + FETCH_BATCH);
        const results = await Promise.all(
          slice.map(async (id) => {
            try {
              const res = await fetch(`/api/v2/relations/${id}`);
              if (!res.ok) return null;
              return (await res.json()) as ExpandedNode;
            } catch {
              return null;
            }
          }),
        );
        if (cancelled) return;
        setExpansion((prev) => {
          const next = new Map(prev);
          for (const r of results) if (r?.id) next.set(r.id, r);
          return next;
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, relations]);

  /**
   * Nodes and edges, positioned by dagre.
   *
   * Depth 1 — the centre and its direct relations. Hayase goes to 2, which is
   * what fills their board with a whole franchise, but every node at that level
   * costs an AniList query for ITS relations, and this graph opens from a page
   * that has already paid for its own. Level 1 is free and already answers what
   * the old timeline could not.
   */
  const { nodes, edges, width, height } = useMemo(() => {
    const centreTitle = pickTitle(currentTitle, titlePref) || "";
    const seen = new Map<number, GNode>();
    const list: GEdge[] = [];

    seen.set(currentId, {
      id: currentId,
      title: centreTitle,
      format: currentFormat || "TV",
      episodes: currentEpisodes ?? null,
      status: null,
      current: true,
      x: 0,
      y: 0,
      w: NODE_W,
      h: nodeHeight(centreTitle),
    });

    const addNode = (node: any) => {
      const id = Number(node?.id);
      if (!Number.isFinite(id) || seen.has(id)) return id;
      const title = pickTitle(node.title, titlePref) || "TBA";
      seen.set(id, {
        id,
        title,
        format: node.format || "TV",
        episodes: node.episodes ?? null,
        status: node.status ?? null,
        current: false,
        x: 0,
        y: 0,
        w: NODE_W,
        h: nodeHeight(title),
      });
      return id;
    };

    /*
     * One edge per PAIR, keyed on the sorted ids — the same relation is
     * reported from both ends (A SEQUEL B, B PREQUEL A) and drawing both would
     * double every line. Hayase keys theirs the same way, with one refinement
     * worth keeping: PARENT is the weakest label ("related to", roughly), so a
     * pair that also has a specific relation keeps the specific one.
     */
    const edgeByPair = new Map<string, GEdge>();
    const addEdge = (from: number, to: number, label: string) => {
      if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return;
      const key = [from, to].sort((a, b) => a - b).join("-");
      const existing = edgeByPair.get(key);
      if (existing && existing.label !== "PARENT") return;
      edgeByPair.set(key, { from, to, label: label || "OTHER" });
    };

    const consider = (fromId: number, edge: any) => {
      const node = edge?.node;
      if (!node?.id) return;
      if (node.type && node.type !== "ANIME") return;
      if (EXCLUDED_RELATIONS.has(edge.relationType)) return;
      const id = addNode(node);
      addEdge(fromId, id, edge.relationType);
    };

    for (const e of relations || []) consider(currentId, e);

    // Level two: the neighbours' own relations. Only edges BETWEEN nodes we
    // already know are drawn — otherwise each neighbour would drag in its own
    // unrelated tree and the board would grow without end.
    for (const exp of Array.from(expansion.values())) {
      for (const e of exp.edges || []) {
        const node = e?.node;
        if (!node?.id) continue;
        if (node.type && node.type !== "ANIME") continue;
        if (EXCLUDED_RELATIONS.has(e.relationType)) continue;
        const id = Number(node.id);
        if (!seen.has(id)) {
          // A node one hop further out: draw it, but it is a leaf — we never
          // fetched ITS relations, so nothing hangs off it. This is Hayase's
          // `depth >= 2` boundary.
          addNode(node);
        }
        addEdge(exp.id, id, e.relationType);
      }
    }

    list.push(...Array.from(edgeByPair.values()));

    const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
    g.setGraph({
      rankdir: RANK_DIR,
      edgesep: EDGE_SEP,
      nodesep: NODE_SEP,
      ranksep: RANK_SEP,
      ranker: RANKER,
    });
    // Array.from, not for…of on the iterator: this project's tsconfig targets
    // ES5, where iterating a Map directly needs downlevelIteration.
    const allNodes = Array.from(seen.values());
    for (const n of allNodes) g.setNode(String(n.id), { width: n.w, height: n.h });
    for (const e of list) g.setEdge(String(e.from), String(e.to));
    dagre.layout(g);

    let maxX = 0;
    let maxY = 0;
    for (const n of allNodes) {
      const pos = g.node(String(n.id));
      if (!pos) continue;
      // dagre anchors on the centre; the DOM anchors on the top-left.
      n.x = pos.x - n.w / 2;
      n.y = pos.y - n.h / 2;
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + n.h);
    }

    return { nodes: allNodes, edges: list, width: maxX, height: maxY };
  }, [relations, expansion, currentId, currentTitle, currentFormat, currentEpisodes, titlePref]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  /**
   * Frame the whole board when it changes, the way Hayase calls `fitView`.
   *
   * Without it a two-level graph opens at scale 1 anchored top-left, which for
   * a large franchise means looking at one corner of it and having to hunt for
   * the rest — and the second level arrives a moment after the first, so the
   * board grows under the viewer. Re-fitting on each size change is what makes
   * that growth read as the picture settling rather than running away.
   */
  useEffect(() => {
    if (!open) return;
    const box = canvasRef.current;
    if (!box || width === 0 || height === 0) return;
    const key = `${Math.round(width)}x${Math.round(height)}`;
    if (fittedFor.current === key) return;
    fittedFor.current = key;

    const boardW = width + PAD * 2;
    const boardH = height + PAD * 2;
    const next = Math.min(1, box.clientWidth / boardW, box.clientHeight / boardH);
    setScale(next);
    setOffset({
      x: (box.clientWidth - boardW * next) / 2,
      y: (box.clientHeight - boardH * next) / 2,
    });
  }, [open, width, height]);


  /** Both ends of an edge, in board coordinates. */
  const endpoints = (e: GEdge) => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) return null;
    return {
      x1: a.x + a.w + PAD,
      y1: a.y + a.h / 2 + PAD,
      x2: b.x + PAD,
      y2: b.y + b.h / 2 + PAD,
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
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

  if (!open) return null;

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
        ref={canvasRef}
        style={{ ...gStyles.canvas, cursor: dragging ? "grabbing" : "grab" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onWheel={onWheel}
      >
        {nodes.length <= 1 ? (
          <div style={gStyles.empty}>{t("anime.noRelated")}</div>
        ) : (
          <div
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              transformOrigin: "0 0",
              position: "relative",
              width: width + PAD * 2,
              height: height + PAD * 2,
            }}
          >
            {/* Edges under the nodes, so a line reaching a card disappears
                behind it rather than crossing it. Dashed, like Hayase's. */}
            <svg
              width={width + PAD * 2}
              height={height + PAD * 2}
              style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "visible" }}
            >
              {edges.map((e, i) => {
                const p = endpoints(e);
                if (!p) return null;
                // Left-to-right ranks: lines leave the right edge and arrive at
                // the left one, with horizontal control points for the same
                // lazy S-curve the flow library draws.
                const dx = Math.max(40, (p.x2 - p.x1) / 2);
                return (
                  <path
                    key={i}
                    d={`M ${p.x1} ${p.y1} C ${p.x1 + dx} ${p.y1}, ${p.x2 - dx} ${p.y2}, ${p.x2} ${p.y2}`}
                    fill="none"
                    stroke="#4a4a52"
                    strokeWidth={1.5}
                    strokeDasharray="5 5"
                  />
                );
              })}
            </svg>

            {/* The relation names, on the lines. This is the whole point of the
                view: an unlabelled edge says two things are related, which the
                list already said. */}
            {edges.map((e, i) => {
              const p = endpoints(e);
              if (!p) return null;
              return (
                <span
                  key={`l${i}`}
                  style={{
                    ...gStyles.edgeLabel,
                    left: (p.x1 + p.x2) / 2,
                    top: (p.y1 + p.y2) / 2,
                  }}
                >
                  {e.label.replace(/_/g, " ")}
                </span>
              );
            })}

            {nodes.map((n) => (
              <Link
                key={n.id}
                href={animeHref(n.id, clickTarget)}
                style={{
                  ...gStyles.node,
                  left: n.x + PAD,
                  top: n.y + PAD,
                  width: n.w,
                  borderColor: n.current ? "var(--brand-primary, #ff3b5c)" : "#111",
                  color: n.current ? "var(--brand-primary, #ff3b5c)" : "var(--txt-0)",
                }}
              >
                <div style={gStyles.nodeTitle}>{n.title}</div>
                <div style={gStyles.nodeMeta}>
                  <span>{FORMAT_LABEL[n.format] ?? n.format}</span>
                  <span>
                    {n.episodes ? t("preview.episodeCount", { count: n.episodes }) : n.status || ""}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
      <div style={gStyles.hint}>
        {t("anime.graphHint", { defaultValue: "Drag to pan · scroll to zoom" })}
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
  /* TextNode.svelte: 150px wide, bordered, #111 body under a #1e1e1e header. */
  node: {
    position: "absolute",
    display: "block",
    background: "#111",
    border: "1px solid #111",
    borderRadius: 3,
    overflow: "hidden",
    fontSize: 12,
    fontWeight: 600,
    textAlign: "center",
    textDecoration: "none",
    transition: "border-color .2s ease",
  },
  nodeTitle: {
    background: "#1e1e1e",
    fontWeight: 700,
    padding: "10px 10px 8px",
    lineHeight: 1.25,
  },
  nodeMeta: {
    display: "flex",
    justifyContent: "space-between",
    gap: 6,
    fontSize: 8.5,
    lineHeight: 1,
    padding: "6px 8px",
    color: "var(--txt-2)",
  },
  edgeLabel: {
    position: "absolute",
    transform: "translate(-50%, -50%)",
    background: "#0d0d12",
    border: "1px solid var(--line)",
    borderRadius: 3,
    padding: "2px 5px",
    fontSize: 8.5,
    fontWeight: 700,
    letterSpacing: "0.04em",
    color: "#7ec8ff",
    whiteSpace: "nowrap",
    pointerEvents: "none",
  },
  hint: {
    padding: "10px 0 14px",
    textAlign: "center",
    fontSize: 11,
    color: "var(--txt-3)",
  },
};
