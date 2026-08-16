import {
  CSSProperties,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { createPortal } from "react-dom";
import dagre from "@dagrejs/dagre";
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
 * Room above the title on a text-only card, so the dismiss button gets a
 * corner to itself.
 *
 * Without it the title's FIRST line starts 10px down while the button occupies
 * 1px to 15px in the same corner, so any title long enough to reach the right
 * edge — the common case, the card is 150px — has the minus stroked through
 * it. With covers on there is no clash: the title is centred in a 114px row,
 * nowhere near the corner.
 *
 * It has to be added to the card's HEIGHT as well as its padding: dagre lays
 * the board out from `nodeHeight`, so padding the DOM alone would make every
 * text card 8px taller than the space reserved for it and the last rank would
 * lean into the next.
 */
const NODE_CLOSE_CLEAR = 8;
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
 * Air left around the board when it is framed, in SCREEN pixels.
 *
 * `PAD` cannot do this job: it lives in board coordinates, so it shrinks with
 * the zoom — on One Piece, framed at 0.0376, its 40px come out as one and a
 * half, and the outermost cards sit against the border. This one is applied to
 * the box before the fit is computed, so the gutter is the same whether the
 * board is nineteen cards or sixty.
 */
const FIT_MARGIN = 24;

/**
 * Frame a board of `boardW × boardH` inside a box, centred, with air around it.
 *
 * One function because there are two callers — the automatic fit and the reset
 * button — and when they were two copies of the same three lines they were free
 * to disagree about the margin.
 */
const fitView = (boxW: number, boxH: number, boardW: number, boardH: number) => {
  const usableW = Math.max(1, boxW - FIT_MARGIN * 2);
  const usableH = Math.max(1, boxH - FIT_MARGIN * 2);
  // Clamped like every other zoom: a fit below the floor would be a scale the
  // next wheel notch silently disagrees with — the bug this file just paid for.
  const scale = Math.max(MIN_SCALE, Math.min(1, usableW / boardW, usableH / boardH));
  return { scale, x: (boxW - boardW * scale) / 2, y: (boxH - boardH * scale) / 2 };
};

/**
 * Zoom range. The floor used to be 0.35, which on a wide franchise (or with
 * covers on, where a card is half as wide again) stopped well before the whole
 * board fitted — you could see the picture the fit gave you and never pull back
 * from it. Cards are unreadable down there, and that is the point: what you are
 * reading at this end is the SHAPE of the franchise.
 *
 * 0.12 was still far too high, and it did more than stop the wheel early. One
 * Piece lays out 10053px of board, which the inline strip fits at 0.0376 — so
 * every zoom the clamp touched moved the board WITHOUT the scale it was
 * computed for, and expanding parked the franchise off the corner of a view
 * three times its size. A floor has to sit under the smallest fit any franchise
 * can produce; anything else is a bug waiting for a big enough show.
 */
const MIN_SCALE = 0.01;
/** The other end, raised with the floor: 2.5 was no obstacle to reading a card,
 *  but "no real limit" reads both ways and nothing breaks up here. */
const MAX_SCALE = 4;

/**
 * Below this, a left-to-right board is a strip narrower than one card and taller
 * than the screen — the rank axis has to follow the long side of the window, so
 * a phone (and a split-screen desktop) lays the franchise out top-to-bottom.
 */
const VERTICAL_UNDER_PX = 820;

/**
 * `useLayoutEffect`, minus the server warning.
 *
 * The board's framing has to be applied BEFORE the browser paints, or the
 * first frame of every new layout is drawn at the previous transform — the
 * board appeared at `scale(1)` anchored top-left for one frame and then snapped
 * to its fit (measured at 12ms on Sword Art Online, 13ms on One Piece). React
 * logs a warning for a layout effect during SSR, hence the swap; the component
 * renders nothing on the server anyway.
 */
const useIsoLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

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
  // The paper the anime came from, and the paper it produced. Neither moves
  // the story on screen forward, and "main story" meant a watch order before
  // manga were drawn at all — this is what keeps it meaning that.
  "SOURCE",
  "ADAPTATION",
]);

const nodeHeight = (title: string, withCover: boolean) => {
  const text = NODE_BASE_H + Math.ceil((title.length || 1) / CHARS_PER_LINE) * NODE_LINE_H;
  // Side by side, the card is as tall as the taller column.
  return withCover ? Math.max(COVER_H, text) : text + NODE_CLOSE_CLEAR;
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

/**
 * Height of the inline controls row, in pixels.
 *
 * Exported because the section beside this one has to match it: its heading is
 * a bare line of text at the top of its column, this one is a word centred on a
 * row of buttons, and two columns of a grid cannot measure each other. Both
 * sides pin their heading row to this number, so the headings share a baseline
 * and the two cards under them start on the same line.
 *
 * It MUST sit above the row's natural height, which is what 26 got wrong: the
 * chips measure 27.5 in the browser, so the floor did nothing on this side
 * while the other side obeyed it, and the two rows came out 26 against 27.5.
 * Half of that put the headings 0.75px apart and the full 1.5px separated the
 * cards — invisible at 100%, plain at any zoom. Measured on dev, not guessed.
 *
 * A floor rather than a fixed height so the row can still grow if the chips
 * wrap; below 900px the grid is one column and there is nothing left to align.
 */
export const EMBED_HEADER_H = 28;

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
  /**
   * The entry the board is opened from — and, since the walk moved to the
   * server, the ONLY thing the graph needs to draw itself. It used to be seeded
   * with this page's own relations, title, format, episode count and cover so
   * the first level cost no request; the server now answers the whole franchise
   * in one, and every card's metadata comes back with it.
   */
  currentId: number;
};

type GNode = {
  id: number;
  title: string;
  format: string;
  episodes: number | null;
  status: string | null;
  cover: string | null;
  current: boolean;
  /** Manga, light novel, one-shot — drawn, but there is no page to open. */
  manga: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
};

type GEdge = { from: number; to: number; label: string };

/** What a node needs to be drawn — the shape `/api/v2/relations/tree` returns. */
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
 * The franchise endpoint, built in ONE place.
 *
 * The info page preloads this exact URL from its `<head>`, and a preload only
 * counts if it matches the request byte for byte — a `v` bumped here and not
 * there would quietly fetch the franchise twice and earn a "preloaded but not
 * used" warning for the trouble.
 *
 * `v` is not read by the route: it is the CDN key. The answer holds for a day,
 * so without it a franchise walked under older rules would keep serving that
 * board until tomorrow. Bump it on any change to the walk's shape.
 */
export const relationsTreeUrl = (id: number) => `/api/v2/relations/tree?id=${id}&v=5`;

/**
 * Franchises already walked, kept for the life of the tab.
 *
 * Browsing a franchise means visiting its members one after another, and every
 * one of them asks for the SAME tree — the answer is deliberately identical
 * from any entry, which is what the server-side re-rooting is for. The CDN
 * makes that cheap, not free: measured at 284ms on a warm edge, which is 284ms
 * of skeleton for a board this tab has already drawn. Here it is a lookup.
 *
 * It cannot go stale inside a tab: a franchise's shape changes about once a
 * season, and the route already serves one answer for a day.
 */
const treeCache = new Map<number, { nodes: NodeMeta[]; edges: GEdge[] }>();

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
  MANGA: "Manga",
  MANHWA: "Manhwa",
  NOVEL: "Light Novel",
  ONE_SHOT: "One-shot",
};

/**
 * A chip that opens a checklist of values.
 *
 * Empty selection means "all", which is why there is an explicit "All" row:
 * unticking the last value and "showing everything" are the same state, and
 * without a row to press you can only reach it by unticking one by one.
 */
/** Stands in for the "All" row, which has no value of its own to be keyed on. */
const ALL_ROW = " all";

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
  /**
   * The row under the pointer.
   *
   * The menu is drawn with inline styles — everything on this board is — and an
   * inline style has no `:hover`, so the rows answered nothing at all: a list of
   * nine where only the ticked one was ever lit, and no way to tell which one a
   * press would land on. Kept in state rather than moved to a stylesheet so the
   * menu stays one self-contained component.
   */
  const [hovered, setHovered] = useState<string | null>(null);
  /** Lit on hover, unless the row is already lit for being selected. */
  const rowStyle = (value: string, on: boolean) => ({
    ...gStyles.menuItem,
    ...(on ? gStyles.menuItemOn : hovered === value ? gStyles.menuItemHover : null),
  });
  return (
    <div style={gStyles.menuWrap} onPointerLeave={() => setHovered(null)}>
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
            onPointerEnter={() => setHovered(ALL_ROW)}
            style={rowStyle(ALL_ROW, selected.size === 0)}
          >
            <span style={gStyles.tick}>{selected.size === 0 ? "✓" : ""}</span>
            {allLabel}
          </button>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => onPick(o.value)}
              onPointerEnter={() => setHovered(o.value)}
              style={rowStyle(o.value, selected.has(o.value))}
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
  currentId,
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
  /**
   * Bring in the printed works — manga, light novel, one-shot.
   *
   * Off by default: this is a site you watch things on, the board is read as a
   * watch order, and a manga is the one card that opens nothing. The franchise
   * usually STARTS on paper though, so the origin is one press away rather
   * than absent — which is what it was before the walk drew it at all.
   */
  const [showManga, setShowManga] = useState(false);
  /** Cover art on the cards, on by default — a franchise is far easier to read
   *  by its art than by twenty near-identical titles. The switch turns the
   *  board back into plain text cards. */
  const [covers, setCovers] = useState(true);
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
  /** Cleared whenever the board changes size, so the fit runs again. */
  const fittedFor = useRef<string>("");
  /**
   * Whether the viewer has moved the view themselves — a zoom, a pan, a jump to
   * a search hit. Set by every deliberate move, cleared by anything that frames
   * the board on their behalf (the automatic fit, the reset button) and by a
   * change of franchise, whose ids the old view means nothing about.
   */
  const touchedView = useRef(false);
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
   * The franchise, in ONE request, as soon as the graph is on screen.
   *
   * The walk itself now runs on the server — `lib/anilist/franchiseTree.ts`
   * holds it, and the reasons it is written the way it is. Two things moved
   * with it.
   *
   * It used to be six to eight SEQUENTIAL round trips from here, each level of
   * the breadth-first walk waiting on the one before it. That was most of the
   * time a board took to settle: 4.6s for Sword Art Online on a 250ms link,
   * 7.5s for One Piece. One request replaces them, and the CDN answers it for
   * everybody else for a day.
   *
   * And it used to PUBLISH TWICE — a draft walked from whichever page you were
   * on, then the real board walked from the franchise's root. Those two
   * disagree by construction: the traversal order decides the direction of a
   * disputed pair and dagre ranks on direction. So a second and a half after
   * the draft appeared, it was replaced by a picture in which EVERY card had
   * moved (13/13 on Sword Art Online, 23/23 on Fate, 54/54 on One Piece) at a
   * different zoom. There is one answer now, so the board is drawn once and
   * stays where it was drawn.
   */
  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    /**
     * The PREVIOUS anime's franchise must go before the new one arrives.
     *
     * Nothing cleared `tree` on a change of entry, so moving from One Piece to
     * a two-card show left sixty cards of the wrong franchise on screen for as
     * long as the request took — and they were live: clickable, searchable,
     * laid out. A board showing someone else's franchise is worse than a board
     * showing nothing, and there is already a skeleton for "nothing yet".
     *
     * Everything the viewer did to the old board goes with it, for the same
     * reason: a card hidden on One Piece has no meaning here, and neither does
     * a selection or a hand-moved position keyed on ids that are gone.
     */
    const cached = treeCache.get(currentId);
    setTree(cached ?? { nodes: [], edges: [] });
    setHidden(new Set());
    setMoved(new Map());
    fittedFor.current = "";
    touchedView.current = false;
    // NOT the selection: it belongs to the effect above, which puts it on the
    // new entry so the board opens already answering "what comes after this
    // one". Clearing it here ran second — same [active, currentId] key, later
    // in the file — and left the board with no chain, so the running order's
    // 1, 2, 3 disappeared.
    // A cached franchise is on screen already — saying "still loading" over it
    // would be a spinner for work that is done.
    setWalking(!cached);
    if (cached) return;

    // `v` is not read by the route — it is the CDN key. The answer holds for a
    // day, so without it every franchise walked before manga were drawn would
    // keep serving the old, paperless board until tomorrow. Bump on any change
    // to the walk's shape.
    fetch(relationsTreeUrl(currentId))
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const next = { nodes: data?.nodes || [], edges: data?.edges || [] };
        // Only a complete walk is worth keeping: a `partial` answer is the one
        // the route itself refuses to cache for long, precisely because the
        // next request gets further.
        if (next.nodes.length > 0 && !data?.partial) treeCache.set(currentId, next);
        setTree(next);
        setWalking(false);
      })
      .catch(() => {
        // The board keeps whatever it had; the empty state says the rest.
        if (!cancelled) setWalking(false);
      });
    return () => {
      cancelled = true;
    };
    // Only the entry matters now — the walk no longer seeds itself from this
    // page's own props, so their identity changing must not re-run it.
  }, [active, currentId]);

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
        // AniList only has two types, and a light novel is a MANGA whose
        // format says NOVEL — so anything that isn't an anime is printed.
        manga: (m.type ?? "ANIME") !== "ANIME",
        current: m.id === currentId,
        x: 0,
        y: 0,
        w: covers ? NODE_W_COVER : NODE_W,
        h: nodeHeight(title, covers),
      });
    }

    for (const id of Array.from(hidden)) seen.delete(id);

    // Printed works, out unless asked for. Nothing is orphaned by dropping
    // them: the walk never crosses a manga, so no anime hangs off one.
    if (!showManga) {
      for (const n of Array.from(seen.values())) if (n.manga) seen.delete(n.id);
    }

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
  }, [
    tree,
    currentId,
    titlePref,
    hidden,
    showManga,
    onlyFormats,
    onlyRelations,
    canonOnly,
    covers,
    rankDir,
  ]);

  /** Whether the franchise has anything printed at all — a chip that filters
   *  nothing is a chip that asks a question the board already answered. Read
   *  from the walk, not from `nodes`: pressing it empties the latter. */
  const hasManga = useMemo(
    () => tree.nodes.some((n) => (n.type ?? "ANIME") !== "ANIME"),
    [tree.nodes],
  );

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
   * rest.
   *
   * BEFORE the paint, not after: as an ordinary effect this ran once the
   * browser had already drawn the new layout at the OLD transform, so every
   * board flashed at `scale(1)` top-left for a frame before snapping into its
   * frame. See `useIsoLayoutEffect`.
   */
  useIsoLayoutEffect(() => {
    if (!active) return;
    const box = canvasRef.current;
    if (!box || width === 0 || height === 0) return;
    // A box with no size yet would "fit" the board to nothing and then be
    // remembered as fitted; let the next pass do it.
    if (!box.clientWidth || !box.clientHeight) return;
    // `open` is part of the key, so expanding and collapsing each re-frame the
    // board — on a view NOBODY HAS TOUCHED. An untouched board carried across
    // that step arrived badly: between a 378px strip and a full window the
    // carry is a factor of three, and One Piece (10053px of board) landed off
    // the corner of a view three times its size.
    const key = `${Math.round(width)}x${Math.round(height)}:${open ? "full" : "inline"}`;
    if (fittedFor.current === key) return;
    fittedFor.current = key;

    // A view the viewer set is theirs to keep. Expanding is a change of window,
    // not a change of subject: if you zoomed onto one branch and pressed ⤢, you
    // asked to see THAT branch bigger, and re-framing the whole franchise would
    // undo the two gestures you just made. The resize observer below carries it
    // across instead — the key is still marked, so this pass stays skipped.
    if (touchedView.current) return;

    const v = fitView(box.clientWidth, box.clientHeight, width + PAD * 2, height + PAD * 2);
    setScale(v.scale);
    setOffset({ x: v.x, y: v.y });
    touchedView.current = false;
    viewport.current = { w: box.clientWidth, h: box.clientHeight };
  }, [active, width, height, open]);

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
      // Recomputed from the scale actually obtained, exactly as in `zoomAt`: a
      // clamped zoom with an unclamped offset moves the board by a factor it
      // was never scaled by, and the view slides off the corner.
      const s = scaleRef.current;
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * Math.min(w / prev.w, h / prev.h)));
      const k = next / s;
      const o = liveOffset.current;
      const framed = {
        x: w / 2 - (prev.w / 2 - o.x) * k,
        y: h / 2 - (prev.h / 2 - o.y) * k,
      };
      liveOffset.current = framed;
      setScale(next);
      setOffset(framed);
    });
    ro.observe(box);
    return () => ro.disconnect();
    // The canvas node itself is swapped when the board moves between the inline
    // box and the overlay, so the observer has to follow that move — and
    // `mounted` for the same reason as the wheel below: there is no canvas to
    // observe on the pass before it flips.
  }, [active, open, mounted]);

  /**
   * Wheel-to-zoom, bound by hand so it can refuse the page its scroll.
   *
   * React's onWheel lands on a passive listener, which cannot preventDefault —
   * harmless in the overlay (there is nothing behind it to scroll), but in the
   * inline preview every zoom would also scroll the info page out from under
   * the graph.
   *
   * `mounted` is in the deps because the component renders NOTHING until it
   * flips: without it this ran once, against a ref still holding null, and
   * never again — the board is client-only, so the first pass has no canvas to
   * bind to. Opening the overlay changed `open` and re-ran it, which is why the
   * wheel zoomed full-screen and scrolled the page inline.
   */
  useEffect(() => {
    const box = canvasRef.current;
    if (!box) return;
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      // Anchored on the cursor: the card under the pointer is the one you are
      // asking about, so it is the one that must not move. `zoomAt` reads the
      // live scale and offset from refs, so this listener stays correct
      // although it is bound once and never rebound.
      const r = box.getBoundingClientRect();
      zoomAt(factor, e.clientX - r.left, e.clientY - r.top);
    };
    box.addEventListener("wheel", onWheelNative, { passive: false });
    return () => box.removeEventListener("wheel", onWheelNative);
  }, [active, open, mounted]);


  /** Where a card actually sits: its layout position plus any hand nudge. */
  const posOf = (n: GNode) => {
    const m = moved.get(n.id);
    return { x: n.x + (m?.dx ?? 0), y: n.y + (m?.dy ?? 0) };
  };

  /** Put a card in the middle of the viewport, at the current zoom. */
  const centreOn = (n: GNode) => {
    const box = canvasRef.current;
    if (!box) return;
    touchedView.current = true;
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
   * ⤢ expands the inline board to the overlay, and that is the LAST step.
   *
   * The overlay used to offer the browser's own fullscreen on top of itself, so
   * the board had three sizes and the second and third looked nearly alike —
   * the same black rectangle, minus the browser's chrome. Pressing it a second
   * time therefore read as "nothing happened", except that leaving now took two
   * gestures (Escape to drop fullscreen, Escape again to close) and the page
   * behind had scrolled somewhere on the way back.
   *
   * One expansion, one way back — but the button stays on BOTH sides of it,
   * showing the exit glyph once expanded. It is where the hand already is (the
   * control cluster it just pressed), where the eye looks for the way out of a
   * full-screen view, and it saves crossing the whole board to the ✕ in the far
   * corner. The two are not redundant: ✕ closes the dialog, this collapses it
   * back into the page, and here they happen to mean the same thing.
   */
  const toggleFullscreen = () => (open ? onClose() : onExpand?.());

  /**
   * Zoom, holding one point of the BOARD still under one point of the box.
   *
   * The board is `translate(offset) scale(scale)`, so a screen point p sits
   * over board point (p − offset) / scale. Scaling alone leaves `offset`
   * where it was, which pins the board's top-left corner: on a franchise laid
   * out to the right, zooming in walked away from whatever you were reading
   * and you had to pan back after every notch. Solving that expression for a
   * fixed board point gives the offset below.
   *
   * `k` is recomputed from the scale we actually got, not from `f`: at the
   * clamp the two differ, and using `f` there would drift the board on a zoom
   * that never happened.
   */
  const zoomAt = (f: number, px: number, py: number) => {
    const s = scaleRef.current;
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * f));
    if (next === s) return;
    const k = next / s;
    const o = liveOffset.current;
    const moved = { x: px - (px - o.x) * k, y: py - (py - o.y) * k };
    liveOffset.current = moved;
    touchedView.current = true;
    setScale(next);
    setOffset(moved);
  };

  /** The +/− buttons hold the MIDDLE of the box still — the closest thing to
   *  "where you are looking" when the gesture names no point of its own. */
  const zoomBy = (f: number) => {
    const box = canvasRef.current;
    if (!box) return;
    zoomAt(f, box.clientWidth / 2, box.clientHeight / 2);
  };
  const fitBoard = () => {
    const box = canvasRef.current;
    if (!box || !width || !height) return;
    const v = fitView(box.clientWidth, box.clientHeight, width + PAD * 2, height + PAD * 2);
    setScale(v.scale);
    setOffset({ x: v.x, y: v.y });
    // The button's whole job is a clean slate, so the framing goes back to
    // being the code's — expanding after a reset frames the board again.
    touchedView.current = false;
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
    if (panned) {
      setOffset(liveOffset.current);
      touchedView.current = true;
    }
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
              {/* Même clé que les cartes Related : le lien porte le même mot
                  ici et là, et l'anglais d'AniList ne traverse plus l'écran. */}
              {t(`anime.rel.${e.label}`, {
                defaultValue: e.label.replace(/_/g, " ").toLowerCase(),
              })}
            </span>
          );
        })}

        {nodes.map((n) => {
          const step = chain?.order.get(n.id);
          const lit = step !== undefined;
          const isSelected = n.id === selected;
          const isMatch = !!matches?.has(n.id);
          const done = isFinished(listMap?.get(n.id), n.episodes);
          /**
           * A manga card is a plain box, not a link.
           *
           * The site has no page for printed works, so `href` would land on a
           * 404 — and a link that goes nowhere is worse than no link: it looks
           * pressable, the cursor promises a page, and middle-click opens the
           * dead end in a tab. It still drags, still lights its neighbours,
           * still hides. It just doesn't navigate.
           */
          const Card: any = n.manga ? "div" : Link;
          return (
            <Card
              key={n.id}
              {...(n.manga
                ? null
                : {
                    href: animeHref(n.id, clickTarget),
                    title: t("anime.graphOpenEntry", { defaultValue: "Open this entry" }),
                  })}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
              // A card is a link, first press. The two-step it replaced —
              // one click to light the running order, another to open —
              // made every card need to be told twice, and the order it
              // lit is already what the board shows from the entry you
              // came from. Hovering still lights a card's neighbourhood,
              // which is the reading the click was standing in for.
              onPointerDown={(ev: React.PointerEvent) => onNodePointerDown(ev, n.id)}
              onPointerMove={onNodePointerMove}
              onPointerUp={onNodePointerUp}
              onClick={(ev: React.MouseEvent) => {
                // Nothing to navigate to, so nothing to guard or announce.
                if (n.manga) return;
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
              style={{
                ...gStyles.node,
                // Nothing to open: the card must not claim otherwise.
                ...(n.manga ? { cursor: "default" } : null),
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
            </Card>
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
          {/* Same rule as the chip below: the label is what PRESSING it gets
              you — "Manga", lit while they are on the board. Only offered when
              the franchise actually has one. */}
          {hasManga && (
            <button
              type="button"
              onClick={() => setShowManga((v) => !v)}
              style={{ ...gStyles.chip, ...(showManga ? gStyles.chipOn : null) }}
            >
              {t("anime.graphShowManga", { defaultValue: "Manga" })}
            </button>
          )}
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
              label: t(`anime.rel.${r}`, {
                defaultValue: r.replace(/_/g, " ").toLowerCase(),
              }),
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
        {walking && nodes.length === 0 ? (
          /**
           * The board being built, said as a board.
           *
           * The franchise arrives in one answer now, so between opening the
           * page and that answer there is nothing to draw — and an empty dot
           * grid with a line of grey text reads as "this anime has no
           * relations", which is the one thing it must not say. Ghost cards
           * strung along a rank tell you the shape that is coming.
           */
          <div style={gStyles.skeleton} aria-busy="true">
            <style>{SKELETON_KEYFRAMES}</style>
            {SKELETON_CARDS.map((c, i) => (
              <div
                key={i}
                style={{
                  ...gStyles.skelCard,
                  left: `${c.x}%`,
                  top: `${c.y}%`,
                  // Staggered, so the row reads left to right like the walk
                  // that fills it rather than pulsing as one block.
                  animationDelay: `${i * 0.12}s`,
                }}
              />
            ))}
          </div>
        ) : nodes.length === 0 ? (
          /* Empty means EMPTY — nothing came back at all.
             It used to mean "one card or fewer", on the reasoning that a lone
             card says nothing a franchise map is for. But the board is also
             what a filter leaves behind, and a series whose only neighbours are
             printed (its manga, its light novel) drops to exactly one card the
             moment the manga chip is off — so the page answered "no related
             entries" about a franchise it had just drawn. One card is an answer:
             this entry, and nothing else on this side of the filter. */
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

        {/* Zoom, expand, reset, and a way out. */}
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
            aria-label={
              open
                ? t("anime.graphExitFullscreen", { defaultValue: "Exit full screen" })
                : t("anime.graphFullscreen", { defaultValue: "Fullscreen" })
            }
            title={
              open
                ? t("anime.graphExitFullscreen", { defaultValue: "Exit full screen" })
                : t("anime.graphFullscreen", { defaultValue: "Fullscreen" })
            }
          >
            <Icon d={open ? ICON.fullscreenExit : ICON.fullscreen} />
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

/** Same reason as NAV_KEYFRAMES: the board is portalled, so the pulse ships
 *  with it. */
const SKELETON_KEYFRAMES = `@keyframes anig-skel {
  0%, 100% { opacity: 0.28; }
  50%      { opacity: 0.62; }
}`;

/**
 * Ghost cards in the shape of a franchise: four ranks, fanning out.
 *
 * Not a spinner — the thing being waited for has a recognisable form, and
 * showing it means the real board replaces something the eye has already
 * placed instead of arriving into a void.
 */
const SKELETON_CARDS = [
  { x: 6, y: 42 },
  { x: 27, y: 20 },
  { x: 27, y: 62 },
  { x: 48, y: 10 },
  { x: 48, y: 42 },
  { x: 48, y: 72 },
  { x: 69, y: 26 },
  { x: 69, y: 60 },
];

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
  /** Plain white lift, not the brand tint: hovering a row says "this is the one
   *  you would press", which must not look like "this one is selected". */
  menuItemHover: { background: "rgba(255,255,255,.07)", color: "var(--txt-1)" },
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
    minHeight: EMBED_HEADER_H,
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
  skeleton: {
    position: "absolute",
    inset: 0,
    // Above the dot grid, below the zoom controls — the controls stay live so
    // the view is not frozen while the franchise is on its way.
    pointerEvents: "none",
  },
  skelCard: {
    position: "absolute",
    width: "16%",
    height: "20%",
    minWidth: 54,
    minHeight: 34,
    borderRadius: 6,
    border: "1px solid #26262d",
    background: "linear-gradient(160deg, #17171c, #101014)",
    animation: "anig-skel 1.4s ease-in-out infinite",
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
    // Top padding clears the dismiss button — see NODE_CLOSE_CLEAR. Overridden
    // whole by `nodeTitleSide` when covers are on, which has no such clash.
    padding: `${10 + NODE_CLOSE_CLEAR}px 10px 8px`,
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
    /* Les majuscules venaient de l'enum brut ; la traduction est en bas de
       casse, et sans ça la pastille cesse de se lire comme une étiquette. */
    textTransform: "uppercase",
    color: "#7ec8ff",
    whiteSpace: "nowrap",
    pointerEvents: "none",
  },
};
