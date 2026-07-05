/**
 * Visual keyboard shortcut editor (overlay) — keyboard-first design.
 *
 * Matches the reference screenshot the user shared:
 *   - Just the KEYBOARD, centered. No side list, no bordered card around it.
 *   - Each key that holds an action shows that action's icon; other keys are
 *     blank. No printed letters.
 *   - Hovering a key shows a floating dark pill above the board ("Space :
 *     Play/Pause") AND the key visually retracts / shrinks a touch.
 *   - Rebinding is drag & drop: lift an icon off a key and drop it on another
 *     key to move it. Double-click a key to free it.
 *   - Any actions that aren't on the board sit in a slim tray under the
 *     keyboard so they can be dragged on; the tray hides itself when empty.
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

type Cap = { code: string | null; w?: number };

// Physical layout. No printed labels — keys stay blank unless bound.
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

  const assign = useCallback(
    (action: ShortcutAction, code: string) => {
      const next: Keybindings = { ...binds };
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

  const actionForKey = (code: string): ShortcutAction | undefined => {
    let found: ShortcutAction | undefined;
    byCombo.forEach((action, combo) => {
      if (baseOf(combo) === code) found = action;
    });
    return found;
  };

  // Actions with no key on the board → shown in the bottom tray.
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

  // Tooltip content for the hovered key.
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
      style={{ background: "rgba(6,7,10,0.92)", backdropFilter: "blur(6px)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Top bar — title + reset + close. No card around the keyboard. */}
      <div className="flex items-start justify-between px-6 py-5">
        <div>
          <h2 className="text-[16px] font-semibold text-white">
            {t("shortcuts.title")}
          </h2>
          <p className="mt-0.5 text-[12px] text-white/50">
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
        {/* Floating tooltip pill (above the board) */}
        <div className="mb-4 flex h-9 items-center justify-center">
          {tooltip && (
            <div
              className="rounded-lg px-4 py-2 text-[14px] font-semibold text-white shadow-2xl"
              style={{ background: "#000", border: "1px solid rgba(255,255,255,0.14)" }}
            >
              {tooltip}
            </div>
          )}
        </div>

        <div
          className="w-full max-w-[1000px] space-y-2 rounded-2xl p-3.5"
          style={{
            background: "#0a0b0e",
            border: "4px solid #000",
            boxShadow: "0 30px 80px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.03)",
          }}
          onDragEnd={onDragEnd}
        >
          {ROWS.map((row, ri) => (
            <div key={ri} className="flex gap-2">
              {row.map((cap, ci) => {
                const code = cap.code;
                const action = code ? actionForKey(code) : undefined;
                const isHovered = !!code && hoverKey === code;
                const isDrop = !!code && dropTarget === code;
                const isDead = !code;
                return (
                  <div
                    key={ci}
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
                      if (a) assign(a, code);
                      onDragEnd();
                    }}
                    draggable={!!action}
                    onDragStart={(e) => action && onDragStart(e, action)}
                    onDoubleClick={() => action && unbind(action)}
                    className="relative grid place-items-center rounded-lg"
                    style={{
                      flex: cap.w ?? 1,
                      height: 52,
                      background: isDrop
                        ? "rgba(233,69,96,0.30)"
                        : action
                        ? "rgba(255,255,255,0.08)"
                        : "rgba(255,255,255,0.022)",
                      border: `1px solid ${
                        isDrop
                          ? ACCENT
                          : action
                          ? "rgba(255,255,255,0.14)"
                          : "rgba(255,255,255,0.05)"
                      }`,
                      color: "rgba(255,255,255,0.92)",
                      cursor: action ? "grab" : "default",
                      opacity: isDead ? 0.55 : 1,
                      // Retract / shrink on hover (the SS animation).
                      transform: isHovered && !isDead ? "scale(0.9)" : "scale(1)",
                      transition:
                        "transform 120ms ease, background-color 120ms ease, border-color 120ms ease",
                    }}
                  >
                    {action && (
                      <svg viewBox="0 0 24 24" className="pointer-events-none h-[20px] w-[20px]">
                        {SHORTCUT_ICONS[action]}
                      </svg>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <p className="mt-4 text-center text-[12px] text-white/40">
          {t("shortcuts.keyboardHint")}
        </p>

        {/* Bottom tray: actions not on the board yet. Drag one onto a key.
            Hidden entirely when everything is placed. Dropping an action here
            unbinds it. */}
        {(unassigned.length > 0 || dragging) && (
          <div
            className="mt-5 flex w-full max-w-[1000px] flex-wrap items-center justify-center gap-2 rounded-xl p-3"
            style={{
              background: "rgba(255,255,255,0.02)",
              border: `1px dashed ${dragging ? ACCENT : "rgba(255,255,255,0.12)"}`,
            }}
            onDragOver={(e) => {
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
            {unassigned.length === 0 ? (
              <span className="px-2 py-1 text-[12px] text-white/40">
                {t("shortcuts.dropHereToUnbind")}
              </span>
            ) : (
              unassigned.map((id) => (
                <div
                  key={id}
                  draggable
                  onDragStart={(e) => onDragStart(e, id)}
                  onDragEnd={onDragEnd}
                  onMouseEnter={() => setHoverKey(null)}
                  className="flex cursor-grab items-center gap-2 rounded-lg px-2.5 py-1.5 transition active:cursor-grabbing"
                  style={{
                    background:
                      dragging === id ? "rgba(233,69,96,0.16)" : "rgba(255,255,255,0.05)",
                    border: `1px solid ${dragging === id ? ACCENT : "rgba(255,255,255,0.08)"}`,
                  }}
                >
                  <svg viewBox="0 0 24 24" className="h-[16px] w-[16px] text-white/85">
                    {SHORTCUT_ICONS[id]}
                  </svg>
                  <span className="text-[12px] text-white/80">{actionLabel(id)}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
