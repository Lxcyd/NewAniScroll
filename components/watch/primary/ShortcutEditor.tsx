/**
 * Visual keyboard shortcut editor (overlay).
 *
 * Interaction model (per user request, inspired by the reference layout):
 *   - The keyboard renders CLEAN — no printed key letters. A key shows the
 *     icon of the action bound to it, and nothing otherwise.
 *   - Hovering a key reveals its name (e.g. "A", "Space", "←") in a floating
 *     tooltip — the only place the key label appears.
 *   - Rebinding is DRAG & DROP: grab an action from the left list (or lift an
 *     icon off a key) and drop it onto the target key. A key holds one action;
 *     dropping onto an occupied key swaps the resident out (back to unassigned).
 *   - Drop an action outside the keyboard (or onto the "remove" strip) to
 *     unbind it. Reset restores the shipped defaults.
 *
 * Visual style matches the reference: near-black bezel, flat dark keys, white
 * glyphs, accent highlight on the active drop target.
 */
import { useCallback, useMemo, useRef, useState } from "react";
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

// ── Physical keyboard layout ────────────────────────────────────────────────
// `code` = normalized base-key token we match against a combo (see
// comboFromEvent). `w` = flex weight (1 = standard key). `null` code = a
// decorative dead key (modifiers) that can't hold an action. No printed labels:
// the key stays blank unless an action is bound to it.
type Cap = { code: string | null; w?: number };

const ROWS: Cap[][] = [
  [
    { code: "escape" },
    { code: "1" }, { code: "2" }, { code: "3" }, { code: "4" }, { code: "5" },
    { code: "6" }, { code: "7" }, { code: "8" }, { code: "9" }, { code: "0" },
    { code: "-" }, { code: "=" },
    { code: "backspace", w: 2 },
  ],
  [
    { code: "tab", w: 1.5 },
    { code: "q" }, { code: "w" }, { code: "e" }, { code: "r" }, { code: "t" },
    { code: "y" }, { code: "u" }, { code: "i" }, { code: "o" }, { code: "p" },
    { code: "[" }, { code: "]" },
    { code: "\\", w: 1.5 },
  ],
  [
    { code: null, w: 1.75 },
    { code: "a" }, { code: "s" }, { code: "d" }, { code: "f" }, { code: "g" },
    { code: "h" }, { code: "j" }, { code: "k" }, { code: "l" },
    { code: ";" }, { code: "'" },
    { code: "enter", w: 2.25 },
  ],
  [
    { code: null, w: 2.25 },
    { code: "z" }, { code: "x" }, { code: "c" }, { code: "v" }, { code: "b" },
    { code: "n" }, { code: "m" },
    { code: "," }, { code: "." }, { code: "/" },
    { code: null, w: 2.25 },
  ],
  [
    { code: null, w: 1.5 },
    { code: null, w: 1.25 },
    { code: "space", w: 6 },
    { code: null, w: 1.25 },
    { code: "arrowleft" },
    { code: "arrowup" },
    { code: "arrowdown" },
    { code: "arrowright" },
  ],
];

type ActionMetaGroup = "playback" | "navigation" | "skip" | "audio" | "speed" | "view";

/** Base token of a combo (drops modifiers). */
function baseOf(combo: KeyCombo): string {
  const parts = combo.split("+");
  return parts[parts.length - 1];
}

/** Human key label, shown only on hover. */
function capGlyph(code: string): string {
  const map: Record<string, string> = {
    arrowleft: "←",
    arrowright: "→",
    arrowup: "↑",
    arrowdown: "↓",
    space: "Space",
    backspace: "⌫",
    enter: "↵",
    escape: "Esc",
    tab: "Tab",
    "-": "-",
    "=": "=",
    "[": "[",
    "]": "]",
    "\\": "\\",
    ";": ";",
    "'": "'",
    ",": ",",
    ".": ".",
    "/": "/",
  };
  return map[code] ?? code.toUpperCase();
}

export default function ShortcutEditor({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [binds, setBinds] = useState<Keybindings>(() => getKeybindings());
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  // The action currently being dragged (from the list or lifted off a key).
  const [dragging, setDragging] = useState<ShortcutAction | null>(null);
  // The key currently under the drag (accent highlight).
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

  /** Assign `action` to physical key `code`. A key holds one action: any action
   *  already on that key is unbound; the moved action leaves its old key. */
  const assign = useCallback(
    (action: ShortcutAction, code: string) => {
      const next: Keybindings = { ...binds };
      // Evict whatever currently sits on this key.
      (Object.keys(next) as ShortcutAction[]).forEach((a) => {
        if (a !== action && next[a] && baseOf(next[a] as string) === code) {
          next[a] = null;
        }
      });
      next[action] = code;
      persist(next);
    },
    [binds, persist],
  );

  const unbind = useCallback(
    (action: ShortcutAction) => persist({ ...binds, [action]: null }),
    [binds, persist],
  );

  const resetAll = () => setBinds({ ...resetKeybindings() });

  // Group actions for the list.
  const groups = useMemo(() => {
    const order: ActionMetaGroup[] = [
      "playback",
      "navigation",
      "skip",
      "audio",
      "speed",
      "view",
    ];
    return order.map((g) => ({
      group: g,
      items: ACTION_CATALOG.filter((a) => a.group === g),
    }));
  }, []);

  const onDragStart = (e: React.DragEvent, action: ShortcutAction) => {
    e.dataTransfer.setData("text/plain", action);
    e.dataTransfer.effectAllowed = "move";
    setDragging(action);
  };
  const onDragEnd = () => {
    setDragging(null);
    setDropTarget(null);
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-[1180px] flex-col overflow-hidden rounded-2xl"
        style={{ background: "#0d0f14", border: "1px solid rgba(255,255,255,0.08)" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
          <div>
            <h2 className="text-[15px] font-semibold text-white">
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

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5 lg:flex-row">
          {/* LEFT — draggable action list. Dropping an action back here unbinds it. */}
          <div
            className="w-full shrink-0 space-y-3 overflow-y-auto rounded-xl p-1 transition lg:w-[330px]"
            style={{
              outline: dragging ? "1px dashed rgba(255,255,255,0.15)" : "none",
            }}
            onDragOver={(e) => {
              // Allow dropping here to UNBIND the dragged action.
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDrop={(e) => {
              e.preventDefault();
              const a = e.dataTransfer.getData("text/plain") as ShortcutAction;
              if (a) unbind(a);
              onDragEnd();
            }}
          >
            {groups.map(({ group, items }) => (
              <div key={group}>
                <div className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-white/35">
                  {t(`shortcuts.groups.${group}`)}
                </div>
                <div className="space-y-1">
                  {items.map((a) => {
                    const combo = binds[a.id] ?? null;
                    return (
                      <div
                        key={a.id}
                        draggable
                        onDragStart={(e) => onDragStart(e, a.id)}
                        onDragEnd={onDragEnd}
                        onMouseEnter={() => setHoverKey(combo ? baseOf(combo) : null)}
                        onMouseLeave={() => setHoverKey(null)}
                        className="flex cursor-grab items-center gap-2 rounded-lg px-2 py-1.5 transition active:cursor-grabbing"
                        style={{
                          background:
                            dragging === a.id
                              ? "rgba(233,69,96,0.16)"
                              : "rgba(255,255,255,0.03)",
                          border: `1px solid ${
                            dragging === a.id ? ACCENT : "transparent"
                          }`,
                          opacity: dragging && dragging !== a.id ? 0.55 : 1,
                        }}
                      >
                        {/* drag dots */}
                        <span className="shrink-0 text-white/25">
                          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                            <path d="M9 5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zm0 7a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zm0 7a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zm9-14a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zm0 7a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zm0 7a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
                          </svg>
                        </span>
                        <span className="grid h-6 w-6 shrink-0 place-items-center text-white/85">
                          <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]">
                            {SHORTCUT_ICONS[a.id]}
                          </svg>
                        </span>
                        <span className="flex-1 truncate text-[13px] text-white/85">
                          {actionLabel(a.id)}
                        </span>
                        {combo ? (
                          <span
                            className="rounded-md border border-white/12 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-white/60"
                            title={capGlyph(baseOf(combo))}
                          >
                            {capGlyph(baseOf(combo))}
                          </span>
                        ) : (
                          <span className="rounded-md border border-dashed border-white/12 px-1.5 py-0.5 text-[10px] text-white/30">
                            {t("shortcuts.unassigned")}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* RIGHT — physical keyboard (drop targets) */}
          <div className="flex min-w-0 flex-1 items-start justify-center">
            <Keyboard
              byCombo={byCombo}
              hoverKey={hoverKey}
              dropTarget={dropTarget}
              dragging={dragging}
              actionLabel={actionLabel}
              onHoverKey={setHoverKey}
              onKeyDragOver={(code) => setDropTarget(code)}
              onKeyDragLeave={(code) =>
                setDropTarget((cur) => (cur === code ? null : cur))
              }
              onKeyDrop={(code, e) => {
                e.preventDefault();
                const a = e.dataTransfer.getData("text/plain") as ShortcutAction;
                if (a) assign(a, code);
                onDragEnd();
              }}
              onKeyGrab={(action, e) => onDragStart(e, action)}
              onKeyGrabEnd={onDragEnd}
              onKeyClear={(action) => unbind(action)}
              draggingAction={dragging}
            />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Keyboard({
  byCombo,
  hoverKey,
  dropTarget,
  dragging,
  actionLabel,
  onHoverKey,
  onKeyDragOver,
  onKeyDragLeave,
  onKeyDrop,
  onKeyGrab,
  onKeyGrabEnd,
  onKeyClear,
  draggingAction,
}: {
  byCombo: Map<KeyCombo, ShortcutAction>;
  hoverKey: string | null;
  dropTarget: string | null;
  dragging: ShortcutAction | null;
  actionLabel: (id: ShortcutAction) => string;
  onHoverKey: (code: string | null) => void;
  onKeyDragOver: (code: string) => void;
  onKeyDragLeave: (code: string) => void;
  onKeyDrop: (code: string, e: React.DragEvent) => void;
  onKeyGrab: (action: ShortcutAction, e: React.DragEvent) => void;
  onKeyGrabEnd: () => void;
  onKeyClear: (action: ShortcutAction) => void;
  draggingAction: ShortcutAction | null;
}) {
  const { t } = useTranslation();

  const actionForKey = (code: string): ShortcutAction | undefined => {
    let found: ShortcutAction | undefined;
    byCombo.forEach((action, combo) => {
      if (baseOf(combo) === code) found = action;
    });
    return found;
  };

  // Tooltip: key name (+ its action, if any). Only shown on hover.
  const tooltip = (() => {
    if (!hoverKey) return null;
    const act = actionForKey(hoverKey);
    const glyph = capGlyph(hoverKey);
    return act ? `${glyph} · ${actionLabel(act)}` : glyph;
  })();

  return (
    <div className="w-full max-w-[900px]">
      {/* Tooltip strip */}
      <div className="mb-3 flex h-8 items-center justify-center">
        {tooltip && (
          <div
            className="rounded-md px-3 py-1.5 text-[13px] font-medium text-white shadow-lg"
            style={{ background: "#000", border: "1px solid rgba(255,255,255,0.12)" }}
          >
            {tooltip}
          </div>
        )}
      </div>

      {/* Bezel */}
      <div
        className="space-y-1.5 rounded-2xl p-3"
        style={{
          background: "#0a0b0e",
          border: "3px solid #000",
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.03)",
        }}
      >
        {ROWS.map((row, ri) => (
          <div key={ri} className="flex gap-1.5">
            {row.map((cap, ci) => {
              const code = cap.code;
              const action = code ? actionForKey(code) : undefined;
              const isHovered = !!code && hoverKey === code;
              const isDrop = !!code && dropTarget === code;
              const isDead = !code;
              return (
                <div
                  key={ci}
                  onMouseEnter={() => code && onHoverKey(code)}
                  onMouseLeave={() => onHoverKey(null)}
                  onDragOver={(e) => {
                    if (isDead) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    onKeyDragOver(code as string);
                  }}
                  onDragLeave={() => code && onKeyDragLeave(code)}
                  onDrop={(e) => code && onKeyDrop(code, e)}
                  // The icon of an assigned key is itself draggable (lift &
                  // move it to another key, or drop it on the list to clear).
                  draggable={!!action}
                  onDragStart={(e) => action && onKeyGrab(action, e)}
                  onDragEnd={onKeyGrabEnd}
                  onDoubleClick={() => action && onKeyClear(action)}
                  className="relative grid h-11 min-w-0 place-items-center rounded-md transition-colors"
                  style={{
                    flex: cap.w ?? 1,
                    background: isDrop
                      ? "rgba(233,69,96,0.28)"
                      : action
                      ? "rgba(255,255,255,0.09)"
                      : "rgba(255,255,255,0.028)",
                    border: `1px solid ${
                      isDrop
                        ? ACCENT
                        : isHovered
                        ? "rgba(255,255,255,0.4)"
                        : action
                        ? "rgba(255,255,255,0.16)"
                        : "rgba(255,255,255,0.045)"
                    }`,
                    cursor: action ? "grab" : isDead ? "default" : "default",
                    color: "rgba(255,255,255,0.92)",
                    // Dim dead keys slightly so the assignable field reads clearly.
                    opacity: isDead ? 0.5 : 1,
                  }}
                >
                  {action && (
                    <svg viewBox="0 0 24 24" className="pointer-events-none h-[18px] w-[18px]">
                      {SHORTCUT_ICONS[action]}
                    </svg>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <p className="mt-3 text-center text-[11px] text-white/35">
        {draggingAction
          ? t("shortcuts.dropOnKey")
          : t("shortcuts.keyboardHint")}
      </p>
    </div>
  );
}
