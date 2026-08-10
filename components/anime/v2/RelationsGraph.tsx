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
 * Reach: Hayase walks the WHOLE franchise, not two levels. Their
 * `_generateRelationsTree` recurses to depth 2, collects the nodes it had to
 * stop at, re-queries those, and repeats until nothing new appears — the
 * `while (lastEdgeMedia.size)` loop in their anilist client. The depth-2 bound
 * inside one pass is only the shape of their query (which nests relations two
 * levels), not the reach of the walk. Ours does the same breadth-first, one
 * level per round since our endpoint returns one level, and stops on the same
 * condition: no unexpanded node left.
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

/** What a node needs to be drawn — the shape both the prop and the API give. */
type NodeMeta = {
  id: number;
  type?: string | null;
  format?: string | null;
  status?: string | null;
  episodes?: number | null;
  title?: any;
};

/**
 * Walk bounds. Hayase has none — a desktop app can afford to pull a hundred
 * nodes. A franchise like Gundam or Fate is a web of that size, and here every
 * node is an HTTP round trip, so the walk stops rather than crawling forever.
 * Sixty covers every ordinary franchise (Sword Art Online is ~22) and the cap
 * only ever removes the outermost, least relevant entries.
 */
const MAX_NODES = 60;
const MAX_ROUNDS = 8;
/** Frontier fetches in flight at once. */
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
   * The franchise, walked breadth-first from this entry when the graph opens.
   *
   * The info page carries THIS entry's relations, which draws its neighbours
   * but cannot connect them to each other: Sword Art Online stopped at five
   * nodes and never reached Alicization, Gun Gale or Progressive's sequel —
   * most of the franchise. So each node we draw gets expanded in turn, exactly
   * as Hayase does, against an endpoint that caches for a day.
   */
  const [tree, setTree] = useState<{ nodes: NodeMeta[]; edges: GEdge[] }>({
    nodes: [],
    edges: [],
  });

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


  /**
   * The walk. Runs once when the graph opens — not before, since the info page
   * should not pay for a view nobody opened.
   *
   * A port of `_generateRelationsTree`, with its three rules that matter:
   *
   *  - Only ANIME nodes, never a CHARACTER relation. Both are exclusions on the
   *    EDGE, so the manga a series adapts and the unrelated show that happens
   *    to share a voice character never enter the graph — and, crucially, never
   *    get expanded either. Expanding them is what put Alicization and an
   *    Eromanga Sensei OVA on the board as islands: the light novel is the hub
   *    of the whole franchise, so pulling ITS relations dragged in entries
   *    whose only link ran through a node we had (rightly) refused to draw.
   *
   *  - One edge per PAIR, since a relation is reported from both ends, with
   *    PARENT overridable — it means little next to SIDE STORY or ALTERNATIVE.
   *
   *  - PREQUEL is drawn reversed and relabelled SEQUEL, so every chain points
   *    the same way. dagre ranks by edge direction: leave the prequel edges as
   *    they come and a season chain lays itself out backwards.
   */
  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const nodes = new Map<number, NodeMeta>();
    const edges = new Map<string, GEdge>();
    const expanded = new Set<number>();
    const frontier = new Set<number>();

    const addNode = (m: NodeMeta) => {
      const id = Number(m?.id);
      if (!Number.isFinite(id) || id <= 0) return;
      if (nodes.has(id)) return;
      if (nodes.size >= MAX_NODES) return;
      nodes.set(id, m);
      if (!expanded.has(id)) frontier.add(id);
    };

    const processEdges = (fromId: number, list: any[]) => {
      expanded.add(fromId);
      frontier.delete(fromId);
      for (const e of list || []) {
        const node = e?.node;
        if (!node?.id) continue;
        // Absent type means an older cached row; those are anime entries.
        if ((node.type ?? "ANIME") !== "ANIME") continue;
        if (EXCLUDED_RELATIONS.has(e.relationType)) continue;
        const id = Number(node.id);
        addNode(node);
        if (!nodes.has(id)) continue; // refused by the node cap

        const key = [id, fromId].sort((a, b) => a - b).join("-");
        const existing = edges.get(key);
        if (existing && existing.label !== "PARENT") continue;
        const isPrequel = e.relationType === "PREQUEL";
        edges.set(key, {
          from: isPrequel ? id : fromId,
          to: isPrequel ? fromId : id,
          label: isPrequel ? "SEQUEL" : e.relationType || "OTHER",
        });
      }
    };

    const publish = () =>
      setTree({ nodes: Array.from(nodes.values()), edges: Array.from(edges.values()) });

    // The centre, and the relations the page already holds — drawn immediately,
    // so the graph is never blank while the walk runs.
    nodes.set(currentId, {
      id: currentId,
      title: currentTitle,
      format: currentFormat,
      episodes: currentEpisodes,
    });
    processEdges(currentId, relations as any[]);
    publish();

    (async () => {
      for (let round = 0; round < MAX_ROUNDS && frontier.size > 0; round++) {
        const ids = Array.from(frontier);
        for (let i = 0; i < ids.length; i += FETCH_BATCH) {
          if (cancelled) return;
          const results = await Promise.all(
            ids.slice(i, i + FETCH_BATCH).map(async (id) => {
              try {
                const res = await fetch(`/api/v2/relations/${id}`);
                if (!res.ok) return null;
                return await res.json();
              } catch {
                return null;
              }
            }),
          );
          if (cancelled) return;
          for (let k = 0; k < results.length; k++) {
            const id = ids[i + k];
            const data = results[k];
            // A failed fetch still counts as expanded: retrying it next round
            // would spin forever on a permanently missing id.
            if (!data) {
              expanded.add(id);
              frontier.delete(id);
              continue;
            }
            // The fetch carries fuller metadata than the edge did (status,
            // episode count), so let it refine the node we drew from the edge.
            const known = nodes.get(id);
            if (known) {
              nodes.set(id, {
                ...known,
                title: data.title ?? known.title,
                format: data.format ?? known.format,
                status: data.status ?? known.status,
                episodes: data.episodes ?? known.episodes,
              });
            }
            processEdges(id, data.edges);
          }
          publish();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, relations, currentId, currentTitle, currentFormat, currentEpisodes]);

  /** The walked franchise, laid out by dagre. */
  const { nodes, edges, width, height } = useMemo(() => {
    const seen = new Map<number, GNode>();
    for (const m of tree.nodes) {
      const title = pickTitle(m.title, titlePref) || "TBA";
      seen.set(m.id, {
        id: m.id,
        title,
        format: m.format || "TV",
        episodes: m.episodes ?? null,
        status: m.status ?? null,
        current: m.id === currentId,
        x: 0,
        y: 0,
        w: NODE_W,
        h: nodeHeight(title),
      });
    }

    // An edge whose other end was refused by the node cap has nothing to
    // connect to; drawing it would leave a line running off into nothing.
    const list = tree.edges.filter((e) => seen.has(e.from) && seen.has(e.to));

    const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
    g.setGraph({
      rankdir: RANK_DIR,
      edgesep: EDGE_SEP,
      nodesep: NODE_SEP,
      ranksep: RANK_SEP,
      ranker: RANKER,
    });
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
  }, [tree, currentId, titlePref]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  /**
   * Frame the whole board when it changes, the way Hayase calls `fitView`.
   *
   * Without it the graph opens at scale 1 anchored top-left, which for a large
   * franchise means looking at one corner of it and having to hunt for the
   * rest — and the walk delivers its rounds one after another, so the board
   * keeps growing under the viewer. Re-fitting on each size change is what
   * makes that growth read as the picture settling rather than running away.
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
