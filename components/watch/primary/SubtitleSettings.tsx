import { useEffect, useState } from "react";

/**
 * Subtitle styling control. Persists to localStorage and exposes Vidstack's
 * built-in caption CSS variables on the player element so changes apply live
 * without re-mounting the player.
 *
 * Vidstack reads these vars from `.vds-captions` (or any ancestor):
 *  - --media-user-text-size      → font size scale
 *  - --media-user-text-color     → text color
 *  - --media-user-bg-color       → background color (incl. alpha)
 *  - --media-user-text-shadow    → text shadow / stroke
 *  - --media-user-font-family    → font family
 */
const STORAGE_KEY = "subtitle_settings_v1";

const DEFAULTS = {
  size: 100,           // % of base
  color: "#FFFFFF",
  bgColor: "#000000",
  bgAlpha: 0.6,        // 0..1
  position: 90,        // % from top (90 = bottom)
  fontFamily: "sans-serif",
};

const FONTS = [
  { label: "Sans-serif", value: "sans-serif" },
  { label: "Serif", value: "serif" },
  { label: "Mono", value: "monospace" },
  { label: "Karla", value: "Karla, sans-serif" },
  { label: "Outfit", value: "Outfit, sans-serif" },
];

const STYLE_EL_ID = "moopa-subtitle-styles";

function applyToDocument(s: typeof DEFAULTS) {
  const bg = hexToRgba(s.bgColor, s.bgAlpha);
  // Vidstack's --media-cue-font-size scales relative to overlay height,
  // so we feed it as a multiplier of the default 4.5cqh-style calc.
  const fontSizeMul = s.size / 100;
  const captionBottom = `${100 - s.position}%`;

  let styleEl = document.getElementById(STYLE_EL_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = STYLE_EL_ID;
    document.head.appendChild(styleEl);
  }
  // Use Vidstack's documented --media-cue-* variables (from
  // @vidstack/react/player/styles/default/captions.css). These are the source
  // of truth for caption rendering. Override the native ::cue too as a
  // safety net for sources that fall back to browser-native captions.
  styleEl.textContent = `
    .vds-player {
      --media-cue-color: ${s.color};
      --media-cue-bg: ${bg};
      --media-cue-font-size: calc(var(--overlay-height, 100cqh) / 100 * ${4.5 * fontSizeMul});
      --media-cue-line-height: calc(var(--media-cue-font-size) * 1.2);
    }
    .vds-player .vds-captions {
      bottom: ${captionBottom} !important;
      font-family: ${s.fontFamily} !important;
    }
    /* Native HTML5 cues fallback */
    video::cue {
      color: ${s.color};
      background-color: ${bg};
      font-family: ${s.fontFamily};
    }
  `;
}

function hexToRgba(hex: string, a: number): string {
  const m = hex.replace("#", "").match(/^(..)(..)(..)$/);
  if (!m) return `rgba(0,0,0,${a})`;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export default function SubtitleSettings({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [s, setS] = useState(DEFAULTS);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = { ...DEFAULTS, ...JSON.parse(raw) };
        setS(parsed);
        applyToDocument(parsed);
      } else {
        applyToDocument(DEFAULTS);
      }
    } catch {}
  }, []);

  // Re-apply when settings change + persist
  useEffect(() => {
    applyToDocument(s);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {}
  }, [s]);

  if (!open) return null;

  const update = (patch: Partial<typeof DEFAULTS>) => setS((p) => ({ ...p, ...patch }));

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-card bg-as-card p-5 ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-outfit text-lg font-bold text-white">Subtitles</h3>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-white/60 hover:bg-white/10 hover:text-white"
            aria-label="Close"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        <div className="space-y-4 font-karla text-sm text-white/85">
          {/* Size */}
          <div>
            <label className="mb-1.5 flex justify-between text-xs uppercase tracking-wider text-white/50">
              Size <span className="font-mono normal-case text-white/80">{s.size}%</span>
            </label>
            <input
              type="range"
              min={50}
              max={250}
              step={5}
              value={s.size}
              onChange={(e) => update({ size: +e.target.value })}
              className="w-full accent-as-accent"
            />
          </div>

          {/* Position */}
          <div>
            <label className="mb-1.5 flex justify-between text-xs uppercase tracking-wider text-white/50">
              Position <span className="font-mono normal-case text-white/80">{s.position}%</span>
            </label>
            <input
              type="range"
              min={50}
              max={95}
              step={1}
              value={s.position}
              onChange={(e) => update({ position: +e.target.value })}
              className="w-full accent-as-accent"
            />
            <div className="mt-0.5 flex justify-between text-[10px] text-white/40">
              <span>middle</span>
              <span>bottom</span>
            </div>
          </div>

          {/* Text color */}
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs uppercase tracking-wider text-white/50">Text color</label>
            <input
              type="color"
              value={s.color}
              onChange={(e) => update({ color: e.target.value })}
              className="h-8 w-14 cursor-pointer rounded border-0 bg-transparent"
            />
          </div>

          {/* Background color + alpha */}
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs uppercase tracking-wider text-white/50">Background</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={s.bgColor}
                onChange={(e) => update({ bgColor: e.target.value })}
                className="h-8 w-14 cursor-pointer rounded border-0 bg-transparent"
              />
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={s.bgAlpha}
                onChange={(e) => update({ bgAlpha: +e.target.value })}
                className="w-24 accent-as-accent"
                title={`Opacity ${Math.round(s.bgAlpha * 100)}%`}
              />
            </div>
          </div>

          {/* Font family */}
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs uppercase tracking-wider text-white/50">Font</label>
            <select
              value={s.fontFamily}
              onChange={(e) => update({ fontFamily: e.target.value })}
              className="rounded-md bg-as-surface px-2 py-1 text-sm text-white ring-1 ring-white/10 outline-none focus:ring-as-accent"
            >
              {FONTS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>

          {/* Preview */}
          <div className="rounded-md bg-black/60 p-4">
            <div className="text-center text-white/40 text-[10px] uppercase mb-2">Preview</div>
            <div
              style={{
                fontSize: `${s.size}%`,
                color: s.color,
                background: hexToRgba(s.bgColor, s.bgAlpha),
                fontFamily: s.fontFamily,
                padding: "0.25em 0.5em",
                display: "inline-block",
                borderRadius: 4,
              }}
            >
              The quick brown fox jumps over the lazy dog
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <button
              onClick={() => setS(DEFAULTS)}
              className="flex-1 rounded-md bg-white/5 px-3 py-2 text-xs text-white/70 ring-1 ring-white/10 hover:bg-white/10"
            >
              Reset
            </button>
            <button
              onClick={onClose}
              className="flex-1 rounded-md bg-as-accent px-3 py-2 text-xs font-semibold text-white hover:bg-as-accent/90"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
