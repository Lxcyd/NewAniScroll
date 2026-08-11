import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
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
/**
 * Space across the ranks — between two cards of the same column, and between a
 * card and an edge passing through that column.
 *
 * Hayase's 50 assumed their own routing: dagre returns a polyline that bends
 * around the cards in the way, and we throw it away, drawing a straight curve
 * from one card's edge to the other's. A relation that skips a rank therefore
 * cuts straight across the column in between, and at 50 it grazed the top of
 * whatever sat there — Sword Art Online's direct sequel edge shaving Extra
 * Edition's border. Widening the across-axis is the lever that leaves the
 * straight line its room.
 */
const NODE_SEP = 95;
const EDGE_SEP = 95;
/**
 * Gap between columns. Hayase's 120 was set for a 150px card; ours is 226 with
 * cover art, and the relation name has to sit INSIDE that gap — at 120 a
 * "SIDE STORY" left barely twenty pixels of air on each side and read as
 * belonging to the card it was leaning against. Widened so the label is
 * unmistakably between two cards rather than next to one.
 */
const RANK_SEP_TEXT = 120;
const RANK_SEP_COVER = 210;
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
  /**
   * Draw the board in place, as a preview, instead of only as an overlay.
   *
   * Same component, same instance: the preview and the full view are two sizes
   * of ONE graph, so the walk is paid for once and the viewer's work on it —
   * the entry they selected, the cards they moved, the filters, the pan and the
   * zoom — survives the switch. Two instances would have re-walked the
   * franchise and dropped all of that on the floor the moment you expanded.
   *
   * With `embedded`, `open` stops meaning "exists" and starts meaning "is
   * expanded": the inline box hands its board to the overlay and holds its
   * place in the layout until it comes back.
   */
  embedded?: boolean;
  /** Press on the preview's ⤢ — the caller is the one that owns `open`. */
  onExpand?: () => void;
  /**
   * The section's own heading, drawn at the left of the inline controls row.
   *
   * It belongs to the caller — it is the page's section title, not the graph's
   * — but it has to sit on the same line as the controls, and only the row can
   * put it there. Passing it in beats having the caller draw it above and hope
   * the two lines look like one.
   */
  heading?: React.ReactNode;
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

/** What one walk of the franchise comes back with. */
type Walked = { nodes: Map<number, NodeMeta>; edges: Map<string, GEdge> };

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
  embedded,
  onExpand,
  heading,
}: Props) {
  const { t } = useTranslation();
  /**
   * The graph is alive whenever it is on screen at all — inline or expanded.
   * Everything below keys off this rather than `open`, except the things that
   * belong to a dialog (Escape, the page scroll lock).
   */
  const active = open || !!embedded;
  /**
   * Whether the client has taken over from the server-rendered HTML.
   *
   * The board is client-only — it needs `document` for the portal, and its
   * franchise walk cannot run during SSR. Expressing that as
   * `typeof document === "undefined" && return null` looked equivalent and was
   * not: the info page IS server-rendered and Overview sits on its default tab,
   * so the server sent no board while the very first client render drew one.
   * React calls that a hydration mismatch (#418/#423/#425) and its recovery is
   * to throw away the server HTML and re-render the WHOLE page on the client —
   * the entire info page paying for one component's honesty about `document`.
   *
   * A mount flag says the same thing without lying to the hydration: the first
   * client render matches the server exactly (nothing), and the board arrives on
   * the render straight after. Nothing is visible a frame later than before —
   * the walk that fills the board is asynchronous anyway.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
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
    if (active) setSelected(currentId);
  }, [active, currentId]);

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
  const [isFull, setIsFull] = useState(false);
  /** True while the franchise is still being walked. The first pass paints
   *  almost at once and the rest arrives after; saying so is what turns "the
   *  graph is broken" into "the graph is still counting". */
  const [walking, setWalking] = useState(false);
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
  /** The card under the hand. A ref alone can't raise it — the board only
   *  repaints on state, and a card dragged under its neighbours is a card you
   *  are moving blind. */
  const [dragId, setDragId] = useState<number | null>(null);

  /**
   * A page is being opened from the board.
   *
   * Full screen, a card click gives NO feedback at all: the overlay covers the
   * page, so the navigation it starts happens entirely out of sight and the
   * board just sits there for as long as the next page takes to answer. Read as
   * a dead click, it gets clicked again — and every one of those is another
   * route change queued behind the first.
   */
  const [navigating, setNavigating] = useState(false);
  const router = useRouter();
  useEffect(() => {
    // The overlay outlives the navigation when it fails or the viewer goes
    // back, so the shield has to come down on its own.
    const done = () => setNavigating(false);
    router.events.on("routeChangeComplete", done);
    router.events.on("routeChangeError", done);
    return () => {
      router.events.off("routeChangeComplete", done);
      router.events.off("routeChangeError", done);
    };
  }, [router.events]);

  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  /**
   * The zoom, readable from a handler that must not be rebuilt when it changes.
   *
   * Dragging a card divides the pointer's travel by the zoom. That handler now
   * lives inside the memoised board (see boardContent), and listing `scale`
   * among its dependencies would rebuild all sixty cards on every zoom notch —
   * exactly the cost the memo exists to remove. Reading it through a ref keeps
   * the handler correct at any zoom without tying the tree to it.
   */
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  /**
   * The board itself — the one element a pan actually moves.
   *
   * Panning used to run through `setOffset`, which re-rendered every card,
   * every curve and every relation label for each pointer event: sixty cards
   * meant a full React pass per pixel of travel, and on a modest machine the
   * board visibly lagged the cursor. The gesture writes this element's
   * transform directly instead and commits the final position to state when the
   * hand lets go, so the board tracks the pointer at compositor speed and the
   * rest of the component still reads `offset` exactly as before.
   */
  const boardRef = useRef<HTMLDivElement>(null);
  /** Where the board is RIGHT NOW, including a pan still in progress. */
  const liveOffset = useRef(offset);
  const boardTransform = (o: { x: number; y: number }, s: number) =>
    `translate(${o.x}px, ${o.y}px) scale(${s})`;
  // Every other way the view moves — the fit, a search re-centring, a resize —
  // still goes through state, and the live position follows it. Only a pan in
  // progress owns this ref, so its own writes are not overwritten mid-gesture.
  if (!drag.current) liveOffset.current = offset;
  const overlayRef = useRef<HTMLDivElement>(null);
  /** Cleared whenever the board changes size, so the fit runs again. */
  const fittedFor = useRef<string>("");
  /** Last known canvas size, to carry the view across a change of window. */
  const viewport = useRef<{ w: number; h: number } | null>(null);

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
    if (!active) return;
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
  }, [active, session]);

  /** Rank axis follows the window: a narrow one gets a top-to-bottom board. */
  useEffect(() => {
    if (!active) return;
    const apply = () => setRankDir(window.innerWidth < VERTICAL_UNDER_PX ? "TB" : "LR");
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [active]);


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
    if (!active) return;

    let cancelled = false;
    setWalking(true);
    /** Shared by both walks, so the second one costs nothing. */
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

    /**
     * ONE walk, from one root — the whole traversal, its node map and its edge
     * map local to the call.
     *
     * It used to be inlined here and run once, from the page you were on, and
     * that is precisely what made the board a different picture on every page
     * of the same franchise: the traversal order decides the direction of a
     * disputed pair, and dagre ranks on direction. Nothing about the walk is
     * changed — it is only made re-runnable, so it can be run from the
     * franchise's own root instead of from wherever you happen to be standing.
     */
    const walkFrom = async (
      root: NodeMeta,
      onFirstPass?: (r: Walked) => void
    ): Promise<Walked | null> => {
    const nodes = new Map<number, NodeMeta>();
    const edges = new Map<string, GEdge>();
    const frontier = new Set<number>();

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

      await processEdges(root);
      if (cancelled) return null;
      onFirstPass?.({ nodes, edges });

      for (let round = 0; round < MAX_ROUNDS && frontier.size > 0; round++) {
        // AniList returns their batched Page in id order; same order here, so
        // the same end of a disputed pair is the one that gets visited first.
        const ids = Array.from(frontier).sort((a, b) => a - b);
        frontier.clear();

        // TWO requests for the whole round, not two per node.
        //
        // Registering the round's own ids batches them, but each node's
        // CHILDREN were only discovered when its turn came round — and its
        // turn came after the previous node had been awaited. So a round of
        // twelve nodes serialised into twelve requests, one behind the other,
        // which is the trickle you see: a few cards, a pause, a few more.
        //
        // Awaiting the round's payloads up front lets us register everything
        // they point at in one further burst, so by the time the sequential
        // walk starts, every fetch it needs is already in flight. The walk
        // itself is untouched — prefetching decides nothing about order.
        const payloads = await Promise.all(ids.map((id) => getRelations(id)));
        if (cancelled) return null;
        for (const data of payloads) {
          for (const e of data?.edges || []) {
            const n = e?.node;
            if (n?.id && isAnime(n) && !EXCLUDED_RELATIONS.has(e.relationType)) {
              getRelations(Number(n.id));
            }
          }
        }

        for (const id of ids) {
          if (cancelled) return null;
          await processEdges(nodes.get(id) ?? { id, type: "ANIME" });
        }
        // Only the last round repaints. Publishing every round made the board
        // grow four or five times under the viewer, each growth re-framing it.
        if (frontier.size === 0 || round === MAX_ROUNDS - 1) onFirstPass?.({ nodes, edges });
      }
      return { nodes, edges };
    };

    const publish = (r: Walked) =>
      setTree({ nodes: Array.from(r.nodes.values()), edges: Array.from(r.edges.values()) });

    /**
     * The franchise's own starting point: its oldest entry, by AniList id.
     *
     * Any rule would do as long as it names the SAME node from every page —
     * that is the whole job. The oldest is the one that also gives the walk the
     * picture it was designed for, a franchise read outwards from where it
     * began, which is the board this view has always drawn on the first
     * season's page.
     */
    const rootOf = (walked: Walked) =>
      Array.from(walked.nodes.keys()).reduce((a, b) => (b < a ? b : a), Infinity);

    (async () => {
      // First pass from here, because this page already holds its relations —
      // it paints the neighbourhood immediately and, on the way, discovers who
      // the franchise's root is.
      let result = await walkFrom(
        {
          id: currentId,
          type: "ANIME",
          title: currentTitle,
          format: currentFormat,
          episodes: currentEpisodes,
          cover: currentCover ?? null,
        },
        publish
      );
      if (!result || cancelled) return;

      /**
       * Then the same walk again from the root, and THAT is what stays on
       * screen — the identical board from every page of the franchise.
       *
       * It costs no request: the first walk has already pulled every node's
       * relations into `relCache`, so the second reads them from memory. The
       * loop is for the case where re-rooting brings in an older entry the
       * first walk never reached; it settles in one round in practice.
       */
      let usedRoot = currentId;
      for (let attempt = 0; attempt < 3; attempt++) {
        const root = rootOf(result);
        if (!Number.isFinite(root) || root === usedRoot) break;
        const again = await walkFrom(result.nodes.get(root) ?? { id: root, type: "ANIME" });
        if (!again || cancelled) return;
        usedRoot = root;
        result = again;
      }
      publish(result);
      if (!cancelled) setWalking(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [active, relations, currentId, currentTitle, currentFormat, currentEpisodes, currentCover]);

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
      ranksep: covers ? RANK_SEP_COVER : RANK_SEP_TEXT,
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
   * work never gets a number lower than something it follows: where the thread
   * both runs straight to an entry and reaches it again through a step that
   * comes in between, the longer count is the one that reads as an order.
   *
   * That is a rule about the thread, not about what the thread is made of —
   * which bonuses it goes through at all is decided further down, and the
   * answer there is "only the ones it cannot go around".
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

    // Distance in MAIN entries, used only to find the thread: a bonus takes the
    // rank of the entry before it, so a special sitting between two seasons is
    // reachable without shifting them.
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
    if (main.size <= 1) return null;

    /**
     * The bonuses the thread has NO WAY around, as opposed to the ones it can
     * simply go past.
     *
     * Stand Alone Complex reaches SAC_2045 through Solid State Society, a
     * Special, and through nothing else: drop it and the running order reads as
     * two disconnected halves, so the line has to go through it. Sword Art
     * Online reaches its second season both directly and through Extra Edition
     * — there the special is a detour, and a rule that bridged every bonus with
     * a lit sequel took it, numbering a side story as step 2 of the run and
     * pushing the season everyone means to watch next to 3.
     *
     * So necessity is the test, and it is asked in that order: grow the thread
     * through main entries alone, and only then open a detour, towards a main
     * entry nothing else reaches. Each detour is the shortest one available, so
     * a two-special path is never taken where one special joins the same pair.
     */
    const bridge = new Set<number>();
    /** What the thread reaches with the detours opened so far. */
    const reach = new Set<number>([selected]);
    /** Follow the thread as far as it goes over what is currently open. */
    const flood = () => {
      const queue = Array.from(reach);
      while (queue.length) {
        const from = queue.shift()!;
        for (const to of next.get(from) || []) {
          if (reach.has(to) || !(isMain(to) || bridge.has(to))) continue;
          reach.add(to);
          queue.push(to);
        }
      }
    };
    flood();
    for (let pass = 0; pass < nodes.length + 2; pass++) {
      if (Array.from(main.keys()).every((id) => reach.has(id))) break;
      /*
       * Breadth-first out of the thread and through the bonuses, stopping at
       * the first main entry still out of reach — the nearest one, so the
       * detour opened is the shortest. Main entries are not walked THROUGH:
       * anything behind one is the thread's own business, reached by flooding
       * once this gap is closed.
       */
      const parent = new Map<number, number>();
      const queue = Array.from(reach);
      const seen = new Set(reach);
      let landed: number | null = null;
      while (queue.length && landed === null) {
        const from = queue.shift()!;
        for (const to of next.get(from) || []) {
          if (seen.has(to)) continue;
          seen.add(to);
          parent.set(to, from);
          if (isMain(to)) {
            landed = to;
            break;
          }
          queue.push(to);
        }
      }
      // Nothing reachable at all: the rest of `main` hangs off the selection by
      // some other kind of relation, and the thread simply ends here.
      if (landed === null) break;
      // Everything between the thread and where we landed is, by construction,
      // a bonus — main entries end the search rather than continue it.
      for (let at = parent.get(landed); at !== undefined && !reach.has(at); at = parent.get(at)) {
        bridge.add(at);
      }
      flood();
    }

    /**
     * The numbers, over the thread as it is DRAWN — every card the lit line
     * touches counts, bridges included.
     *
     * They used to count main entries only, so a crossed special was a lit card
     * with no number in the middle of the run and the order looked like it had
     * skipped one. A step is a thing you sit through; if the line goes through
     * it, it has a number.
     */
    const order = new Map<number, number>([[selected, 1]]);
    for (let pass = 0; pass < nodes.length + 2; pass++) {
      let changed = false;
      for (const [from, tos] of Array.from(next.entries())) {
        const d = order.get(from);
        if (d === undefined) continue;
        for (const to of tos) {
          if (!main.has(to) && !bridge.has(to)) continue;
          if ((order.get(to) ?? -1) < d + 1) {
            order.set(to, d + 1);
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    return { order, bridge, main };
  }, [selected, edges, nodes.length, byId]);

  /** On the lit thread — every card the running order passes through. */
  const onThread = (id: number) => !!chain && chain.order.has(id);

  /**
   * An edge belongs to the running order when it links two consecutive steps of
   * it. An edge onto a bonus that continues nothing stays dim: the line shows
   * the main thread, not its detours.
   */
  const isChainEdge = (e: GEdge) =>
    !!chain &&
    e.label === "SEQUEL" &&
    chain.order.has(e.from) &&
    chain.order.get(e.to) === (chain.order.get(e.from) ?? -99) + 1;

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
    if (!active) return;
    const box = canvasRef.current;
    if (!box || width === 0 || height === 0) return;
    // A box with no size yet would "fit" the board to nothing and then be
    // remembered as fitted; let the next pass do it.
    if (!box.clientWidth || !box.clientHeight) return;
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
    viewport.current = { w: box.clientWidth, h: box.clientHeight };
  }, [active, width, height]);

  /**
   * Keep what you were looking at when the viewport changes size.
   *
   * The preview is a small window onto the same board, and expanding it is a
   * change of window, not a change of subject — refitting on the way in would
   * throw away the part of the franchise you had just panned to. So the board
   * point at the centre stays at the centre, and the zoom grows by exactly the
   * factor the box grew by: a preview showing the whole graph expands to the
   * whole graph, and a preview zoomed in on Alicization expands onto
   * Alicization.
   *
   * Runs on any resize of the canvas — the expand, the browser's own
   * fullscreen, and a window drag all take the same path.
   */
  useEffect(() => {
    const box = canvasRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const w = box.clientWidth;
      const h = box.clientHeight;
      if (!w || !h) return;
      const prev = viewport.current;
      viewport.current = { w, h };
      // Nothing to preserve before the first fit has framed the board.
      if (!prev || !prev.w || !prev.h || !fittedFor.current) return;
      if (prev.w === w && prev.h === h) return;
      const k = Math.min(w / prev.w, h / prev.h);
      setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * k)));
      setOffset((o) => ({
        x: w / 2 - (prev.w / 2 - o.x) * k,
        y: h / 2 - (prev.h / 2 - o.y) * k,
      }));
    });
    ro.observe(box);
    return () => ro.disconnect();
    // The canvas node itself is swapped when the board moves between the inline
    // box and the overlay, so the observer has to follow that move.
  }, [active, open]);

  /**
   * Wheel-to-zoom, bound by hand so it can refuse the page its scroll.
   *
   * React's onWheel lands on a passive listener, which cannot preventDefault —
   * harmless in the overlay (there is nothing behind it to scroll), but in the
   * inline preview every zoom would also scroll the info page out from under
   * the graph.
   */
  useEffect(() => {
    const box = canvasRef.current;
    if (!box) return;
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * factor)));
    };
    box.addEventListener("wheel", onWheelNative, { passive: false });
    return () => box.removeEventListener("wheel", onWheelNative);
  }, [active, open]);


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
    if (!active || !matches || matches.size === 0) return;
    // Re-centre when the query changes, not on every node the walk adds.
    const key = query.trim().toLowerCase();
    if (centredFor.current === key) return;
    centredFor.current = key;
    const first = nodes.find((n) => matches.has(n.id));
    if (first) centreOn(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, query, matches, nodes]);

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
  const isDim = (id: number) => (near ? !near.has(id) : chain ? !onThread(id) : false);

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
    setDragId(id);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  /**
   * Hold Ctrl while dragging to line a card up with its neighbour.
   *
   * Placing a card by eye is what you do to untangle a knot, and by eye you
   * land a few pixels off — which is exactly enough for the line between two
   * cards to slope, and a sloping line reads as a relation going somewhere
   * else. Snapping to the nearest card ALONG the rank axis (left or right in a
   * horizontal board, above or below in a vertical one) makes the connection
   * run flat.
   *
   * Centres, not tops: an edge leaves a card at its middle, so it is the
   * middles that must agree for the stroke to come out straight.
   */
  const alignToNeighbour = (id: number, off: { dx: number; dy: number }) => {
    const me = byId.get(id);
    if (!me) return off;
    const myCx = me.x + off.dx + me.w / 2;
    const myCy = me.y + off.dy + me.h / 2;

    let best: { cx: number; cy: number } | null = null;
    let bestScore = Infinity;
    for (const n of nodes) {
      if (n.id === id) continue;
      const p = posOf(n);
      const cx = p.x + n.w / 2;
      const cy = p.y + n.h / 2;
      const along = rankDir === "TB" ? Math.abs(cy - myCy) : Math.abs(cx - myCx);
      // A card in the same column is not the one to the left or the right.
      if (along < 4) continue;
      const across = rankDir === "TB" ? Math.abs(cx - myCx) : Math.abs(cy - myCy);
      // Nearest along the axis wins; the across distance only breaks ties
      // between two columns at a similar distance.
      const score = along + across * 0.35;
      if (score < bestScore) {
        bestScore = score;
        best = { cx, cy };
      }
    }
    if (!best) return off;
    return rankDir === "TB"
      ? { dx: off.dx + (best.cx - myCx), dy: off.dy }
      : { dx: off.dx, dy: off.dy + (best.cy - myCy) };
  };

  const onNodePointerMove = (e: React.PointerEvent) => {
    const d = nodeDrag.current;
    if (!d) return;
    /**
     * The dead zone is measured on the SCREEN, before the zoom is divided out.
     *
     * Dividing first made the threshold mean "3 board pixels", which at the
     * preview's zoom (~0.3) is one pixel of finger travel — so an ordinary
     * click on a card nudged it, marked it as hand-placed, and swallowed the
     * navigation. The lower the zoom, the worse it got, which is exactly
     * backwards: a click is a click at any zoom.
     */
    const sx = e.clientX - d.x;
    const sy = e.clientY - d.y;
    if (!d.moved && Math.abs(sx) < 3 && Math.abs(sy) < 3) return;
    d.moved = true;
    const raw = { dx: d.dx + sx / scaleRef.current, dy: d.dy + sy / scaleRef.current };
    const next = e.ctrlKey ? alignToNeighbour(d.id, raw) : raw;
    setMoved((prev) => {
      const m = new Map(prev);
      m.set(d.id, next);
      return m;
    });
  };
  const onNodePointerUp = (e: React.PointerEvent) => {
    if (nodeDrag.current?.moved) e.preventDefault();
    setDragId(null);
    // Cleared on the next tick so the click handler can still see `moved`.
    const d = nodeDrag.current;
    setTimeout(() => {
      if (nodeDrag.current === d) nodeDrag.current = null;
    }, 0);
  };

  /**
   * Real fullscreen on the overlay — the ⤢ button only re-framed the board.
   *
   * From the inline preview the same button means one step less: expand to the
   * overlay. Asking the browser for fullscreen on a box inside the page would
   * blow up the info page around it, which is not what "see this bigger" means.
   */
  const toggleFullscreen = () => {
    if (embedded && !open) {
      onExpand?.();
      return;
    }
    const el = overlayRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    else el.requestFullscreen?.().catch(() => undefined);
  };
  useEffect(() => {
    // The board itself needs nothing here: the resize observer above carries
    // the view across the size change, in or out.
    const onChange = () => setIsFull(!!document.fullscreenElement);
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
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      ox: liveOffset.current.x,
      oy: liveOffset.current.y,
    };
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const next = {
      x: drag.current.ox + (e.clientX - drag.current.x),
      y: drag.current.oy + (e.clientY - drag.current.y),
    };
    liveOffset.current = next;
    // Straight to the element. The board is one transformed div, so this is the
    // whole of what a pan changes — see boardRef.
    if (boardRef.current) boardRef.current.style.transform = boardTransform(next, scale);
  };
  const onPointerUp = () => {
    const panned = !!drag.current;
    drag.current = null;
    setDragging(false);
    // Publish where the hand left the board, so everything that reads `offset`
    // (centring, the resize handler, the next pan's origin) sees the truth.
    if (panned) setOffset(liveOffset.current);
  };

  /**
   * The board's contents, rebuilt only when what they DRAW changes.
   *
   * Panning and zooming move one transform; they do not change a single
   * card, curve or label. Leaving this inline meant React reconciled sixty
   * cards, sixty curves and sixty labels on every zoom notch and on every
   * unrelated re-render the component had — the walk delivering a round, a
   * menu opening, the navigation flag. Holding the tree in a memo lets React
   * skip the whole subtree when none of its inputs moved, which is most of
   * the time. Everything the tree reads is a dependency below; a value
   * missing from that list would freeze the picture it belongs to.
   */
  const boardContent = useMemo(
    () => (
      <>
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
          // The middle of the line, always. The control points sit level
          // with their own ends, so the curve's midpoint IS the midpoint of
          // the segment — no bezier maths needed. An edge that skips a rank
          // can put its name over the card in between; that is accepted,
          // because a name that hunts for a free spot is a name you can no
          // longer attribute to a line.
          // Astride the line, dead centre. The chip is opaque and
          // bordered, so it masks the stroke behind it instead of being
          // cut in half by it — which is why lifting it off was solving a
          // problem it never had.
          const x = (p.x1 + p.x2) / 2;
          const y = (p.y1 + p.y2) / 2;
          const touches = near ? e.from === hover || e.to === hover : null;
          const lit = touches !== null ? touches : isChainEdge(e);
          const dim = touches !== null ? !touches : !!chain && !isChainEdge(e);
          return (
            <span
              key={`l${i}`}
              style={{
                ...gStyles.edgeLabel,
                left: x,
                top: y,
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
          const step = chain?.order.get(n.id);
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
              // A card is a link, first press. The two-step it replaced —
              // one click to light the running order, another to open —
              // made every card need to be told twice, and the order it
              // lit is already what the board shows from the entry you
              // came from. Hovering still lights a card's neighbourhood,
              // which is the reading the click was standing in for.
              onPointerDown={(ev) => onNodePointerDown(ev, n.id)}
              onPointerMove={onNodePointerMove}
              onPointerUp={onNodePointerUp}
              onClick={(ev) => {
                // A card that was just dragged must not navigate.
                if (nodeDrag.current?.moved) {
                  ev.preventDefault();
                  ev.stopPropagation();
                  return;
                }
                // Modified clicks open elsewhere and leave this page alone,
                // so they must not lock the board down.
                if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
                if (open) setNavigating(true);
              }}
              title={t("anime.graphOpenEntry", { defaultValue: "Open this entry" })}
              style={{
                ...gStyles.node,
                left: posOf(n).x + PAD,
                top: posOf(n).y + PAD,
                width: n.w,
                // The card in hand rides above everything; one you have
                // already placed stays above the untouched ones, so
                // dropping it onto a neighbour doesn't bury it.
                zIndex: dragId === n.id ? 4 : moved.has(n.id) ? 3 : 2,
                // Finished beats the running order: green wins over pink,
                // even on the selected card. A search hit still beats both
                // — it answers a question the viewer asked one second ago,
                // where the other two are standing facts.
                borderColor: isMatch
                  ? "#ffd166"
                  : done
                    ? DONE_GREEN
                    : isSelected
                      ? "var(--brand-primary, #ff3b5c)"
                      : lit
                        ? "rgba(255,59,92,.5)"
                        : "#26262d",
                // The text still names the selection, so a finished card
                // that is also selected doesn't lose that.
                color: isSelected ? "var(--brand-primary, #ff3b5c)" : "var(--txt-0)",
                // Dimming the rest is what makes a chain readable at all:
                // the board is otherwise a uniform field of nineteen cards.
                // A search result is never dimmed — it is what you asked
                // for — and neither is a card you moved by hand: dimming is
                // TRANSPARENCY, so a dimmed card dropped on a neighbour
                // shows it through and reads as being underneath, however
                // high it is stacked.
                opacity:
                  isMatch || dragId === n.id || moved.has(n.id) || !isDim(n.id) ? 1 : 0.62,
                // The selection ring follows whatever colour the border
                // ended up being, or a green card would wear a pink halo.
                boxShadow: isMatch
                  ? "0 0 0 2px #ffd166"
                  : isSelected
                    ? `0 0 0 1px ${done ? DONE_GREEN : "var(--brand-primary, #ff3b5c)"}`
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
                <Icon d={ICON.remove} size={11} />
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
                      style={{ ...gStyles.nodeMeta }}
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
                  <div style={{ ...gStyles.nodeMeta }}>
                    <span>{FORMAT_LABEL[n.format] ?? n.format}</span>
                    <span>
                      {n.episodes
                        ? t("preview.episodeCount", { count: n.episodes })
                        : n.status || ""}
                    </span>
                  </div>
                </>
              )}
            </Link>
          );
        })}
      </>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      nodes,
      edges,
      byId,
      moved,
      rankDir,
      near,
      hover,
      chain,
      selected,
      matches,
      listMap,
      dragId,
      covers,
      clickTarget,
      open,
      width,
      height,
      t,
    ],
  );

  if (!active || !mounted) return null;

  /** Title, search and filters. The expanded view only — the preview is a
   *  window onto the board, not a place to run a query from. */
  const header = (
    <div style={{ ...gStyles.header, ...(open ? null : gStyles.headerEmbedded) }}>
        {/* In the page the section's own heading takes the left, and the
            controls are pushed to the right of it — one line, not two. */}
        {!open && heading}
        {open && (
        <span style={gStyles.title}>
          {t("anime.relationsGraphTitle", { defaultValue: "Franchise timeline" })}
          {walking && (
            <span style={gStyles.walking}>
              {t("anime.graphWalking", { defaultValue: "still loading…" })}
            </span>
          )}
        </span>
        )}

        <div style={{ ...gStyles.filters, ...(open ? null : gStyles.filtersEmbedded) }}>
          {/* The overlay says this next to its title; in the page the row is
              all there is, so it says it here. */}
          {!open && walking && (
            <span style={{ ...gStyles.walking, alignSelf: "center" }}>
              {t("anime.graphWalking", { defaultValue: "still loading…" })}
            </span>
          )}
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
            {t("anime.graphMainStory", { defaultValue: "Main story" })}
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

        {open && (
        <button
          onClick={onClose}
          aria-label={t("anime.relationsGraphClose", { defaultValue: "Close" })}
          title={t("anime.relationsGraphClose", { defaultValue: "Close" })}
          style={gStyles.closeBtn}
        >
          <Icon d={ICON.close} size={16} />
        </button>
        )}
    </div>
  );

  /**
   * The board — the same element whether it is sitting in the page or filling
   * the screen. Only its container changes, which is what lets the view, the
   * selection and the hand-placed cards survive the switch.
   */
  const board = (
      <div
        ref={canvasRef}
        style={{
          ...gStyles.canvas,
          cursor: dragging ? "grabbing" : "grab",
          ...(embedded && !open ? gStyles.canvasEmbedded : null),
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        {nodes.length <= 1 ? (
          <div style={gStyles.empty}>{t("anime.noRelated")}</div>
        ) : (
          <div
            ref={boardRef}
            style={{
              // The live position, not the committed one: a render landing mid-
              // pan (a hover, a search keystroke) must not snap the board back
              // to where the gesture started.
              transform: boardTransform(liveOffset.current, scale),
              transformOrigin: "0 0",
              position: "relative",
              width: width + PAD * 2,
              height: height + PAD * 2,
            }}
          >
            {boardContent}
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
  );

  // The preview: the board in the page, with its own controls and nothing
  // else. Expanding is the ⤢ in those controls, or the caller's own button.
  if (!open) {
    return (
      <div style={gStyles.embedShell}>
        {header}
        <div style={gStyles.embedWrap}>{board}</div>
      </div>
    );
  }

  // Portalled to <body>, like OpEdPanel: the graph is a full-screen dialog, and
  // rendered in place it stacks inside the info page, UNDER the site navbar
  // (z-[9999], fixed) — the board's own title and filter chips came out drawn
  // through the menu. A portal plus a z-index above the navbar's is what puts
  // it on top, and keeps any ancestor transform from trapping `position: fixed`.
  const overlay = createPortal(
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
      {header}
      {board}
      {/* Opening a page from the board: a pink bar says the click landed, and
          the sheet under it swallows every further one until the next page
          arrives — a second click is a second route change, not a faster one. */}
      {navigating && (
        <div style={gStyles.navShield} aria-hidden="true">
          <style>{NAV_KEYFRAMES}</style>
          <div style={gStyles.navBar} />
        </div>
      )}
    </div>,
    document.body
  );

  // Expanded from the page: the inline box keeps its place in the layout while
  // the board is away, so closing the overlay doesn't drop the info page back
  // by four hundred pixels under the reader.
  if (!embedded) return overlay;
  return (
    <>
      <div style={gStyles.embedWrap}>
        <div style={gStyles.empty}>
          {t("anime.graphExpanded", { defaultValue: "Opened in full screen" })}
        </div>
      </div>
      {overlay}
    </>
  );
}

/** Inline because the overlay is portalled to <body>, outside any stylesheet
 *  the component owns — and a keyframe cannot be written as a style object. */
const NAV_KEYFRAMES = `@keyframes anig-nav {
  0%   { width: 0%; }
  15%  { width: 38%; }
  40%  { width: 66%; }
  70%  { width: 85%; }
  90%  { width: 95%; }
  100% { width: 100%; }
}`;

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
  /** Over everything the overlay draws, controls and cards included. */
  navShield: {
    position: "absolute",
    inset: 0,
    zIndex: 20,
    overflow: "hidden",
    background: "rgba(0,0,0,.2)",
    cursor: "progress",
  },
  navBar: {
    position: "absolute",
    top: 0,
    left: 0,
    height: 3,
    width: 0,
    borderRadius: "0 2px 2px 0",
    background: "var(--brand-primary, #ff3b5c)",
    boxShadow: "0 0 8px rgba(255,59,92,.55)",
    /* Fills once and stays full — it never loops back to zero, which would
       read as a load starting over. The steps slow down as they climb: a bar
       that ran at a constant rate would hit the end and sit there, and the
       next page rarely arrives on the beat. */
    animation: "anig-nav 2.6s ease-out forwards",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 20px",
    borderBottom: "1px solid var(--line)",
  },
  title: {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: "0.02em",
    whiteSpace: "nowrap",
  },
  walking: { fontSize: 11, fontWeight: 600, color: "var(--txt-3)" },
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
  /**
   * A field, not a sixth chip.
   *
   * It was the same pill, the same border, the same fill and the same height as
   * the buttons beside it, so the row read as five buttons of which one
   * happened to contain a cursor. A text field says what it is by being
   * rectangular and sunken — the shape every other input on the site has — and
   * a wider gap keeps it from being read as part of the group it precedes.
   */
  searchBox: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 9px",
    marginRight: 10,
    borderRadius: 7,
    border: "1px solid var(--line)",
    background: "rgba(0,0,0,.35)",
    color: "var(--txt-3)",
  },
  searchInput: {
    width: 140,
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
  /** The controls row and the board under it, as one block in the page. */
  embedShell: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    width: "100%",
  },
  /**
   * The same row as the overlay's, minus its frame: in the page it is a strip
   * of controls under the section's own heading, not the top of a dialog.
   * Raised above the board so a filter menu drops OVER it — the board comes
   * later in the document and would otherwise paint on top of it.
   */
  headerEmbedded: {
    padding: 0,
    borderBottom: "none",
    position: "relative",
    zIndex: 2,
  },
  /** Hard right, so the heading keeps the left of the line to itself. */
  filtersEmbedded: { justifyContent: "flex-end" },
  /**
   * The inline box, at a HEIGHT OF ITS OWN rather than filling its column.
   *
   * Stretching read as "the graph is the page": the column it sits in is the
   * one the Details card mirrors, so a board that grows to fill drags a column
   * of six labels out to the same height and leaves them floating in space.
   * A fixed 380 is about what the card carousel it replaces occupied, so the
   * row keeps the proportions the rest of the page was built around — and the
   * full view is one press away for anything that needs room.
   */
  embedWrap: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    flex: "0 0 auto",
    height: 380,
    width: "100%",
    borderRadius: 12,
    border: "1px solid var(--line)",
    overflow: "hidden",
    background: "#000",
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
    // The tile carries its dot in the middle, so tiling from a corner leaves
    // half a tile of margin on the two sides it starts from and whatever the
    // box happens to leave over on the others — a wide empty band on one edge.
    // Left for the columns (11px, half a tile, from the frame) and centred for
    // the rows, which splits the leftover evenly: the first row sits as far
    // under the header as the last one sits above the bottom edge.
    backgroundPosition: "left center",
    // Dragging the board would otherwise sweep a text selection across every
    // card it crosses, leaving the graph highlighted in blue.
    userSelect: "none",
    WebkitUserSelect: "none",
  },
  /** Inside the page the board is a card, not a screen: the dot grid stays
   *  (it is what makes panning legible) but it gets a lighter ground so it
   *  doesn't read as a hole cut in the page. */
  canvasEmbedded: {
    background: "#08080b",
    backgroundImage: "radial-gradient(circle, #24242a 1px, transparent 1px)",
  },
  /** Zoom / fit / reset, bottom-right, out of the graph's way. */
  controls: {
    position: "absolute",
    right: 14,
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
  /**
   * Dismiss, tucked INSIDE the top-right corner.
   *
   * It used to hang outside the card as a bordered cross, which put a second
   * round badge on a card that already carries the step number and read as
   * part of the diagram rather than as a control. A minus, inside the frame
   * and unboxed, says "take this one out" without competing with anything.
   */
  nodeClose: {
    position: "absolute",
    // The glyph is centred in its hit box, so the box's height is half of what
    // decides where the bar lands: a 16px box at top 3 put the stroke 11px
    // down, well below the corner. Shorter box, higher anchor — the bar sits
    // at 8px, level with the corner radius.
    top: 1,
    right: 4,
    width: 18,
    height: 14,
    display: "grid",
    placeItems: "center",
    borderRadius: 4,
    border: "none",
    background: "transparent",
    color: "var(--txt-2)",
    cursor: "pointer",
    padding: 0,
    opacity: 0.5,
  },
  nodeRow: { display: "flex", alignItems: "stretch" },
  nodeCover: {
    display: "block",
    flex: "0 0 auto",
    width: COVER_W,
    // Stretched to the card, not fixed at COVER_H: a long title makes the card
    // taller than the art, and a fixed height left a strip of card background
    // under the poster. `contain` still shows the whole poster — it just
    // letterboxes inside a taller box instead of stopping short of the edge.
    alignSelf: "stretch",
    height: "auto",
    // `cover`, not `contain`: the card is as tall as its text, so a long title
    // makes it taller than a 2:3 poster and `contain` letterboxed the art —
    // black bands above and below, which is the gap this replaces. Filling the
    // box costs a few pixels off the sides of the widest cards.
    objectFit: "cover",
    background: "#0b0b0e",
    borderTopLeftRadius: 2,
    borderBottomLeftRadius: 2,
  },
  nodeBody: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
  },
  /** Beside the art, the title is no longer a header band across the top: it
   *  takes the space above the meta line and centres itself in it. */
  nodeTitleSide: {
    background: "transparent",
    flex: 1,
    display: "grid",
    placeItems: "center",
    padding: "10px 12px",
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
};
