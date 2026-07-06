/**
 * Visual keyboard shortcut editor (overlay) — keyboard-only, matches the
 * reference screenshot.
 *
 *  - Blurred (frosted) backdrop over the player — not a black sheet.
 *  - Keys are flat dark fills, NO borders. A key that holds an action shows its
 *    icon; empty keys are blank. No printed letters. EVERY key is assignable,
 *    modifiers (shift/ctrl/alt/…) included.
 *  - Hovering ANY key shows a floating pill above the board ("Space :
 *    Play/Pause" or just the key name) and the key retracts (scale) — every
 *    key animates, assigned or not.
 *  - Rebinding = drag & drop, key ↔ key. Dropping onto an occupied key SWAPS
 *    the two actions. Every action ships with a default key and there is NO
 *    unbind path — the full catalog is always on the board.
 *  - Around the keyboard: only a small header (shortcut text left; Reset and ✕
 *    close on the right, directly above the board). Nothing else.
 */
import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
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
type Key = { code: string | null; w?: number; h?: number; ghost?: true };
type Cap = Key & { x: number; y: number };

// Full French (AZERTY) 75%-style layout, in the exact order requested: the nav
// keys sit INLINE at the end of each row (delete / home / pageup / up+pagedown /
// arrows) like on a laptop keyboard — no detached cluster. EVERY key is
// assignable, modifiers included: their code is the lower-cased `event.code`
// ("shiftleft", "altright", …) so left/right variants are distinct — matching
// `comboFromEvent`. Other keys use the `event.key` a French keyboard emits.
// Every row sums to exactly 16 units. `ghost` marks the cell hidden under the
// ISO Enter's lower half (nothing is drawn there).
const ROWS: Key[][] = [
  // escape 1..0 - = backspace delete
  [
    { code: "escape" },
    { code: "1" }, { code: "2" }, { code: "3" }, { code: "4" }, { code: "5" },
    { code: "6" }, { code: "7" }, { code: "8" }, { code: "9" }, { code: "0" },
    { code: "-" }, { code: "=" }, { code: "backspace", w: 2 },
    { code: "delete" },
  ],
  // tab a z e r t y u i o p ^ $ enter(2 rows) home
  [
    { code: "tab", w: 1.5 },
    { code: "a" }, { code: "z" }, { code: "e" }, { code: "r" }, { code: "t" },
    { code: "y" }, { code: "u" }, { code: "i" }, { code: "o" }, { code: "p" },
    { code: "^" }, { code: "$" }, { code: "enter", w: 1.5, h: 2 },
    { code: "home" },
  ],
  // capslock q s d f g h j k l m ù * [enter lower half] pageup
  [
    { code: "capslock", w: 1.75 },
    { code: "q" }, { code: "s" }, { code: "d" }, { code: "f" }, { code: "g" },
    { code: "h" }, { code: "j" }, { code: "k" }, { code: "l" }, { code: "m" },
    { code: "ù" }, { code: "*" },
    { code: null, w: 1.25, ghost: true }, // under the ISO Enter's lower half
    { code: "pageup" },
  ],
  // lshift w x c v b n , ; : ! rshift up pagedown
  [
    { code: "shiftleft", w: 1.25 },
    { code: "w" }, { code: "x" }, { code: "c" }, { code: "v" }, { code: "b" },
    { code: "n" }, { code: "," }, { code: ";" }, { code: ":" }, { code: "!" },
    { code: "shiftright", w: 2.75 },
    { code: "arrowup" }, { code: "pagedown" },
  ],
  // ctrl meta alt space altgr menu left down right
  [
    { code: "controlleft", w: 1.5 },
    { code: "metaleft", w: 1.25 },
    { code: "altleft", w: 1.25 },
    { code: "space", w: 6.5 },
    { code: "altright", w: 1.25 },
    { code: "contextmenu", w: 1.25 },
    { code: "arrowleft" }, { code: "arrowdown" }, { code: "arrowright" },
  ],
];

const GRID_W = Math.max(
  ...ROWS.map((r) => r.reduce((s, k) => s + (k.w ?? 1), 0)),
);
const GRID_H = ROWS.length;

const CAPS: Cap[] = ROWS.flatMap((row, y) => {
  let x = 0;
  return row.flatMap((k) => {
    const cap: Cap = { ...k, x, y };
    x += k.w ?? 1;
    return k.ghost ? [] : [cap];
  });
});

// Punctuation keys that live inside the main typing block and get the lighter
// "main" fill alongside letters/digits ( , ; : ! - = ^ $ ù * ). Kept as a Set
// so the regex doesn't have to escape metacharacters like - $ ^ *.
const MAIN_PUNCT = new Set([",", ";", ":", "!", "-", "=", "^", "$", "ù", "*"]);

// Fixed per-side gap inset drawn inside each key cell (so the visible gap
// between two keys is 2×). A fixed pixel value keeps the gap uniform on every
// side even though the grid isn't square.
const GAP_PX = 6;

function baseOf(combo: KeyCombo): string {
  const parts = combo.split("+");
  return parts[parts.length - 1];
}

function capGlyph(code: string): string {
  const map: Record<string, string> = {
    arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓",
    space: "Space", backspace: "⌫", enter: "↵", escape: "Esc", tab: "Tab",
    delete: "Suppr", home: "Home", pageup: "PgUp", pagedown: "PgDn",
    capslock: "⇪ Verr. Maj", shiftleft: "⇧ Maj", shiftright: "⇧ Maj",
    controlleft: "Ctrl", metaleft: "⊞", altleft: "Alt", altright: "AltGr",
    contextmenu: "☰ Menu",
  };
  return map[code] ?? code.toUpperCase();
}

export default function ShortcutEditor({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [binds, setBinds] = useState<Keybindings>(() => getKeybindings());
  const [hoverKey, setHoverKey] = useState<string | null>(null);
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

  /** Drop `action` on key `code`. If another action already sits there, the
   *  two SWAP places (the resident moves to the key `action` came from) —
   *  every action always stays bound; there is no unbind path. */
  const dropOnKey = useCallback(
    (action: ShortcutAction, code: string) => {
      const from = binds[action] ? baseOf(binds[action] as string) : null;
      const resident = actionForKey(code);
      if (resident === action) return;
      const next: Keybindings = { ...binds };
      next[action] = code;
      if (resident) next[resident] = from;
      persist(next);
    },
    [binds, actionForKey, persist],
  );

  const resetAll = () => setBinds({ ...resetKeybindings() });

  const onDragStart = (e: React.DragEvent, action: ShortcutAction) => {
    e.dataTransfer.setData("text/plain", action);
    e.dataTransfer.effectAllowed = "move";
    // Drag preview = a clone of the ACTUAL key being dragged, at its real size
    // and shape (so the space bar drags a wide ghost, the ISO Enter its L
    // shape, …). We snapshot the key element, position it off-screen at the
    // same box size, hand it to setDragImage, then remove it next tick.
    const src = e.currentTarget as HTMLElement;
    const rect = src.getBoundingClientRect();
    const ghost = src.cloneNode(true) as HTMLElement;
    ghost.style.cssText +=
      `;position:fixed;top:-9999px;left:-9999px;width:${rect.width}px;height:${rect.height}px;margin:0;transform:none;opacity:1;pointer-events:none`;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, rect.width / 2, rect.height / 2);
    window.setTimeout(() => ghost.remove(), 0);
  };
  const onDragEnd = () => setDropTarget(null);

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
      className="fixed inset-0 z-[9999] flex items-center justify-center px-4"
      style={{
        // Blurred glass over the player — NOT a black sheet.
        background: "rgba(0, 0, 0, 0.45)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full" style={{ maxWidth: "min(1200px, 92vw)" }}>
        {/* Directly above the keyboard, nothing else on screen: shortcut text
            on the left; Reset then the close ✕ on the right. */}
        <div className="mb-3 flex items-end justify-between">
          <div>
            <h2 className="text-[14px] font-semibold text-white">
              {t("shortcuts.title")}
            </h2>
            <p className="mt-0.5 text-[12px] text-white/50">
              {t("shortcuts.dragHint")}
            </p>
          </div>
          <div className="flex items-center gap-2">
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

        {/* Keyboard (relative so the hover pill can float above it). */}
        <div className="relative">
          {tooltip && (
            <div
              className="pointer-events-none absolute -top-11 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-lg px-4 py-2 text-[13px] font-semibold text-white shadow-2xl"
              style={{ background: "#16181d" }}
            >
              {tooltip}
            </div>
          )}

          {/* Keyboard — black, borderless, rounded bezel like the ref.
              Unit-based absolute grid so the ISO Enter can span two rows and
              every key keeps a real keyboard's proportions. GAP is drawn by
              insetting each key inside its cell (padding trick) so widths stay
              exact. */}
          <div
            className="relative w-full rounded-[18px] p-3"
            style={{ background: "#0b0c0f", aspectRatio: `${GRID_W} / ${GRID_H * 1.08}` }}
            onDragEnd={onDragEnd}
          >
            <div className="relative h-full w-full">
              {CAPS.map((cap, ci) => {
                const code = cap.code as string; // every rendered cap is assignable
                const action = actionForKey(code);
                const isHovered = hoverKey === code;
                const isDrop = dropTarget === code;
                const w = cap.w ?? 1;
                const h = cap.h ?? 1;
                // The ISO Enter: wide top half (row 1), narrower right-aligned
                // lower half (row 2) — two overlapping rounded rects, so every
                // convex corner stays rounded like the other keys.
                const isEnter = h === 2;
                // The main typing block (letters, digits, and the punctuation
                // that sits among them: , ; : ! - = ^ $ ù *) uses the lighter
                // fill; every other key (nav, modifiers, space, enter, tab, …)
                // is a shade darker so the typing area reads as a distinct
                // region. The tint applies whether or not the key holds an
                // action — an empty nav key stays darker than an empty letter.
                const isMain =
                  /^[a-z0-9]$/i.test(code) || MAIN_PUNCT.has(code);
                // Drop highlight is OPAQUE (not an alpha) so the ISO Enter's two
                // overlapping rects don't double-blend into a darker patch where
                // they cross.
                const bg = isDrop
                  ? "#6f2338"
                  : isMain
                  ? "#20242c"
                  : "#181b21";
                return (
                  <div
                    key={ci}
                    style={{
                      position: "absolute",
                      left: `${(cap.x / GRID_W) * 100}%`,
                      top: `${(cap.y / GRID_H) * 100}%`,
                      width: `${(w / GRID_W) * 100}%`,
                      height: `${(h / GRID_H) * 100}%`,
                      // Uniform gap on all sides via a fixed pixel inset on the
                      // inner cap — % padding wouldn't be uniform because the
                      // grid isn't square (16 cols × 5 rows).
                      padding: GAP_PX,
                    }}
                  >
                    <div
                      onMouseEnter={() => setHoverKey(code)}
                      onMouseLeave={() => setHoverKey(null)}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        setDropTarget(code);
                      }}
                      onDragLeave={() =>
                        setDropTarget((c) => (c === code ? null : c))
                      }
                      onDrop={(e) => {
                        e.preventDefault();
                        const a = e.dataTransfer.getData("text/plain") as ShortcutAction;
                        if (a) dropOnKey(a, code);
                        onDragEnd();
                      }}
                      draggable={!!action}
                      onDragStart={(e) => action && onDragStart(e, action)}
                      className="relative h-full w-full"
                      style={{
                        color: "rgba(255,255,255,0.92)",
                        cursor: action ? "grab" : "default",
                        transform: isHovered ? "scale(0.9)" : "scale(1)",
                        transition: "transform 110ms ease",
                      }}
                    >
                      {isEnter ? (
                        <>
                          <div
                            className="absolute left-0 top-0 h-1/2 w-full rounded-[8px]"
                            style={{ background: bg, transition: "background-color 110ms ease" }}
                          />
                          <div
                            className="absolute right-0 top-0 h-full rounded-[8px]"
                            style={{
                              width: `${(1.25 / 1.5) * 100}%`,
                              background: bg,
                              transition: "background-color 110ms ease",
                            }}
                          />
                        </>
                      ) : (
                        <div
                          className="absolute inset-0 rounded-[8px]"
                          style={{ background: bg, transition: "background-color 110ms ease" }}
                        />
                      )}
                      {action && (
                        // Absolutely-centred, FIXED-size icon: it never
                        // stretches with a wide key (space bar) or a tall one
                        // (Enter — centred on its top half).
                        <svg
                          viewBox="0 0 24 24"
                          width="26"
                          height="26"
                          className="pointer-events-none absolute left-1/2 -translate-x-1/2 -translate-y-1/2"
                          style={{ top: isEnter ? "25%" : "50%" }}
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
        </div>
      </div>
    </div>,
    document.body,
  );
}
