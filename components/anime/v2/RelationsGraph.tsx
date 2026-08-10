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

/**
 * What counts as a step in the running order. Specials and OVAs are bonuses —
 * Sword Art Online's Extra Edition is a one-hour recap sitting on the sequel
 * edge between seasons 1 and 2, and numbering it as step 2 tells you to watch
 * a recap before season 2. Films stay in: Ordinal Scale and Integral Domain
 * carry the story between seasons.
 */
const MAIN_FORMATS = new Set(["TV", "TV_SHORT", "MOVIE", "ONA"]);

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

  /**
   * The entry whose continuation is lit. Starts on the anime whose page this
   * is — the graph then opens already answering "what comes after this one".
   */
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    if (open) setSelected(currentId);
  }, [open, currentId]);

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
   * The walk — `_generateRelationsTree`, transcribed.
   *
   * Not paraphrased: the ORDER of this traversal decides the picture, so an
   * equivalent-looking rewrite lands somewhere else. Two ends of a relation
   * disagree often (Sword Art Online II calls Fatal Bullet's pilot a PARENT,
   * the pilot calls II an OTHER), and whichever end is visited first sets the
   * arrow's direction — which is what dagre ranks on. A breadth-first version
   * of this produced the same 19 nodes and the same 23 edges with two arrows
   * reversed, and that alone moved a node four columns.
   *
   * Their rules, in their order:
   *
   *  - Only ANIME nodes, never a CHARACTER relation. Both exclusions sit on the
   *    EDGE, so the manga a series adapts and the unrelated show sharing a voice
   *    character never enter the graph — and, crucially, never get expanded
   *    either. Expanding them is what put Alicization and an Eromanga Sensei OVA
   *    on the board as islands: the light novel is the franchise hub, so pulling
   *    ITS relations dragged in entries whose only link ran through a node we
   *    had (rightly) refused to draw.
   *
   *  - One edge per PAIR. A pair already drawn is skipped whole — no second
   *    edge AND no recursion through it — unless it is a PARENT, which is a
   *    broad term worth replacing by any more specific relation that turns up.
   *
   *  - PREQUEL is drawn reversed and relabelled SEQUEL, so chains point one way.
   *
   * Depth 2 ends a pass, not the walk: nodes reached at that limit are queued,
   * re-fetched, and processed as new roots until nothing new appears. Theirs
   * nests two levels per query; ours returns one, so a node at depth 1 fetches
   * its own relations — same tree, same order, one more round trip.
   */
  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const nodes = new Map<number, NodeMeta>();
    const edges = new Map<string, GEdge>();
    const frontier = new Set<number>();
    const relCache = new Map<number, Promise<any>>();

    const getRelations = (id: number) => {
      let p = relCache.get(id);
      if (!p) {
        p = fetch(`/api/v2/relations/${id}`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        relCache.set(id, p);
      }
      return p;
    };

    const isAnime = (m: any) => (m?.type ?? "ANIME") === "ANIME";

    /** A node's own relation edges, and the fuller metadata that comes with them. */
    const edgesOf = async (id: number): Promise<any[]> => {
      if (id === currentId) return (relations as any[]) || [];
      const data = await getRelations(id);
      if (!data) return [];
      const known = nodes.get(id);
      if (known) {
        // The fetch knows more than the edge did — status, episode count.
        nodes.set(id, {
          ...known,
          title: data.title ?? known.title,
          format: data.format ?? known.format,
          status: data.status ?? known.status,
          episodes: data.episodes ?? known.episodes,
        });
      }
      return data.edges || [];
    };

    const processEdges = async (m: any, depth = 0): Promise<void> => {
      if (!m || cancelled) return;
      if (!isAnime(m)) return;
      const id = Number(m.id);
      if (!Number.isFinite(id) || id <= 0) return;

      if (!nodes.has(id)) {
        if (nodes.size >= MAX_NODES) return;
        if (depth >= 2) frontier.add(id);
        nodes.set(id, m);
      }
      if (depth >= 2) return;

      const list = await edgesOf(id);
      if (cancelled) return;

      // Every child we are about to walk into needs its own relations. Asking
      // for them together turns a level of the walk into one wave of requests
      // instead of a queue of them — the traversal order is untouched.
      if (depth + 1 < 2) {
        for (const e of list) {
          const n = e?.node;
          if (n?.id && isAnime(n) && !EXCLUDED_RELATIONS.has(e.relationType)) {
            getRelations(Number(n.id));
          }
        }
      }

      for (const e of list) {
        const node = e?.node;
        if (!node?.id) continue;
        if (!isAnime(node) || EXCLUDED_RELATIONS.has(e.relationType)) continue;
        const nid = Number(node.id);

        const key = [nid, id].sort((a, b) => a - b).join("-");
        const existing = edges.get(key);
        if (existing) {
          if (existing.label === "PARENT") edges.delete(key);
          else continue;
        }
        const isPrequel = e.relationType === "PREQUEL";
        edges.set(key, {
          from: isPrequel ? nid : id,
          to: isPrequel ? id : nid,
          label: isPrequel ? "SEQUEL" : e.relationType || "OTHER",
        });

        await processEdges(node, depth + 1);
        if (cancelled) return;
      }
    };

    const publish = () =>
      setTree({ nodes: Array.from(nodes.values()), edges: Array.from(edges.values()) });

    (async () => {
      await processEdges({
        id: currentId,
        type: "ANIME",
        title: currentTitle,
        format: currentFormat,
        episodes: currentEpisodes,
      });
      if (cancelled) return;
      publish();

      for (let round = 0; round < MAX_ROUNDS && frontier.size > 0; round++) {
        // AniList returns their batched Page in id order; same order here, so
        // the same end of a disputed pair is the one that gets visited first.
        const ids = Array.from(frontier).sort((a, b) => a - b);
        frontier.clear();
        for (const id of ids) getRelations(id);
        for (const id of ids) {
          if (cancelled) return;
          await processEdges(nodes.get(id) ?? { id, type: "ANIME" });
        }
        publish();
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
   * The watch order starting from the selected entry.
   *
   * A franchise map answers "what is related"; it does not answer the question
   * people actually open it with — what do I watch after this. So clicking an
   * entry lights the chain that CONTINUES it and numbers each step, and dims
   * everything else. Only SEQUEL edges count: following every relation from
   * Sword Art Online lights the whole board (nearly everything descends from
   * it) and says nothing, while its sequel chain is exactly the running order.
   *
   * The number is the LONGEST path from the selection, not the shortest, so a
   * work never gets a number lower than something it follows. Sword Art Online
   * II is reachable directly (2 hops) and through Extra Edition (3): it must
   * read 3, or Extra Edition would appear to come after it.
   */
  const chain = useMemo(() => {
    if (!selected || !byId.has(selected)) return null;
    const next = new Map<number, number[]>();
    for (const e of edges) {
      if (e.label !== "SEQUEL") continue;
      if (!next.has(e.from)) next.set(e.from, []);
      next.get(e.from)!.push(e.to);
    }
    const isMain = (id: number) =>
      id === selected || MAIN_FORMATS.has(byId.get(id)?.format || "");

    // Distance in MAIN entries. A special sitting on the chain is walked
    // THROUGH without taking a number — Sword Art Online's sequel edge runs
    // into Extra Edition and on to season 2, and the running order must read
    // 1, 2 across that bridge rather than counting the bonus as a step.
    const dist = new Map<number, number>([[selected, 1]]);
    // Relax until stable. The pass guard is for safety only: AniList
    // occasionally reports a mutual prequel/sequel pair, which would loop.
    for (let pass = 0; pass < nodes.length + 2; pass++) {
      let changed = false;
      for (const [from, tos] of Array.from(next.entries())) {
        const d = dist.get(from);
        if (d === undefined) continue;
        for (const to of tos) {
          const cand = d + (isMain(to) ? 1 : 0);
          if ((dist.get(to) ?? -1) < cand) {
            dist.set(to, cand);
            changed = true;
          }
        }
      }
      if (!changed) break;
    }

    // Only the main line is lit. The bonuses stay on the board, dimmed like
    // every other relation — they are not what you watch next.
    const main = new Map<number, number>();
    for (const [id, d] of Array.from(dist.entries())) if (isMain(id)) main.set(id, d);
    return main.size > 1 ? main : null;
  }, [selected, edges, nodes.length, byId]);

  /**
   * An edge belongs to the running order when it links two lit entries one
   * step apart. An edge ending on a bonus is never lit, even though the walk
   * passed through it — the line has to show the main thread, not its detours.
   */
  const isChainEdge = (e: GEdge) =>
    !!chain &&
    e.label === "SEQUEL" &&
    chain.has(e.from) &&
    chain.has(e.to) &&
    chain.get(e.to) === (chain.get(e.from) ?? -99) + 1;

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
                const lit = isChainEdge(e);
                return (
                  <path
                    key={i}
                    d={`M ${p.x1} ${p.y1} C ${p.x1 + dx} ${p.y1}, ${p.x2 - dx} ${p.y2}, ${p.x2} ${p.y2}`}
                    fill="none"
                    // The running order is drawn solid and bright, everything
                    // else stays a faint dashed hint — the eye follows one line
                    // through the board instead of reading twenty-three.
                    stroke={lit ? "var(--brand-primary, #ff3b5c)" : "#4a4a52"}
                    strokeWidth={lit ? 2.4 : 1.5}
                    strokeDasharray={lit ? undefined : "5 5"}
                    opacity={chain && !lit ? 0.28 : 1}
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
              const lit = isChainEdge(e);
              return (
                <span
                  key={`l${i}`}
                  style={{
                    ...gStyles.edgeLabel,
                    left: (p.x1 + p.x2) / 2,
                    top: (p.y1 + p.y2) / 2,
                    ...(lit
                      ? {
                          color: "var(--brand-primary, #ff3b5c)",
                          borderColor: "var(--brand-primary, #ff3b5c)",
                        }
                      : null),
                    opacity: chain && !lit ? 0.3 : 1,
                  }}
                >
                  {e.label.replace(/_/g, " ")}
                </span>
              );
            })}

            {nodes.map((n) => {
              const step = chain?.get(n.id);
              const lit = step !== undefined;
              const isSelected = n.id === selected;
              return (
                <Link
                  key={n.id}
                  href={animeHref(n.id, clickTarget)}
                  // First click lights the running order from this entry; a
                  // click on the one already lit opens its page. Navigating on
                  // the first click would make the order unreadable — you would
                  // leave the graph every time you tried to follow it.
                  onClick={(ev) => {
                    if (isSelected) return;
                    ev.preventDefault();
                    ev.stopPropagation();
                    setSelected(n.id);
                  }}
                  title={
                    isSelected
                      ? t("anime.graphOpenEntry", { defaultValue: "Open this entry" })
                      : t("anime.graphShowOrder", { defaultValue: "Show what follows" })
                  }
                  style={{
                    ...gStyles.node,
                    left: n.x + PAD,
                    top: n.y + PAD,
                    width: n.w,
                    borderColor: isSelected
                      ? "var(--brand-primary, #ff3b5c)"
                      : lit
                        ? "rgba(255,59,92,.5)"
                        : "#26262d",
                    color: isSelected ? "var(--brand-primary, #ff3b5c)" : "var(--txt-0)",
                    // Dimming the rest is what makes a chain readable at all:
                    // the board is otherwise a uniform field of nineteen cards.
                    opacity: chain && !lit ? 0.28 : 1,
                    boxShadow: isSelected ? "0 0 0 1px var(--brand-primary, #ff3b5c)" : undefined,
                  }}
                >
                  {lit && <span style={gStyles.stepBadge}>{(step ?? 0) + 1}</span>}
                  <div style={gStyles.nodeTitle}>{n.title}</div>
                  <div style={gStyles.nodeMeta}>
                    <span>{FORMAT_LABEL[n.format] ?? n.format}</span>
                    <span>
                      {n.episodes ? t("preview.episodeCount", { count: n.episodes }) : n.status || ""}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
      <div style={gStyles.hint}>
        {t("anime.graphHintOrder", {
          defaultValue:
            "Click a title to light up what follows · click it again to open it · drag to pan, scroll to zoom",
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
  /* TextNode.svelte: 150px wide, bordered, #111 body under a #1e1e1e header. */
  node: {
    position: "absolute",
    display: "block",
    background: "#111",
    border: "1px solid #26262d",
    borderRadius: 3,
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
  /** The running-order number, on the corner of a lit card. */
  stepBadge: {
    position: "absolute",
    top: -8,
    left: -8,
    minWidth: 18,
    height: 18,
    padding: "0 5px",
    borderRadius: 9,
    background: "var(--brand-primary, #ff3b5c)",
    color: "#fff",
    fontSize: 10,
    fontWeight: 800,
    lineHeight: "18px",
    textAlign: "center",
    boxShadow: "0 2px 6px rgba(0,0,0,.55)",
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
