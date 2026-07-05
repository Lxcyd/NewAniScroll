/**
 * Visual keyboard shortcut editor (overlay) — keyboard-only, matches the
 * reference screenshot.
 *
 *  - Pure black background, NO card / border around the keyboard.
 *  - Keys are flat dark fills, NO borders. A key that holds an action shows its
 *    icon; empty keys are blank. No printed letters.
 *  - Hovering ANY key shows a floating pill above the board ("Space :
 *    Play/Pause" or just the key name) and the key retracts (scale) — every
 *    key animates, assigned or not.
 *  - Rebinding = drag & drop, key ↔ key. Dropping onto an occupied key SWAPS
 *    the two actions (no action is ever lost, so there's no "unassign").
 *    Actions not currently on the board sit in a slim tray below; drag one onto
 *    a key (swapping the resident back into the tray).
 */
import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  ACTION_CATALOG,
  type ShortcutAction,
  type Keybindings,
  type KeyCombo,
  comboToAction,
  getKeybindings,
  setKeybindings,
  resetKeybindings,
} from "@/lib/prefs/keybindings";
import { SHORTCUT_ICONS } from "./shortcutIcons";

const ACCENT = "#E94560";

// A key definition: `code` = normalized `event.key` we match against combos
// (null = decorative dead key, e.g. shift). `w` = width in units (1 = a
// standard key). `h` = row span (for the ISO Enter). No printed labels — a key
// stays blank unless an action is bound to it. `x`/`y` are COMPUTED (below) by
// walking each row left→right, so there are never manual-coordinate collisions.
type Key = { code: string | null; w?: number; h?: number };
type Cap = Key & { x: number; y: number };

// Full French (AZERTY) layout, in the exact order requested. Codes are the
// values a French keyboard emits for `event.key`, so pressing the physical key
// resolves the same combo. Each row is main-block keys, then the right nav
// cluster (delete / home / pageup / pagedown + arrows), positioned as on a real
// TKL board.
const ROWS: Key[][] = [
  // esc 1..0 - = backspace | delete
  [
    { code: "escape" },
    { code: "1" }, { code: "2" }, { code: "3" }, { code: "4" }, { code: "5" },
    { code: "6" }, { code: "7" }, { code: "8" }, { code: "9" }, { code: "0" },
    { code: "-" }, { code: "=" }, { code: "backspace", w: 2 },
  ],
  // tab a z e r t y u i o p ^ $ | (ISO Enter starts here, spans 2 rows)
  [
    { code: "tab", w: 1.5 },
    { code: "a" }, { code: "z" }, { code: "e" }, { code: "r" }, { code: "t" },
    { code: "y" }, { code: "u" }, { code: "i" }, { code: "o" }, { code: "p" },
    { code: "^" }, { code: "$" }, { code: "enter", w: 1.5, h: 2 },
  ],
  // home capslock q s d f g h j k l m ù *  (Enter overlaps the last cell)
  [
    { code: null, w: 1.75 }, // capslock
    { code: "q" }, { code: "s" }, { code: "d" }, { code: "f" }, { code: "g" },
    { code: "h" }, { code: "j" }, { code: "k" }, { code: "l" }, { code: "m" },
    { code: "ù" }, { code: "*" },
  ],
  // lshift w x c v b n , ; : ! rshift
  [
    { code: null, w: 1.25 }, // left shift
    { code: "w" }, { code: "x" }, { code: "c" }, { code: "v" }, { code: "b" },
    { code: "n" }, { code: "," }, { code: ";" }, { code: ":" }, { code: "!" },
    { code: null, w: 2.75 }, // right shift
  ],
  // ctrl meta alt space altgr menu
  [
    { code: null, w: 1.5 }, // ctrl
    { code: null, w: 1.25 }, // meta
    { code: null, w: 1.25 }, // alt
    { code: "space", w: 6.25 },
    { code: null, w: 1.25 }, // altgr
    { code: null, w: 1.5 }, // menu
  ],
];

// Right-hand nav/arrow cluster: [code, row, col] on a 3-wide mini grid that
// starts just right of the main block. row/col are 0-based within the cluster.
// Top two rows = delete/home/pageup + pagedown; bottom = inverted-T arrows.
const NAV: Array<{ code: string; row: number; col: number }> = [
  { code: "delete", row: 0, col: 0 },
  { code: "home", row: 0, col: 1 },
  { code: "pageup", row: 0, col: 2 },
  { code: "pagedown", row: 1, col: 2 },
  { code: "arrowup", row: 3, col: 1 },
  { code: "arrowleft", row: 4, col: 0 },
  { code: "arrowdown", row: 4, col: 1 },
  { code: "arrowright", row: 4, col: 2 },
];

// Compute absolute unit coords. Main block widest row sets MAIN_W; the nav
// cluster sits at MAIN_GAP units to its right.
const MAIN_GAP = 0.6;
const MAIN_W = Math.max(
  ...ROWS.map((r) => r.reduce((s, k) => s + (k.w ?? 1), 0)),
);
const NAV_X = MAIN_W + MAIN_GAP;
const GRID_W = NAV_X + 3; // nav cluster is 3 units wide
const GRID_H = 5;

const CAPS: Cap[] = [
  ...ROWS.flatMap((row, y) => {
    let x = 0;
    return row.map((k) => {
      const cap: Cap = { ...k, x, y };
      x += k.w ?? 1;
      return cap;
    });
  }),
  ...NAV.map(({ code, row, col }) => ({ code, x: NAV_X + col, y: row })),
];

function baseOf(combo: KeyCombo): string {
  const parts = combo.split("+");
  return parts[parts.length - 1];
}

function capGlyph(code: string): string {
  const map: Record<string, string> = {
    arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓",
    space: "Space", backspace: "⌫", enter: "↵", escape: "Esc", tab: "Tab",
  };
  return map[code] ?? code.toUpperCase();
}

export default function ShortcutEditor({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [binds, setBinds] = useState<Keybindings>(() => getKeybindings());
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [dragging, setDragging] = useState<ShortcutAction | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const actionLabel = useCallback(
    (id: ShortcutAction) => t(`shortcuts.actions.${id}`),
    [t],
  );

  const byCombo = useMemo(() => comboToAction(binds), [binds]);

  const persist = useCallback((next: Keybindings) => {
    setBinds(next);
    setKeybindings(next);
  }, []);

  const actionForKey = useCallback(
    (code: string): ShortcutAction | undefined => {
      let found: ShortcutAction | undefined;
      byCombo.forEach((action, combo) => {
        if (baseOf(combo) === code) found = action;
      });
      return found;
    },
    [byCombo],
  );

  /** Drop `action` on key `code`. If another action already sits there, the two
   *  SWAP places (the resident moves to wherever `action` came from). If
   *  `action` came from the tray (no prior key), the resident is evicted back
   *  to the tray. Nothing is ever silently unbound. */
  const dropOnKey = useCallback(
    (action: ShortcutAction, code: string) => {
      const from = binds[action] ? baseOf(binds[action] as string) : null;
      const resident = actionForKey(code);
      if (resident === action) return;
      const next: Keybindings = { ...binds };
      next[action] = code;
      if (resident) next[resident] = from; // from may be null (tray) → evicted
      persist(next);
    },
    [binds, actionForKey, persist],
  );

  const resetAll = () => setBinds({ ...resetKeybindings() });

  const unassigned = useMemo(
    () => ACTION_CATALOG.map((a) => a.id).filter((id) => !binds[id]),
    [binds],
  );

  const onDragStart = (e: React.DragEvent, action: ShortcutAction) => {
    e.dataTransfer.setData("text/plain", action);
    e.dataTransfer.effectAllowed = "move";
    setDragging(action);
  };
  const onDragEnd = () => {
    setDragging(null);
    setDropTarget(null);
  };

  const tooltip = (() => {
    if (!hoverKey) return null;
    const act = actionForKey(hoverKey);
    const glyph = capGlyph(hoverKey);
    return act ? `${glyph} : ${actionLabel(act)}` : glyph;
  })();

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[9999] flex flex-col"
      style={{ background: "#000" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Top bar */}
      <div className="flex items-start justify-between px-6 py-5">
        <div>
          <h2 className="text-[16px] font-semibold text-white">
            {t("shortcuts.title")}
          </h2>
          <p className="mt-0.5 text-[12px] text-white/45">
            {t("shortcuts.dragHint")}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={resetAll}
            className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-white/70 transition hover:bg-white/10 hover:text-white"
          >
            {t("shortcuts.reset")}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("shortcuts.close")}
            className="grid h-8 w-8 place-items-center rounded-lg text-white/70 transition hover:bg-white/10 hover:text-white"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
              <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Centered keyboard */}
      <div className="flex flex-1 flex-col items-center justify-center px-4">
        {/* Floating tooltip pill */}
        <div className="mb-5 flex h-9 items-center justify-center">
          {tooltip && (
            <div
              className="rounded-lg px-4 py-2 text-[14px] font-semibold text-white shadow-2xl"
              style={{ background: "#16181d" }}
            >
              {tooltip}
            </div>
          )}
        </div>

        {/* Keyboard — black, borderless, generous rounded bezel like the ref.
            Unit-based absolute grid so the ISO Enter can span two rows and every
            key keeps a real keyboard's proportions. GAP is drawn by insetting
            each key inside its cell (padding trick) so widths stay exact. */}
        <div
          className="relative w-full max-w-[1040px] rounded-[22px] p-4"
          style={{ background: "#0b0c0f", aspectRatio: `${GRID_W} / ${GRID_H * 1.08}` }}
          onDragEnd={onDragEnd}
        >
          <div className="relative h-full w-full">
            {CAPS.map((cap, ci) => {
              const code = cap.code;
              const action = code ? actionForKey(code) : undefined;
              const isHovered = !!code && hoverKey === code;
              const isDrop = !!code && dropTarget === code;
              const isDead = !code;
              const w = cap.w ?? 1;
              const h = cap.h ?? 1;
              const GAP = 0.55; // % of a unit, drawn as an inner inset
              return (
                <div
                  key={ci}
                  style={{
                    position: "absolute",
                    left: `${(cap.x / GRID_W) * 100}%`,
                    top: `${(cap.y / GRID_H) * 100}%`,
                    width: `${(w / GRID_W) * 100}%`,
                    height: `${(h / GRID_H) * 100}%`,
                    padding: `${(GAP / GRID_H)}%  ${(GAP / GRID_W)}%`,
                  }}
                >
                  <div
                    onMouseEnter={() => code && setHoverKey(code)}
                    onMouseLeave={() => setHoverKey(null)}
                    onDragOver={(e) => {
                      if (isDead) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      setDropTarget(code as string);
                    }}
                    onDragLeave={() =>
                      code && setDropTarget((c) => (c === code ? null : c))
                    }
                    onDrop={(e) => {
                      if (!code) return;
                      e.preventDefault();
                      const a = e.dataTransfer.getData("text/plain") as ShortcutAction;
                      if (a) dropOnKey(a, code);
                      onDragEnd();
                    }}
                    draggable={!!action}
                    onDragStart={(e) => action && onDragStart(e, action)}
                    className="relative h-full w-full rounded-[9px]"
                    style={{
                      background: isDrop
                        ? "rgba(233,69,96,0.35)"
                        : action
                        ? "#20242c"
                        : "#15171c",
                      color: "rgba(255,255,255,0.92)",
                      cursor: action ? "grab" : "default",
                      opacity: isDead ? 0.4 : 1,
                      transform: isHovered && !isDead ? "scale(0.9)" : "scale(1)",
                      transition: "transform 110ms ease, background-color 110ms ease",
                    }}
                  >
                    {action && (
                      // Absolutely-centred, FIXED-size icon: it never stretches
                      // with a wide key (space bar) or a tall one (Enter).
                      <svg
                        viewBox="0 0 24 24"
                        width="19"
                        height="19"
                        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
                      >
                        {SHORTCUT_ICONS[action]}
                      </svg>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <p className="mt-4 text-center text-[12px] text-white/35">
          {t("shortcuts.keyboardHint")}
        </p>

        {/* Tray: actions not on the board. Drag one onto a key; the resident (if
            any) swaps back here. Hidden when everything is placed. */}
        {unassigned.length > 0 && (
          <div
            className="mt-5 flex w-full max-w-[980px] flex-wrap items-center justify-center gap-2 rounded-xl p-3"
            style={{ background: "#0b0c0f" }}
          >
            {unassigned.map((id) => (
              <div
                key={id}
                draggable
                onDragStart={(e) => onDragStart(e, id)}
                onDragEnd={onDragEnd}
                onMouseEnter={() => setHoverKey(null)}
                className="flex cursor-grab items-center gap-2 rounded-lg px-2.5 py-1.5 transition active:cursor-grabbing"
                style={{
                  background: dragging === id ? "rgba(233,69,96,0.18)" : "#181a1f",
                }}
              >
                <svg viewBox="0 0 24 24" className="h-[16px] w-[16px] text-white/85">
                  {SHORTCUT_ICONS[id]}
                </svg>
                <span className="text-[12px] text-white/80">{actionLabel(id)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
