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
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  type ShortcutAction,
  type Keybindings,
  type KeyCombo,
  ACTION_CATALOG,
  comboToAction,
  getKeybindings,
  setKeybindings,
  resetKeybindings,
} from "@/lib/prefs/keybindings";
import { SHORTCUT_ICONS } from "./shortcutIcons";

const ACCENT = "#E94560";

const KNOWN_ACTIONS = new Set<string>(ACTION_CATALOG.map((a) => a.id));

// A key definition: `code` = lower-cased `event.code` (physical position) we
// match against combos (null = decorative ghost cell). `label` = glyph to show
// in the hover pill when it differs from the code (AZERTY caps). `w` = width in
// units (1 = a standard key). `h` = row span (for the ISO Enter). `x`/`y` are
// COMPUTED (below) by walking each row left→right, so there are never
// manual-coordinate collisions.
type Key = {
  code: string | null;
  label?: string;
  w?: number;
  h?: number;
  ghost?: true;
};
type Cap = Key & { x: number; y: number };

// Full French (AZERTY) 75%-style layout, in the exact order requested: the nav
// keys sit INLINE at the end of each row (delete / home / pageup / up+pagedown /
// arrows) like on a laptop keyboard — no detached cluster.
//
// `code` is the lower-cased `event.code` (PHYSICAL position, layout-agnostic) —
// this is what we store and what `comboFromEvent` matches, so a binding works
// regardless of keyboard layout and WITHOUT needing Shift (AZERTY digits/
// punctuation require Shift for their `event.key`, which broke key-based
// matching). `label` is what we print on the cap: for an AZERTY board the glyph
// differs from the physical code (the key at QWERTY-Q shows "A", etc.).
//
// Every row sums to exactly 16 units. `ghost` marks the cell hidden under the
// ISO Enter's lower half (nothing is drawn there).
const ROWS: Key[][] = [
  // escape 1..0 - = backspace delete
  [
    { code: "escape" },
    { code: "digit1", label: "1" }, { code: "digit2", label: "2" },
    { code: "digit3", label: "3" }, { code: "digit4", label: "4" },
    { code: "digit5", label: "5" }, { code: "digit6", label: "6" },
    { code: "digit7", label: "7" }, { code: "digit8", label: "8" },
    { code: "digit9", label: "9" }, { code: "digit0", label: "0" },
    { code: "minus", label: "-" }, { code: "equal", label: "=" },
    { code: "backspace", w: 2 },
    { code: "delete" },
  ],
  // tab a z e r t y u i o p ^ $ enter(2 rows) home
  [
    { code: "tab", w: 1.5 },
    { code: "keyq", label: "a" }, { code: "keyw", label: "z" },
    { code: "keye", label: "e" }, { code: "keyr", label: "r" },
    { code: "keyt", label: "t" }, { code: "keyy", label: "y" },
    { code: "keyu", label: "u" }, { code: "keyi", label: "i" },
    { code: "keyo", label: "o" }, { code: "keyp", label: "p" },
    { code: "bracketleft", label: "^" }, { code: "bracketright", label: "$" },
    { code: "enter", w: 1.5, h: 2 },
    { code: "home" },
  ],
  // capslock q s d f g h j k l m ù * [enter lower half] pageup
  [
    { code: "capslock", w: 1.75 },
    { code: "keya", label: "q" }, { code: "keys", label: "s" },
    { code: "keyd", label: "d" }, { code: "keyf", label: "f" },
    { code: "keyg", label: "g" }, { code: "keyh", label: "h" },
    { code: "keyj", label: "j" }, { code: "keyk", label: "k" },
    { code: "keyl", label: "l" }, { code: "semicolon", label: "m" },
    { code: "quote", label: "ù" }, { code: "backslash", label: "*" },
    { code: null, w: 1.25, ghost: true }, // under the ISO Enter's lower half
    { code: "pageup" },
  ],
  // lshift w x c v b n , ; : ! rshift up pagedown
  [
    { code: "shiftleft", w: 1.25 },
    { code: "keyz", label: "w" }, { code: "keyx", label: "x" },
    { code: "keyc", label: "c" }, { code: "keyv", label: "v" },
    { code: "keyb", label: "b" }, { code: "keyn", label: "n" },
    // AZERTY bottom row: the physical positions are QWERTY M , . / — so these
    // caps' event.code is KeyM/Comma/Period/Slash (NOT the glyph names).
    { code: "keym", label: "," }, { code: "comma", label: ";" },
    { code: "period", label: ":" }, { code: "slash", label: "!" },
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

// Physical codes of the keys inside the main typing block (letters + digits +
// the punctuation among them) — they get the lighter "main" fill. Digits and
// letters are matched by prefix (digit*/key*); these are the extra codes whose
// physical name isn't key*/digit* but which are still part of the AZERTY typing
// block: the "m" cap is physically `semicolon`, and the , ; : ! - = ^ $ ù *
// punctuation.
const MAIN_PUNCT = new Set([
  "semicolon", "comma", "period", "slash", "minus", "equal",
  "bracketleft", "bracketright", "quote", "backslash",
]);

// Fixed per-side gap inset drawn inside each key cell (so the visible gap
// between two keys is 2×). A fixed pixel value keeps the gap uniform on every
// side even though the grid isn't square.
const GAP_PX = 6;

function baseOf(combo: KeyCombo): string {
  const parts = combo.split("+");
  return parts[parts.length - 1];
}

// code → printed label for the AZERTY caps (letters/digits/punctuation whose
// physical code doesn't read like their glyph).
const CODE_LABEL: Record<string, string> = Object.fromEntries(
  ROWS.flatMap((r) => r)
    .filter((k): k is Key & { code: string; label: string } =>
      !!k.code && !!k.label,
    )
    .map((k) => [k.code, k.label]),
);

// Human-readable NAME for each key (never a symbol/icon) — used by the hover
// tooltip so e.g. Enter reads "Entrée", not "↵".
function capGlyph(code: string): string {
  const named: Record<string, string> = {
    arrowleft: "Flèche gauche", arrowright: "Flèche droite",
    arrowup: "Flèche haut", arrowdown: "Flèche bas",
    space: "Espace", backspace: "Retour arrière", enter: "Entrée",
    escape: "Échap", tab: "Tab", delete: "Suppr", home: "Début",
    pageup: "Page préc.", pagedown: "Page suiv.", capslock: "Verr. Maj",
    shiftleft: "Maj gauche", shiftright: "Maj droite",
    controlleft: "Ctrl", metaleft: "Windows", altleft: "Alt",
    altright: "AltGr", contextmenu: "Menu",
  };
  return named[code] ?? CODE_LABEL[code]?.toUpperCase() ?? code.toUpperCase();
}

export default function ShortcutEditor({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [binds, setBinds] = useState<Keybindings>(() => getKeybindings());
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // Lock the page behind the editor: while the overlay is open the underlying
  // page (player + comments) must not scroll on wheel/touch/space/arrows.
  useEffect(() => {
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    const stopScroll = (e: Event) => e.preventDefault();
    // `passive:false` is required or preventDefault() is ignored on wheel/touch.
    window.addEventListener("wheel", stopScroll, { passive: false });
    window.addEventListener("touchmove", stopScroll, { passive: false });
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("wheel", stopScroll);
      window.removeEventListener("touchmove", stopScroll);
    };
  }, []);

  const actionLabel = useCallback(
    (id: ShortcutAction) => t(`shortcuts.actions.${id}`),
    [t],
  );

  // Escape closes the editor. Capture phase + stopPropagation so the player's
  // own key handler (which is suspended while the editor is open) never sees it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const byCombo = useMemo(() => comboToAction(binds), [binds]);

  const persist = useCallback((next: Keybindings) => {
    setBinds(next);
    setKeybindings(next);
  }, []);

  const actionForKey = useCallback(
    (code: string): ShortcutAction | undefined => {
      let found: ShortcutAction | undefined;
      byCombo.forEach((action, combo) => {
        // Only surface real catalog actions — a stale/bogus id must never paint
        // a phantom binding with an empty "shortcuts.actions." label.
        if (baseOf(combo) === code && KNOWN_ACTIONS.has(action)) found = action;
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
    // Drag preview: an OPAQUE tile at the key's REAL box size (wide for the
    // space bar), so the ghost matches the key you grabbed. Cloning the key
    // produced a mostly-transparent element (its fill lives on absolutely-
    // positioned children) → a blurry oval halo; a solid div with the icon
    // gives a crisp rectangle.
    //
    // CRUCIAL: the ghost must be rendered ON-SCREEN AND ON TOP (positive
    // z-index) for the browser to rasterize it. At top:-9999px Chrome refuses
    // to snapshot it (and for a wide element like the ~500px space bar that
    // refusal cancels the whole drag); at z-index:-1 it sits BEHIND the opaque
    // page, so the snapshot came out almost entirely transparent. We place it at
    // top:0/left:0 on top of everything for the single frame the browser needs
    // to grab the image, then remove it on the next tick (pointer-events:none so
    // it never intercepts the drag).
    const src = e.currentTarget as HTMLElement;
    // Measure the OUTER cell (the padded grid slot), not the inner cap: the cap
    // carries `transform: scale(0.9)` while hovered — and a key is ALWAYS
    // hovered at the instant you grab it — so the cap's own rect is 10% smaller
    // than the real key (that's why the Entrée ghost came out too small). The
    // parent cell is never scaled and always reports the true footprint.
    const box = (src.parentElement ?? src).getBoundingClientRect();
    // The ISO Enter's inner cap is the full 1.5u × 2-row rectangle, but the
    // VISIBLE cap is an L-shape: a 1.5u top half over a 1.25u lower half. Its
    // wide, single-row top half is what reads as "the Enter key", so size the
    // ghost like a normal one-row tile (top half) rather than the tall bounding
    // box — a full 2-row-tall ghost looked wrong too.
    const isEnter = (e.currentTarget as HTMLElement).dataset.enter === "1";
    // Strip the GAP inset back out so the ghost matches the DRAWN cap, not the
    // slot around it.
    //
    // Width CAP (crucial): Chrome silently fails to rasterize a setDragImage
    // element past a certain width — the wide space bar (≈500px) came back
    // almost fully transparent. 360px still failed; 240px is the value that was
    // proven to snapshot reliably, so clamp there. The space bar still reads as
    // a rectangle, just not full physical width.
    const gw = Math.min(box.width - GAP_PX * 2, 240);
    // One-row cap height. For the ISO Enter the cell spans two rows, so a single
    // visual row is half the cell; the Enter ghost is built at full (two-row)
    // height as an L-shape, but its icon and drag hotspot sit on this top row.
    const rowH = box.height / (isEnter ? 2 : 1) - GAP_PX * 2;
    const ghost = document.createElement("div");
    if (isEnter) {
      // Reproduce the drawn L-shape: a wide top half (full 1.5u width, one row
      // tall) over a narrower right-aligned lower half (1.25/1.5 width, one row
      // tall). Two overlapping rounded rects, exactly like the on-board cap.
      //
      // NO box-shadow / border on the two rects: the inner 1px liseré is what
      // drew the visible SEAM between them (each rect outlined itself at the
      // overlap). Just the flat opaque fill, like the real cap. The lower rect
      // starts half a row UP (top:25%) and the top rect overlaps it, so the two
      // fuse into one solid L with no line where they meet.
      const fullH = box.height - GAP_PX * 2;
      const lowerW = gw * (1.25 / 1.5);
      ghost.style.cssText =
        `position:fixed;top:0;left:0;z-index:2147483647;opacity:1;pointer-events:none;` +
        `width:${gw}px;height:${fullH}px;` +
        `filter:drop-shadow(0 0 0.5px rgba(255,255,255,.06))`;
      const top = document.createElement("div");
      top.style.cssText =
        `position:absolute;left:0;top:0;width:100%;height:50%;border-radius:8px;` +
        `background:#20242c`;
      const lower = document.createElement("div");
      lower.style.cssText =
        `position:absolute;right:0;top:0;width:${lowerW}px;height:100%;border-radius:8px;` +
        `background:#20242c`;
      ghost.appendChild(lower);
      ghost.appendChild(top);
    } else {
      ghost.style.cssText =
        `position:fixed;top:0;left:0;z-index:2147483647;opacity:1;pointer-events:none;` +
        `width:${gw}px;height:${rowH}px;` +
        "border-radius:8px;background:#20242c;display:flex;align-items:center;justify-content:center;" +
        "color:#fff;box-shadow:0 0 0 1px rgba(255,255,255,.06)";
    }
    const iconSrc = src.querySelector("svg");
    if (iconSrc) {
      const clone = iconSrc.cloneNode(true) as SVGElement;
      // The key's <svg> is absolutely positioned + translated (className
      // "absolute left-1/2 -translate-x-1/2 …") so it sits centred INSIDE the
      // key. Strip BOTH the class and the inline style, then place it:
      // flex-centred for a plain key; absolutely centred on the TOP half for the
      // Enter L-shape (the icon reads on the wide bar, not the corner).
      clone.removeAttribute("class");
      clone.removeAttribute("style");
      clone.style.transform = "none";
      clone.style.flex = "0 0 auto";
      clone.setAttribute("width", "26");
      clone.setAttribute("height", "26");
      if (isEnter) {
        clone.style.position = "absolute";
        clone.style.left = "50%";
        clone.style.top = "25%";
        clone.style.transform = "translate(-50%,-50%)";
        clone.style.zIndex = "1";
        clone.style.color = "#fff";
      } else {
        clone.style.position = "static";
      }
      ghost.appendChild(clone);
    }
    document.body.appendChild(ghost);
    // Force a synchronous layout/paint so the element is actually rasterizable
    // when setDragImage snapshots it THIS tick — otherwise Chrome can grab an
    // empty (transparent) image, which is why the wide space-bar ghost came out
    // see-through.
    void ghost.offsetWidth;
    // Hotspot on the (top-row) centre so the ghost tracks the cursor from where
    // the icon sits, for both a plain key and the Enter L-shape.
    e.dataTransfer.setDragImage(ghost, gw / 2, rowH / 2);
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
                  code.startsWith("key") ||
                  code.startsWith("digit") ||
                  MAIN_PUNCT.has(code);
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
                      data-enter={isEnter ? "1" : undefined}
                      onDragStart={(e) => {
                        // A key with no action must never start a drag (the
                        // browser would otherwise drag the bare cell — you could
                        // "grab" Entrée/Suppr and drop them onto real keys).
                        if (!action) {
                          e.preventDefault();
                          return;
                        }
                        onDragStart(e, action);
                      }}
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
