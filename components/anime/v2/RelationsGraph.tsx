import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import dagre from "@dagrejs/dagre";
import { Edge } from "types/info/AnilistInfoTypes";
import type { SeasonEntry } from "@/lib/anilist/seasonChain";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { animeHref, useClickTarget } from "@/lib/prefs/clickTarget";
import { useTranslation } from "react-i18next";
import { useSession } from "next-auth/react";
import { getUserList, type UserListEntry } from "@/lib/anilist/userListCache";

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
const NODE_SEP = 50;
const EDGE_SEP = 50;
const RANK_SEP = 120;
const RANKER = "tight-tree";

/** TextNode.svelte is `w-[150px]`; the height follows its two stacked rows. */
const NODE_W = 150;
const NODE_BASE_H = 49;
const NODE_LINE_H = 19;
const CHARS_PER_LINE = 20;
/**
 * With covers on, the art sits to the LEFT of the text and is shown WHOLE — a
 * cover is a 2:3 portrait, and cropping it to a strip cuts the title lettering
 * off the artwork, which is most of what makes one recognisable at a glance.
 * The text column keeps its 150px, so line wrapping is unchanged either way.
 */
const COVER_W = 76;
const COVER_H = 114;
const NODE_W_COVER = NODE_W + COVER_W;
/** Board margin, so the outermost nodes aren't flush against the edge. */
const PAD = 40;

/**
 * Zoom range. The floor used to be 0.35, which on a wide franchise (or with
 * covers on, where a card is half as wide again) stopped well before the whole
 * board fitted — you could see the picture the fit gave you and never pull back
 * from it. Cards are unreadable down there, and that is the point: what you are
 * reading at 0.12 is the SHAPE of the franchise.
 */
const MIN_SCALE = 0.12;
const MAX_SCALE = 2.5;

/**
 * Below this, a left-to-right board is a strip narrower than one card and taller
 * than the screen — the rank axis has to follow the long side of the window, so
 * a phone (and a split-screen desktop) lays the franchise out top-to-bottom.
 */
const VERTICAL_UNDER_PX = 820;

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

/**
 * Relations that do not carry the story forward.
 *
 * "Canon only" drops an entry when NOTHING but these reaches it: a recap of a
 * season you have already seen (SUMMARY / COMPILATION), a parallel retelling
 * (ALTERNATIVE — Progressive), a series about other people (SPIN_OFF — Gun
 * Gale), and AniList's dustbin label (OTHER). An entry that also hangs off a
 * SEQUEL or a SIDE_STORY stays: those are the franchise's own thread.
 *
 * Distinct from "sequels only", which is stricter — it keeps the continuation
 * line and nothing else, side stories included.
 */
const SIDE_RELATIONS = new Set([
  "SUMMARY",
  "COMPILATION",
  "ALTERNATIVE",
  "SPIN_OFF",
  "OTHER",
]);

const nodeHeight = (title: string, withCover: boolean) => {
  const text = NODE_BASE_H + Math.ceil((title.length || 1) / CHARS_PER_LINE) * NODE_LINE_H;
  // Side by side, the card is as tall as the taller column.
  return withCover ? Math.max(COVER_H, text) : text;
};

/**
 * "Finished", the only watch state the board shows.
 *
 * A partial count is the rare case in a franchise — an entry is nearly always
 * either done or never started — and a bar that spends most of its life at 0%
 * or 100% is an interface element earning nothing. So: a tick when it's
 * finished, and nothing at all otherwise.
 *
 * REPEATING counts: you are rewatching something you completed.
 */
const isFinished = (entry: UserListEntry | undefined, episodes: number | null) => {
  if (!entry) return false;
  if (entry.status === "COMPLETED" || entry.status === "REPEATING") return true;
  return !!episodes && entry.progress >= episodes;
};

/** The green the list editor uses for a watched entry (.le-dd-dot-current). */
const DONE_GREEN = "#22c55e";

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
  /** The page already has it; the walk never fetches this node's own payload. */
  currentCover?: string | null;
};

type GNode = {
  id: number;
  title: string;
  format: string;
  episodes: number | null;
  status: string | null;
  cover: string | null;
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
  cover?: string | null;
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
/** Must match MAX_IDS in the batch route, or the tail of a wave is dropped. */
const BATCH_MAX = 30;

/**
 * Material Symbols Outlined, drawn inline.
 *
 * The set the app already uses, at its own weight — pulling the icon font in
 * for six glyphs would cost a webfont on a view most visitors never open, and
 * the paths are the same shapes.
 */
const Icon = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">
    <path d={d} />
  </svg>
);
const ICON = {
  add: "M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z",
  remove: "M200-440v-80h560v80H200Z",
  fitScreen:
    "M80-160v-240h80v160h160v80H80Zm0-400v-240h240v80H160v160H80Zm560 400v-80h160v-160h80v240H640Zm160-400v-160H640v-80h240v240h-80Z",
  fullscreen:
    "M120-120v-200h80v120h120v80H120Zm520 0v-80h120v-120h80v200H640ZM120-640v-200h200v80H200v120h-80Zm640 0v-120H640v-80h200v200h-80Z",
  fullscreenExit:
    "M240-120v-120H120v-80h200v200h-80Zm400 0v-200h200v80H720v120h-80ZM120-640v-80h120v-120h80v200H120Zm520 0v-200h80v120h120v80H640Z",
  refresh:
    "M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z",
  close:
    "m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z",
  check: "M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z",
  search:
    "M784-120 532-372q-30 24-69 38t-83 14q-109 0-184.5-75.5T120-580q0-109 75.5-184.5T380-840q109 0 184.5 75.5T640-580q0 44-14 83t-38 69l252 252-56 56ZM380-420q67 0 113.5-46.5T540-580q0-67-46.5-113.5T380-740q-67 0-113.5 46.5T220-580q0 67 46.5 113.5T380-420Z",
};

const FORMAT_LABEL: Record<string, string> = {
  TV: "TV Series",
  TV_SHORT: "TV Short",
  MOVIE: "Movie",
  SPECIAL: "Special",
  OVA: "OVA",
  ONA: "ONA",
  MUSIC: "Music",
};

/**
 * A chip that opens a checklist of values.
 *
 * Empty selection means "all", which is why there is an explicit "All" row:
 * unticking the last value and "showing everything" are the same state, and
 * without a row to press you can only reach it by unticking one by one.
 */
function FilterMenu({
  label,
  open,
  onToggle,
  options,
  selected,
  onPick,
  onClear,
  allLabel,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  options: { value: string; label: string }[];
  selected: Set<string>;
  onPick: (v: string) => void;
  onClear: () => void;
  allLabel: string;
}) {
  return (
    <div style={gStyles.menuWrap}>
      <button
        type="button"
        onClick={onToggle}
        style={{ ...gStyles.chip, ...(selected.size > 0 ? gStyles.chipOn : null) }}
      >
        {label}
        {selected.size > 0 ? ` · ${selected.size}` : ""} ▾
      </button>
      {open && (
        <div style={gStyles.menu}>
          <button
            type="button"
            onClick={onClear}
            style={{
              ...gStyles.menuItem,
              ...(selected.size === 0 ? gStyles.menuItemOn : null),
            }}
          >
            <span style={gStyles.tick}>{selected.size === 0 ? "✓" : ""}</span>
            {allLabel}
          </button>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => onPick(o.value)}
              style={{
                ...gStyles.menuItem,
                ...(selected.has(o.value) ? gStyles.menuItemOn : null),
              }}
            >
              <span style={gStyles.tick}>{selected.has(o.value) ? "✓" : ""}</span>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function RelationsGraph({
  open,
  onClose,
  relations,
  currentId,
  currentTitle,
  currentFormat,
  currentEpisodes,
  currentCover,
}: Props) {
  const { t } = useTranslation();
  const titlePref = useTitlePref();
  const clickTarget = useClickTarget();
  const { data: session }: any = useSession();

  /** The signed-in viewer's AniList list, for the per-card progress bar. Null
   *  when signed out — the bars simply don't appear. */
  const [listMap, setListMap] = useState<Map<number, UserListEntry> | null>(null);

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

  /**
   * Cards the viewer has moved by hand, as offsets from their dagre position.
   *
   * A layout engine places nineteen cards well on average and badly in one or
   * two spots — a label sitting under a line, two chains crossing where you
   * want to read them. Letting a card be nudged costs one offset per node and
   * leaves the automatic layout intact underneath.
   */
  const [moved, setMoved] = useState<Map<number, { dx: number; dy: number }>>(new Map());
  /** Cards the viewer has dismissed. Cleared by the reset button. */
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  /**
   * Filters. An empty set means "everything". A franchise map is unreadable
   * when you are looking for one thing in it — nineteen cards, five relation
   * kinds — and filtering is the cheapest way to ask a precise question of it.
   */
  const [onlyFormats, setOnlyFormats] = useState<Set<string>>(new Set());
  /**
   * Relation kinds to keep. Empty means "all" — as with formats. This replaced
   * the old "sequels only" switch, which was this same filter with one value
   * hard-coded: asking for side stories, or for everything except recaps, was
   * impossible.
   */
  const [onlyRelations, setOnlyRelations] = useState<Set<string>>(new Set());
  /** Which filter menu is open, if any. */
  const [openMenu, setOpenMenu] = useState<null | "rel" | "fmt">(null);
  /** Hide recaps, retellings and spin-offs — see SIDE_RELATIONS. */
  const [canonOnly, setCanonOnly] = useState(false);
  /** Cover art on the cards, on by default — a franchise is far easier to read
   *  by its art than by twenty near-identical titles. The switch turns the
   *  board back into plain text cards. */
  const [covers, setCovers] = useState(true);
  const [grouped, setGrouped] = useState(true);
  const [isFull, setIsFull] = useState(false);
  const [query, setQuery] = useState("");
  const queryRef = useRef("");
  queryRef.current = query;
  /**
   * The card under the pointer. Deliberately NOT the selection: reading the
   * board means asking "what is this one attached to?" of a dozen cards in a
   * row, and doing that by clicking would renumber the running order every
   * time — you would lose the thread you are trying to follow.
   */
  const [hover, setHover] = useState<number | null>(null);
  /** Rank axis, following the long side of the window. */
  const [rankDir, setRankDir] = useState<"LR" | "TB">("LR");
  const nodeDrag = useRef<{ id: number; x: number; y: number; dx: number; dy: number; moved: boolean } | null>(null);

  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  /** Cleared whenever the board changes size, so the fit runs again. */
  const fittedFor = useRef<string>("");

  // Escape to close + lock page scroll while open (same approach as Artworks).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape backs out one step at a time: it empties the search box before
      // it closes the graph, or typing a query and changing your mind would
      // throw away the whole board. Read through a ref so this effect isn't
      // re-subscribed on every keystroke — it also owns the scroll lock, and
      // re-running it would capture "hidden" as the value to restore.
      if (queryRef.current) {
        setQuery("");
        return;
      }
      onClose();
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
   * The viewer's list, read once per opening from the session-wide cache —
   * usually a map lookup with no network at all, since the info page under this
   * overlay has already paid for it.
   */
  useEffect(() => {
    if (!open) return;
    const userName = session?.user?.name;
    const token = session?.user?.token;
    if (!userName || !token) {
      setListMap(null);
      return;
    }
    let cancelled = false;
    getUserList(userName, token).then((m) => {
      if (!cancelled) setListMap(m);
    });
    return () => {
      cancelled = true;
    };
  }, [open, session]);

  /** Rank axis follows the window: a narrow one gets a top-to-bottom board. */
  useEffect(() => {
    if (!open) return;
    const apply = () => setRankDir(window.innerWidth < VERTICAL_UNDER_PX ? "TB" : "LR");
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [open]);


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

    /**
     * One request per WAVE, not per node.
     *
     * The walk asks for a whole level's relations in one synchronous burst
     * (the prefetch loop below, and the round loop at the end), then awaits
     * them one by one. Registering each id and flushing on the microtask that
     * follows the burst turns that level into a single `?ids=` call — Sword Art
     * Online went from 19 round trips to 3 — while every caller still gets its
     * own promise, so the traversal order is untouched.
     */
    const waiting = new Map<number, (v: any) => void>();
    let flushQueued = false;

    const flush = () => {
      flushQueued = false;
      const wave = Array.from(waiting.entries());
      waiting.clear();
      for (let i = 0; i < wave.length; i += BATCH_MAX) {
        const slice = wave.slice(i, i + BATCH_MAX);
        const ids = slice.map(([id]) => id);
        fetch(`/api/v2/relations/batch?ids=${ids.join(",")}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            const byId = new Map<number, any>();
            for (const item of data?.items || []) byId.set(Number(item?.id), item);
            // An id the route couldn't resolve resolves to null, which the
            // caller already treats as "no relations".
            for (const [id, resolve] of slice) resolve(byId.get(id) ?? null);
          })
          .catch(() => {
            for (const [, resolve] of slice) resolve(null);
          });
      }
    };

    const getRelations = (id: number) => {
      let p = relCache.get(id);
      if (!p) {
        p = new Promise((resolve) => {
          waiting.set(id, resolve);
          if (!flushQueued) {
            flushQueued = true;
            Promise.resolve().then(flush);
          }
        });
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
          cover: data.cover ?? known.cover ?? null,
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
        // The info page's own relation edges carry AniList's `coverImage`
        // object; the API flattens it to `cover`. Normalised here so a card
        // drawn from either source finds its thumbnail in the same place.
        nodes.set(id, {
          ...m,
          cover: m.cover ?? m.coverImage?.large ?? m.coverImage?.extraLarge ?? null,
        });
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
        cover: currentCover ?? null,
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
  }, [open, relations, currentId, currentTitle, currentFormat, currentEpisodes, currentCover]);

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
        cover: m.cover ?? null,
        current: m.id === currentId,
        x: 0,
        y: 0,
        w: covers ? NODE_W_COVER : NODE_W,
        h: nodeHeight(title, covers),
      });
    }

    for (const id of Array.from(hidden)) seen.delete(id);

    /**
     * Canon only — what remains when you walk out from this entry WITHOUT ever
     * crossing a recap, a retelling or a spin-off.
     *
     * Reachability, not a per-node test: Gun Gale Online II is a straight
     * SEQUEL of Gun Gale Online, so judging it on its own edges would keep it
     * while its own first season went. The thread has to be cut at the
     * spin-off, and everything hanging off it goes with it.
     */
    if (canonOnly) {
      const adj = new Map<number, number[]>();
      const link = (a: number, b: number) => {
        if (!adj.has(a)) adj.set(a, []);
        adj.get(a)!.push(b);
      };
      for (const e of tree.edges) {
        if (SIDE_RELATIONS.has(e.label)) continue;
        link(e.from, e.to);
        link(e.to, e.from);
      }
      const keep = new Set<number>([currentId]);
      const stack = [currentId];
      while (stack.length) {
        const cur = stack.pop()!;
        for (const nx of adj.get(cur) || []) {
          if (keep.has(nx)) continue;
          keep.add(nx);
          stack.push(nx);
        }
      }
      for (const n of Array.from(seen.values())) if (!keep.has(n.id)) seen.delete(n.id);
    }

    // Format filter — the current entry always stays, or the board could end
    // up empty with no way back to what you were looking at.
    if (onlyFormats.size > 0) {
      for (const n of Array.from(seen.values())) {
        if (n.id !== currentId && !onlyFormats.has(n.format)) seen.delete(n.id);
      }
    }

    // An edge whose other end was refused by the node cap — or dismissed by
    // the viewer — has nothing to connect to; drawing it would leave a line
    // running off into nothing.
    let list = tree.edges.filter((e) => seen.has(e.from) && seen.has(e.to));
    if (onlyRelations.size > 0) {
      list = list.filter((e) => onlyRelations.has(e.label));
      // Drop whatever the kept relations no longer touch — an entry reachable
      // only through a relation you filtered out has nothing to say here.
      const linked = new Set<number>([currentId]);
      for (const e of list) {
        linked.add(e.from);
        linked.add(e.to);
      }
      for (const n of Array.from(seen.values())) if (!linked.has(n.id)) seen.delete(n.id);
    }

    const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
    g.setGraph({
      rankdir: rankDir,
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
  }, [tree, currentId, titlePref, hidden, onlyFormats, onlyRelations, canonOnly, covers, rankDir]);

  /** Relation kinds actually on this board, for the filter menu — offering
   *  "compilation" on a franchise that has none is noise. */
  const relationKinds = useMemo(() => {
    const s = new Set<string>();
    for (const e of tree.edges) s.add(e.label);
    return Array.from(s).sort();
  }, [tree.edges]);

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


  /** Where a card actually sits: its layout position plus any hand nudge. */
  const posOf = (n: GNode) => {
    const m = moved.get(n.id);
    return { x: n.x + (m?.dx ?? 0), y: n.y + (m?.dy ?? 0) };
  };

  /** Put a card in the middle of the viewport, at the current zoom. */
  const centreOn = (n: GNode) => {
    const box = canvasRef.current;
    if (!box) return;
    const p = posOf(n);
    setOffset({
      x: box.clientWidth / 2 - (p.x + PAD + n.w / 2) * scale,
      y: box.clientHeight / 2 - (p.y + PAD + n.h / 2) * scale,
    });
  };

  /**
   * Titles matching the search box. Null when the box is empty — the board is
   * then in its normal state, with nothing marked.
   */
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return new Set(nodes.filter((n) => n.title.toLowerCase().includes(q)).map((n) => n.id));
  }, [query, nodes]);

  /**
   * Searching a board you cannot see the whole of has to MOVE it: on a big
   * franchise the match is usually off-screen, and marking it in place would
   * leave the viewer typing into a picture that never changes.
   */
  const centredFor = useRef("");
  useEffect(() => {
    if (!open || !matches || matches.size === 0) return;
    // Re-centre when the query changes, not on every node the walk adds.
    const key = query.trim().toLowerCase();
    if (centredFor.current === key) return;
    centredFor.current = key;
    const first = nodes.find((n) => matches.has(n.id));
    if (first) centreOn(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, matches, nodes]);

  /**
   * The hovered card and whatever it touches directly.
   *
   * The one question a franchise map is bad at answering is "what is THIS one
   * attached to" — twenty-three dashed lines cross each other and the eye
   * cannot follow one. Lighting the immediate neighbourhood on hover answers it
   * without a click, so the running order you selected stays where it is.
   */
  const near = useMemo(() => {
    if (hover == null) return null;
    const s = new Set<number>([hover]);
    for (const e of edges) {
      if (e.from === hover) s.add(e.to);
      if (e.to === hover) s.add(e.from);
    }
    return s;
  }, [hover, edges]);


  /**
   * Sub-series, framed.
   *
   * Nineteen cards on one board read as a single cloud: nothing says that
   * Sword Art Offline and its sequels are a run of bonuses on their own, or
   * that the two Progressive films are a parallel adaptation. A branch is
   * simply a connected component over SEQUEL edges — the relation that means
   * "same series, next entry" — so the grouping falls out of the data rather
   * than a hand-kept list. Components of one card are not framed: a lone entry
   * is not a series.
   *
   * This is a reading layer over the existing layout. It moves nothing.
   */
  const groups = useMemo(() => {
    if (!grouped || nodes.length === 0) return [];
    const parent = new Map<number, number>();
    const find = (a: number): number => {
      let r = a;
      while (parent.get(r) !== r) r = parent.get(r) ?? r;
      return r;
    };
    for (const n of nodes) parent.set(n.id, n.id);
    for (const e of edges) {
      if (e.label !== "SEQUEL") continue;
      const a = find(e.from);
      const b = find(e.to);
      if (a !== b) parent.set(a, b);
    }
    const byRoot = new Map<number, GNode[]>();
    for (const n of nodes) {
      const r = find(n.id);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r)!.push(n);
    }

    // The name is the longest word-prefix the members share — "Sword Art
    // Offline" for that run — falling back to the first entry's own title.
    const nameOf = (members: GNode[]) => {
      const words = members.map((m) => m.title.split(/\s+/));
      const head: string[] = [];
      for (let i = 0; i < words[0].length; i++) {
        const w = words[0][i];
        if (words.every((ws) => ws[i] === w)) head.push(w);
        else break;
      }
      const joined = head.join(" ").replace(/[\s:\-–—]+$/, "");
      return joined.length >= 4 ? joined : members[0].title;
    };

    const out: { key: number; name: string; main: boolean; x: number; y: number; w: number; h: number }[] = [];
    for (const [root, members] of Array.from(byRoot.entries())) {
      if (members.length < 2) continue;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const m of members) {
        const p = posOf(m);
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x + m.w);
        y1 = Math.max(y1, p.y + m.h);
      }
      const pad = 16;
      out.push({
        key: root,
        name: nameOf(members),
        main: members.some((m) => m.id === currentId),
        x: x0 - pad + PAD,
        y: y0 - pad + PAD,
        w: x1 - x0 + pad * 2,
        h: y1 - y0 + pad * 2,
      });
    }
    return out;
  }, [grouped, nodes, edges, moved, currentId]);

  /** Both ends of an edge, in board coordinates. */
  const endpoints = (e: GEdge) => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) return null;
    const pa = posOf(a);
    const pb = posOf(b);
    // A line leaves the face that points down the rank axis: the right edge
    // when ranks run left-to-right, the bottom edge when they run downwards.
    // Getting this wrong doesn't move a card, it just draws every line through
    // the middle of one.
    if (rankDir === "TB") {
      return {
        x1: pa.x + a.w / 2 + PAD,
        y1: pa.y + a.h + PAD,
        x2: pb.x + b.w / 2 + PAD,
        y2: pb.y + PAD,
      };
    }
    return {
      x1: pa.x + a.w + PAD,
      y1: pa.y + a.h / 2 + PAD,
      x2: pb.x + PAD,
      y2: pb.y + b.h / 2 + PAD,
    };
  };

  /** True when a card should read as background right now. Hover wins over the
   *  running order: it answers the question the viewer just asked. */
  const isDim = (id: number) => (near ? !near.has(id) : chain ? !chain.has(id) : false);

  /** Drag a single card. A drag must not also count as a click. */
  const onNodePointerDown = (e: React.PointerEvent, id: number) => {
    e.stopPropagation();
    const m = moved.get(id);
    nodeDrag.current = {
      id,
      x: e.clientX,
      y: e.clientY,
      dx: m?.dx ?? 0,
      dy: m?.dy ?? 0,
      moved: false,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onNodePointerMove = (e: React.PointerEvent) => {
    const d = nodeDrag.current;
    if (!d) return;
    const dx = (e.clientX - d.x) / scale;
    const dy = (e.clientY - d.y) / scale;
    if (!d.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    d.moved = true;
    setMoved((prev) => {
      const next = new Map(prev);
      next.set(d.id, { dx: d.dx + dx, dy: d.dy + dy });
      return next;
    });
  };
  const onNodePointerUp = (e: React.PointerEvent) => {
    if (nodeDrag.current?.moved) e.preventDefault();
    // Cleared on the next tick so the click handler can still see `moved`.
    const d = nodeDrag.current;
    setTimeout(() => {
      if (nodeDrag.current === d) nodeDrag.current = null;
    }, 0);
  };

  /** Real fullscreen on the overlay — the ⤢ button only re-framed the board. */
  const toggleFullscreen = () => {
    const el = overlayRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    else el.requestFullscreen?.().catch(() => undefined);
  };
  useEffect(() => {
    const onChange = () => {
      setIsFull(!!document.fullscreenElement);
      // The viewport just changed size; let the fit effect run again.
      fittedFor.current = "";
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const zoomBy = (f: number) => setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * f)));
  const fitBoard = () => {
    const box = canvasRef.current;
    if (!box || !width || !height) return;
    const boardW = width + PAD * 2;
    const boardH = height + PAD * 2;
    const next = Math.min(1, box.clientWidth / boardW, box.clientHeight / boardH);
    setScale(next);
    setOffset({
      x: (box.clientWidth - boardW * next) / 2,
      y: (box.clientHeight - boardH * next) / 2,
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    // Touching the board dismisses an open filter menu, the way a menu anywhere
    // else closes when you click past it.
    setOpenMenu(null);
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
    setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * factor)));
  };

  if (!open) return null;
  if (typeof document === "undefined") return null;

  // Portalled to <body>, like OpEdPanel: the graph is a full-screen dialog, and
  // rendered in place it stacks inside the info page, UNDER the site navbar
  // (z-[9999], fixed) — the board's own title and filter chips came out drawn
  // through the menu. A portal plus a z-index above the navbar's is what puts
  // it on top, and keeps any ancestor transform from trapping `position: fixed`.
  return createPortal(
    <div
      ref={overlayRef}
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

        <div style={gStyles.filters}>
          <label style={gStyles.searchBox}>
            <Icon d={ICON.search} size={13} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("anime.graphSearch", { defaultValue: "Search the graph" })}
              style={gStyles.searchInput}
              spellCheck={false}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                style={gStyles.searchClear}
                aria-label={t("anime.graphSearchClear", { defaultValue: "Clear search" })}
              >
                <Icon d={ICON.close} size={11} />
              </button>
            )}
          </label>
          <button
            type="button"
            onClick={() => setCanonOnly((v) => !v)}
            style={{ ...gStyles.chip, ...(canonOnly ? gStyles.chipOn : null) }}
          >
            {t("anime.graphCanonOnly", { defaultValue: "Canon only" })}
          </button>
          {/* The switch reads as the MODE it turns on, so its label has to be
              what you get by pressing it — covers are the default now, and a
              lit chip called "Covers" while covers were already showing said
              nothing. */}
          <button
            type="button"
            onClick={() => setCovers((v) => !v)}
            style={{ ...gStyles.chip, ...(!covers ? gStyles.chipOn : null) }}
          >
            {t("anime.graphCompact", { defaultValue: "Text only" })}
          </button>
          <button
            type="button"
            onClick={() => setGrouped((v) => !v)}
            style={{ ...gStyles.chip, ...(grouped ? gStyles.chipOn : null) }}
          >
            {t("anime.graphGroup", { defaultValue: "Group branches" })}
          </button>

          {/* Two menus rather than a row of chips: eleven of them wrapped onto
              a second line and pushed the board down, and nothing told you
              which chip filtered WHAT — a relation and a format look alike. */}
          <FilterMenu
            label={t("anime.graphRelations", { defaultValue: "Relations" })}
            open={openMenu === "rel"}
            onToggle={() => setOpenMenu((m) => (m === "rel" ? null : "rel"))}
            options={relationKinds.map((r) => ({
              value: r,
              label: r.replace(/_/g, " ").toLowerCase(),
            }))}
            selected={onlyRelations}
            onPick={(v) =>
              setOnlyRelations((prev) => {
                const next = new Set(prev);
                if (next.has(v)) next.delete(v);
                else next.add(v);
                return next;
              })
            }
            onClear={() => setOnlyRelations(new Set())}
            allLabel={t("anime.graphAll", { defaultValue: "All" })}
          />
          <FilterMenu
            label={t("anime.graphFormats", { defaultValue: "Formats" })}
            open={openMenu === "fmt"}
            onToggle={() => setOpenMenu((m) => (m === "fmt" ? null : "fmt"))}
            options={["TV", "TV_SHORT", "MOVIE", "OVA", "SPECIAL", "ONA"].map((f) => ({
              value: f,
              label: FORMAT_LABEL[f] ?? f,
            }))}
            selected={onlyFormats}
            onPick={(v) =>
              setOnlyFormats((prev) => {
                const next = new Set(prev);
                if (next.has(v)) next.delete(v);
                else next.add(v);
                return next;
              })
            }
            onClear={() => setOnlyFormats(new Set())}
            allLabel={t("anime.graphAll", { defaultValue: "All" })}
          />
        </div>

        <button
          onClick={onClose}
          aria-label={t("anime.relationsGraphClose", { defaultValue: "Close" })}
          title={t("anime.relationsGraphClose", { defaultValue: "Close" })}
          style={gStyles.closeBtn}
        >
          <Icon d={ICON.close} size={16} />
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
            {/* Branch frames, behind everything: a reading layer, never a
                layout change. */}
            {groups.map((g) => (
              <div
                key={g.key}
                style={{
                  ...gStyles.group,
                  left: g.x,
                  top: g.y,
                  width: g.w,
                  height: g.h,
                  borderColor: g.main ? "rgba(255,59,92,.45)" : "var(--line)",
                }}
              >
                <span
                  style={{
                    ...gStyles.groupName,
                    color: g.main ? "var(--brand-primary, #ff3b5c)" : "var(--txt-3)",
                    borderColor: g.main ? "rgba(255,59,92,.45)" : "var(--line)",
                  }}
                >
                  {g.main ? t("anime.graphMainThread", { defaultValue: "Main thread" }) : g.name}
                </span>
              </div>
            ))}

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
                // Control points run along the rank axis, for the same lazy
                // S-curve the flow library draws — horizontal in LR, vertical
                // in TB.
                const off = Math.max(
                  40,
                  (rankDir === "TB" ? p.y2 - p.y1 : p.x2 - p.x1) / 2
                );
                const d =
                  rankDir === "TB"
                    ? `M ${p.x1} ${p.y1} C ${p.x1} ${p.y1 + off}, ${p.x2} ${p.y2 - off}, ${p.x2} ${p.y2}`
                    : `M ${p.x1} ${p.y1} C ${p.x1 + off} ${p.y1}, ${p.x2 - off} ${p.y2}, ${p.x2} ${p.y2}`;
                const touches = near ? e.from === hover || e.to === hover : null;
                const lit = touches !== null ? touches : isChainEdge(e);
                const dim = touches !== null ? !touches : !!chain && !isChainEdge(e);
                return (
                  <path
                    key={i}
                    d={d}
                    fill="none"
                    // The running order is drawn solid and bright, everything
                    // else stays a faint dashed hint — the eye follows one line
                    // through the board instead of reading twenty-three.
                    stroke={lit ? "var(--brand-primary, #ff3b5c)" : "#4a4a52"}
                    strokeWidth={lit ? 2.4 : 1.5}
                    strokeDasharray={lit ? undefined : "5 5"}
                    opacity={dim ? 0.42 : 1}
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
              const touches = near ? e.from === hover || e.to === hover : null;
              const lit = touches !== null ? touches : isChainEdge(e);
              const dim = touches !== null ? !touches : !!chain && !isChainEdge(e);
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
                    opacity: dim ? 0.5 : 1,
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
              const isMatch = !!matches?.has(n.id);
              const done = isFinished(listMap?.get(n.id), n.episodes);
              return (
                <Link
                  key={n.id}
                  href={animeHref(n.id, clickTarget)}
                  onMouseEnter={() => setHover(n.id)}
                  onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
                  // First click lights the running order from this entry; a
                  // click on the one already lit opens its page. Navigating on
                  // the first click would make the order unreadable — you would
                  // leave the graph every time you tried to follow it.
                  onPointerDown={(ev) => onNodePointerDown(ev, n.id)}
                  onPointerMove={onNodePointerMove}
                  onPointerUp={onNodePointerUp}
                  onClick={(ev) => {
                    // A card that was just dragged must not navigate or select.
                    if (nodeDrag.current?.moved) {
                      ev.preventDefault();
                      ev.stopPropagation();
                      return;
                    }
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
                    left: posOf(n).x + PAD,
                    top: posOf(n).y + PAD,
                    width: n.w,
                    borderColor: isMatch
                      ? "#ffd166"
                      : isSelected
                        ? "var(--brand-primary, #ff3b5c)"
                        : lit
                          ? "rgba(255,59,92,.5)"
                          : "#26262d",
                    color: isSelected ? "var(--brand-primary, #ff3b5c)" : "var(--txt-0)",
                    // Dimming the rest is what makes a chain readable at all:
                    // the board is otherwise a uniform field of nineteen cards.
                    // A search result is never dimmed — it is what you asked for.
                    opacity: isMatch || !isDim(n.id) ? 1 : 0.62,
                    boxShadow: isMatch
                      ? "0 0 0 2px #ffd166"
                      : isSelected
                        ? "0 0 0 1px var(--brand-primary, #ff3b5c)"
                        : undefined,
                  }}
                >
                  {/* `chain` is already 1-based — the selected entry is step 1.
                      Adding one here made the whole order start at 2. */}
                  {lit && <span style={gStyles.stepBadge}>{step}</span>}
                  {/* Dismiss a card you don't care about; the reset button in
                      the control bar brings every dismissed one back. */}
                  <button
                    style={gStyles.nodeClose}
                    onPointerDown={(ev) => ev.stopPropagation()}
                    onClick={(ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                      setHidden((prev) => {
                        const next = new Set(prev);
                        next.add(n.id);
                        return next;
                      });
                    }}
                    aria-label={t("anime.graphHideNode", { defaultValue: "Hide this entry" })}
                    title={t("anime.graphHideNode", { defaultValue: "Hide this entry" })}
                  >
                    <Icon d={ICON.close} size={11} />
                  </button>
                  {covers ? (
                    <div style={{ ...gStyles.nodeRow, minHeight: COVER_H }}>
                      {/* The box is drawn whether or not the art resolved: the
                          layout already reserved its width, so skipping it
                          would shift the text of exactly the cards that came
                          back without a cover. `contain` keeps the whole
                          poster, letterboxed rather than cropped. */}
                      {n.cover ? (
                        // Plain <img>: next/image would want a configured loader
                        // for AniList's CDN and a layout box, and this sits
                        // inside a transformed board at a fixed size.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={n.cover}
                          alt=""
                          loading="lazy"
                          draggable={false}
                          style={gStyles.nodeCover}
                        />
                      ) : (
                        <div style={gStyles.nodeCover} />
                      )}
                      <div style={gStyles.nodeBody}>
                        <div style={{ ...gStyles.nodeTitle, ...gStyles.nodeTitleSide }}>
                          {n.title}
                        </div>
                        <div
                          style={{ ...gStyles.nodeMeta, ...(done ? gStyles.nodeMetaDone : null) }}
                        >
                          <span>{FORMAT_LABEL[n.format] ?? n.format}</span>
                          <span>
                            {n.episodes
                              ? t("preview.episodeCount", { count: n.episodes })
                              : n.status || ""}
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={gStyles.nodeTitle}>{n.title}</div>
                      <div style={{ ...gStyles.nodeMeta, ...(done ? gStyles.nodeMetaDone : null) }}>
                        <span>{FORMAT_LABEL[n.format] ?? n.format}</span>
                        <span>
                          {n.episodes
                            ? t("preview.episodeCount", { count: n.episodes })
                            : n.status || ""}
                        </span>
                      </div>
                    </>
                  )}
                  {/* Finished — the one watch state worth drawing. Bottom-right
                      and inside the card, clear of the step badge and the
                      dismiss cross, which both sit OUTSIDE the top corners. */}
                  {done && (
                    <span
                      style={gStyles.doneBadge}
                      title={t("anime.graphFinished", { defaultValue: "Watched" })}
                    >
                      <Icon d={ICON.check} size={11} />
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        )}

        {/* Zoom, fit, real fullscreen, reset, and a way out. */}
        <div style={gStyles.controls} onPointerDown={(e) => e.stopPropagation()}>
          <button style={gStyles.ctrlBtn} onClick={() => zoomBy(1.2)} aria-label="Zoom +" title="Zoom +">
            <Icon d={ICON.add} />
          </button>
          <button style={gStyles.ctrlBtn} onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom −" title="Zoom −">
            <Icon d={ICON.remove} />
          </button>
          <button
            style={gStyles.ctrlBtn}
            onClick={toggleFullscreen}
            aria-label={t("anime.graphFullscreen", { defaultValue: "Fullscreen" })}
            title={t("anime.graphFullscreen", { defaultValue: "Fullscreen" })}
          >
            <Icon d={isFull ? ICON.fullscreenExit : ICON.fullscreen} />
          </button>
          <button
            style={gStyles.ctrlBtn}
            onClick={() => {
              setMoved(new Map());
              setHidden(new Set());
              fittedFor.current = "";
              fitBoard();
            }}
            aria-label={t("anime.graphReset", { defaultValue: "Reset layout" })}
            title={t("anime.graphReset", { defaultValue: "Reset layout" })}
          >
            <Icon d={ICON.refresh} />
          </button>
        </div>
      </div>
      <div style={gStyles.hint}>
        {t("anime.graphHintOrder", {
          defaultValue:
            "Click a title to light up what follows · click it again to open it · drag to pan, scroll to zoom",
        })}
      </div>
    </div>,
    document.body
  );
}

const gStyles: Record<string, CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "#000",
    // Above the navbar's z-[9999] — see the portal note on the return.
    zIndex: 10000,
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
  title: { fontSize: 15, fontWeight: 700, letterSpacing: "0.02em", whiteSpace: "nowrap" },
  filters: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    justifyContent: "center",
    flex: 1,
  },
  chip: {
    padding: "4px 10px",
    borderRadius: 999,
    border: "1px solid var(--line)",
    background: "var(--bg-2)",
    color: "var(--txt-2)",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
  },
  chipOn: {
    borderColor: "var(--brand-primary, #ff3b5c)",
    color: "var(--brand-primary, #ff3b5c)",
    background: "rgba(255,59,92,.12)",
  },
  menuWrap: { position: "relative" },
  menu: {
    position: "absolute",
    top: "calc(100% + 6px)",
    left: 0,
    minWidth: 150,
    padding: 4,
    borderRadius: 8,
    border: "1px solid var(--line)",
    background: "rgba(16,16,20,.98)",
    boxShadow: "0 10px 24px rgba(0,0,0,.55)",
    // Above the board, which draws its own stacking contexts.
    zIndex: 5,
    display: "flex",
    flexDirection: "column",
    gap: 1,
  },
  menuItem: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    padding: "5px 8px",
    borderRadius: 5,
    border: "none",
    background: "transparent",
    color: "var(--txt-2)",
    fontSize: 11,
    fontWeight: 600,
    textAlign: "left",
    textTransform: "capitalize",
    cursor: "pointer",
  },
  menuItemOn: {
    background: "rgba(255,59,92,.14)",
    color: "var(--brand-primary, #ff3b5c)",
  },
  tick: { width: 10, fontSize: 10, lineHeight: 1 },
  searchBox: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    padding: "3px 8px",
    borderRadius: 999,
    border: "1px solid var(--line)",
    background: "var(--bg-2)",
    color: "var(--txt-3)",
  },
  searchInput: {
    width: 130,
    border: "none",
    outline: "none",
    background: "transparent",
    color: "var(--txt-1)",
    fontSize: 11,
    fontWeight: 600,
  },
  searchClear: {
    display: "grid",
    placeItems: "center",
    border: "none",
    background: "transparent",
    color: "var(--txt-3)",
    cursor: "pointer",
    padding: 0,
  },
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
    // Hayase's board: one flat colour under a dot grid. The grid gives the pan
    // and zoom something to move against — without it, dragging an all-black
    // background reads as nothing happening.
    background: "#000",
    backgroundImage: "radial-gradient(circle, #2a2a30 1px, transparent 1px)",
    backgroundSize: "22px 22px",
    // Dragging the board would otherwise sweep a text selection across every
    // card it crosses, leaving the graph highlighted in blue.
    userSelect: "none",
    WebkitUserSelect: "none",
  },
  /** Zoom / fit / reset, bottom-left, out of the graph's way. */
  controls: {
    position: "absolute",
    left: 14,
    bottom: 14,
    display: "flex",
    gap: 6,
    padding: 5,
    borderRadius: 8,
    background: "rgba(20,20,24,.92)",
    border: "1px solid var(--line)",
    zIndex: 3,
  },
  ctrlBtn: {
    width: 28,
    height: 28,
    display: "grid",
    placeItems: "center",
    borderRadius: 6,
    border: "1px solid var(--line)",
    background: "var(--bg-2)",
    color: "var(--txt-1)",
    cursor: "pointer",
    fontSize: 13,
    lineHeight: 1,
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
  group: {
    position: "absolute",
    border: "1px dashed var(--line)",
    borderRadius: 12,
    background: "rgba(255,255,255,.022)",
    pointerEvents: "none",
    zIndex: 0,
  },
  groupName: {
    position: "absolute",
    top: -9,
    left: 12,
    padding: "1px 8px",
    borderRadius: 999,
    border: "1px solid var(--line)",
    background: "#000",
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  },
  nodeClose: {
    position: "absolute",
    top: -8,
    right: -8,
    width: 18,
    height: 18,
    display: "grid",
    placeItems: "center",
    borderRadius: 9,
    border: "1px solid var(--line)",
    background: "#1e1e1e",
    color: "var(--txt-2)",
    cursor: "pointer",
    padding: 0,
    opacity: 0.55,
  },
  nodeRow: { display: "flex", alignItems: "stretch" },
  nodeCover: {
    display: "block",
    flex: "0 0 auto",
    width: COVER_W,
    height: COVER_H,
    // The whole poster, letterboxed — never cropped. See COVER_W's note.
    objectFit: "contain",
    background: "#0b0b0e",
    borderTopLeftRadius: 2,
    borderBottomLeftRadius: 2,
  },
  nodeBody: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    // Title at the top, format and episode count pinned to the BOTTOM edge —
    // the same place they sit on a text-only card. Centring the pair made the
    // meta line float at a different height on every card, depending on how
    // many lines the title took.
    justifyContent: "space-between",
  },
  /** Beside the art the title is no longer a header band across the top. */
  nodeTitleSide: { background: "transparent", padding: "8px 10px 4px" },
  /** The finished tick, in the bottom-right corner of a card. */
  doneBadge: {
    position: "absolute",
    right: 5,
    bottom: 5,
    width: 17,
    height: 17,
    display: "grid",
    placeItems: "center",
    borderRadius: 9,
    background: DONE_GREEN,
    color: "#06210f",
    boxShadow: "0 1px 4px rgba(0,0,0,.5)",
  },
  /** Room for the tick, so the episode count never slides under it. */
  nodeMetaDone: { paddingRight: 26 },
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
