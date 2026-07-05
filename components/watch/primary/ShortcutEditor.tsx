/**
 * Visual keyboard shortcut editor (overlay).
 *
 * Rendered on top of the player / settings page when the user hits "Configure
 * shortcuts". Two panes:
 *   - LEFT  : the action list. Click an action to start "listening", then press
 *             any key to bind it (click → press-key model). Click again (or
 *             Esc) to cancel; a bound row shows its combo chip + a clear button.
 *   - RIGHT : a physical-keyboard render. Each key that's bound to an action
 *             paints that action's icon; hovering a key shows "<KEY> : <label>".
 *             The key you're currently pressing while listening lights up accent.
 *
 * Design mirrors the reference screenshot: near-black keyboard bezel, dark keys
 * with subtle borders, white glyphs, a floating dark tooltip above the keyboard.
 * Theme-agnostic (always the dark player aesthetic) since it belongs to the
 * player world.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  ACTION_CATALOG,
  type ShortcutAction,
  type Keybindings,
  type KeyCombo,
  comboFromEvent,
  comboLabel,
  comboToAction,
  getKeybindings,
  setKeybindings,
  resetKeybindings,
} from "@/lib/prefs/keybindings";
import { SHORTCUT_ICONS } from "./shortcutIcons";

const ACCENT = "#E94560";

// ── Physical keyboard layout ────────────────────────────────────────────────
// Each entry is { code, w } where `code` is the normalized base-key token we
// match against a combo's base (see comboFromEvent) and `w` is a flex weight
// (1 = a standard key). `null` code = a decorative dead key (renders but can't
// be assigned). `label` overrides the printed cap glyph.
type Cap = { code: string | null; w?: number; label?: string };

const ROWS: Cap[][] = [
  [
    { code: "escape", label: "esc" },
    { code: "1" }, { code: "2" }, { code: "3" }, { code: "4" }, { code: "5" },
    { code: "6" }, { code: "7" }, { code: "8" }, { code: "9" }, { code: "0" },
    { code: "-", label: "-" }, { code: "=", label: "=" },
    { code: "backspace", w: 2, label: "⌫" },
  ],
  [
    { code: "tab", w: 1.5, label: "⇥" },
    { code: "q" }, { code: "w" }, { code: "e" }, { code: "r" }, { code: "t" },
    { code: "y" }, { code: "u" }, { code: "i" }, { code: "o" }, { code: "p" },
    { code: "[", label: "[" }, { code: "]", label: "]" },
    { code: "\\", w: 1.5, label: "\\" },
  ],
  [
    { code: null, w: 1.75, label: "⇪" },
    { code: "a" }, { code: "s" }, { code: "d" }, { code: "f" }, { code: "g" },
    { code: "h" }, { code: "j" }, { code: "k" }, { code: "l" },
    { code: ";", label: ";" }, { code: "'", label: "'" },
    { code: "enter", w: 2.25, label: "↵" },
  ],
  [
    { code: null, w: 2.25, label: "⇧" },
    { code: "z" }, { code: "x" }, { code: "c" }, { code: "v" }, { code: "b" },
    { code: "n" }, { code: "m" },
    { code: ",", label: "," }, { code: ".", label: "." }, { code: "/", label: "/" },
    { code: null, w: 2.25, label: "⇧" },
  ],
  [
    { code: null, w: 1.5, label: "ctrl" },
    { code: null, w: 1.25, label: "alt" },
    { code: "space", w: 6, label: "" },
    { code: null, w: 1.25, label: "alt" },
    { code: "arrowleft", label: "←" },
    { code: "arrowup", label: "↑" },
    { code: "arrowdown", label: "↓" },
    { code: "arrowright", label: "→" },
  ],
];

export default function ShortcutEditor({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [binds, setBinds] = useState<Keybindings>(() => getKeybindings());
  const [listening, setListening] = useState<ShortcutAction | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [flashCombo, setFlashCombo] = useState<KeyCombo | null>(null);
  const listeningRef = useRef<ShortcutAction | null>(null);
  listeningRef.current = listening;

  const actionLabel = useCallback(
    (id: ShortcutAction) => t(`shortcuts.actions.${id}`),
    [t],
  );

  const byCombo = useMemo(() => comboToAction(binds), [binds]);

  const persist = useCallback((next: Keybindings) => {
    setBinds(next);
    setKeybindings(next);
  }, []);

  // Global key capture while listening. Captures at the window level so it wins
  // over anything below. A lone modifier (Shift/Ctrl/…) is ignored so the user
  // can build "Shift + S" etc. Escape cancels the listen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = listeningRef.current;
      if (!target) {
        // Not listening: only Escape (to close the whole editor) is handled,
        // and only when focus isn't in a text field.
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setListening(null);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return; // lone modifier — keep waiting
      // Remove this combo from any OTHER action (a key maps to one action),
      // then assign it to the target.
      const next: Keybindings = { ...binds };
      (Object.keys(next) as ShortcutAction[]).forEach((a) => {
        if (a !== target && next[a] === combo) next[a] = null;
      });
      next[target] = combo;
      persist(next);
      setFlashCombo(combo);
      setTimeout(() => setFlashCombo(null), 250);
      setListening(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [binds, onClose, persist]);

  const clearAction = (id: ShortcutAction) => {
    persist({ ...binds, [id]: null });
  };

  const resetAll = () => {
    const def = resetKeybindings();
    setBinds({ ...def });
    setListening(null);
  };

  // Group actions for the list, preserving catalog order within each group.
  const groups = useMemo(() => {
    const order: Array<ActionMetaGroup> = [
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

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)" }}
      onMouseDown={(e) => {
        // Click on the dim backdrop (not the panel) closes.
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
              {listening
                ? t("shortcuts.pressKeyFor", { action: actionLabel(listening) })
                : t("shortcuts.hint")}
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
          {/* LEFT — action list */}
          <div className="w-full shrink-0 space-y-3 overflow-y-auto lg:w-[340px] lg:pr-1">
            {groups.map(({ group, items }) => (
              <div key={group}>
                <div className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-white/35">
                  {t(`shortcuts.groups.${group}`)}
                </div>
                <div className="space-y-1">
                  {items.map((a) => {
                    const combo = binds[a.id] ?? null;
                    const isListening = listening === a.id;
                    return (
                      <div
                        key={a.id}
                        className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition"
                        style={{
                          background: isListening
                            ? "rgba(233,69,96,0.14)"
                            : "rgba(255,255,255,0.03)",
                          border: `1px solid ${
                            isListening ? ACCENT : "transparent"
                          }`,
                        }}
                        onMouseEnter={() => setHoverKey(combo ? baseOf(combo) : null)}
                        onMouseLeave={() => setHoverKey(null)}
                      >
                        <span
                          className="grid h-6 w-6 shrink-0 place-items-center text-white/80"
                          style={{ color: isListening ? ACCENT : undefined }}
                        >
                          <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]">
                            {SHORTCUT_ICONS[a.id]}
                          </svg>
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setListening((cur) => (cur === a.id ? null : a.id))
                          }
                          className="flex-1 truncate text-left text-[13px] text-white/85"
                        >
                          {actionLabel(a.id)}
                        </button>
                        {isListening ? (
                          <span
                            className="animate-pulse rounded-md px-2 py-1 text-[11px] font-medium"
                            style={{ color: ACCENT, background: "rgba(233,69,96,0.12)" }}
                          >
                            {t("shortcuts.pressAKey")}
                          </span>
                        ) : combo ? (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() =>
                                setListening((cur) => (cur === a.id ? null : a.id))
                              }
                              className="rounded-md border border-white/15 bg-white/5 px-2 py-1 font-mono text-[11px] text-white/90 transition hover:border-white/30"
                            >
                              {comboLabel(combo)}
                            </button>
                            <button
                              type="button"
                              aria-label={t("shortcuts.clear")}
                              onClick={() => clearAction(a.id)}
                              className="grid h-6 w-6 place-items-center rounded-md text-white/40 transition hover:bg-white/10 hover:text-white/80"
                            >
                              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                                <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                              </svg>
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setListening(a.id)}
                            className="rounded-md border border-dashed border-white/15 px-2 py-1 text-[11px] text-white/40 transition hover:border-white/30 hover:text-white/70"
                          >
                            {t("shortcuts.unassigned")}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* RIGHT — physical keyboard */}
          <div className="flex min-w-0 flex-1 items-start justify-center">
            <Keyboard
              byCombo={byCombo}
              binds={binds}
              hoverKey={hoverKey}
              flashCombo={flashCombo}
              actionLabel={actionLabel}
              onHoverKey={setHoverKey}
              onKeyClick={(code) => {
                // Clicking a key on the keyboard: if it's bound, start
                // re-listening for that action; otherwise no-op (assign from
                // the list). This keeps the primary model "action → press key".
                const action = byCombo.get(code) || null;
                if (action) setListening(action);
              }}
            />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

type ActionMetaGroup = "playback" | "navigation" | "skip" | "audio" | "speed" | "view";

/** Base token of a combo (drops modifiers) — used to highlight the physical key
 *  even for a combo like "shift+s" (we light the S key). */
function baseOf(combo: KeyCombo): string {
  const parts = combo.split("+");
  return parts[parts.length - 1];
}

function Keyboard({
  byCombo,
  binds,
  hoverKey,
  flashCombo,
  actionLabel,
  onHoverKey,
  onKeyClick,
}: {
  byCombo: Map<KeyCombo, ShortcutAction>;
  binds: Keybindings;
  hoverKey: string | null;
  flashCombo: KeyCombo | null;
  actionLabel: (id: ShortcutAction) => string;
  onHoverKey: (code: string | null) => void;
  onKeyClick: (code: string) => void;
}) {
  const { t } = useTranslation();

  // For a given key `code`, find the action bound to it. A key can carry a
  // plain binding ("s") AND appear as the base of a modified one ("shift+s");
  // we prefer the plain binding for the on-cap icon, and surface both in the
  // tooltip.
  const actionsForKey = (code: string): ShortcutAction[] => {
    const out: ShortcutAction[] = [];
    byCombo.forEach((action, combo) => {
      if (baseOf(combo) === code) out.push(action);
    });
    return out;
  };

  const tooltip = (() => {
    if (!hoverKey) return null;
    const acts = actionsForKey(hoverKey);
    if (!acts.length) return null;
    const keyGlyph = capGlyph(hoverKey);
    return `${keyGlyph} : ${acts.map(actionLabel).join(" / ")}`;
  })();

  return (
    <div className="w-full max-w-[900px]">
      {/* Tooltip */}
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
        className="space-y-1.5 rounded-xl p-3"
        style={{
          background: "#111318",
          border: "3px solid #000",
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.04)",
        }}
      >
        {ROWS.map((row, ri) => (
          <div key={ri} className="flex gap-1.5">
            {row.map((cap, ci) => {
              const code = cap.code;
              const bound = code ? actionsForKey(code) : [];
              const primary = bound[0];
              const isFlashing =
                !!flashCombo && !!code && baseOf(flashCombo) === code;
              const isHovered = !!code && hoverKey === code;
              return (
                <button
                  key={ci}
                  type="button"
                  disabled={!code}
                  onClick={() => code && onKeyClick(code)}
                  onMouseEnter={() => code && onHoverKey(code)}
                  onMouseLeave={() => onHoverKey(null)}
                  className="relative grid h-11 min-w-0 place-items-center rounded-md transition-colors"
                  style={{
                    flex: cap.w ?? 1,
                    background: isFlashing
                      ? ACCENT
                      : primary
                      ? "rgba(255,255,255,0.10)"
                      : "rgba(255,255,255,0.035)",
                    border: `1px solid ${
                      isHovered
                        ? "rgba(255,255,255,0.5)"
                        : primary
                        ? "rgba(255,255,255,0.18)"
                        : "rgba(255,255,255,0.05)"
                    }`,
                    cursor: code ? "pointer" : "default",
                    color: isFlashing ? "#fff" : "rgba(255,255,255,0.9)",
                  }}
                  title={code ? capGlyph(code) : undefined}
                >
                  {primary ? (
                    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]">
                      {SHORTCUT_ICONS[primary]}
                    </svg>
                  ) : (
                    <span className="select-none text-[10px] font-medium text-white/30">
                      {cap.label ?? (code ? code.toUpperCase() : "")}
                    </span>
                  )}
                  {/* extra-binding dot (a second, modified binding on this key) */}
                  {bound.length > 1 && (
                    <span
                      className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full"
                      style={{ background: ACCENT }}
                    />
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <p className="mt-3 text-center text-[11px] text-white/35">
        {t("shortcuts.keyboardHint")}
      </p>
    </div>
  );
}

/** Printable cap for a key token in the tooltip. */
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
    home: "Home",
    end: "End",
  };
  return map[code] ?? code.toUpperCase();
}
