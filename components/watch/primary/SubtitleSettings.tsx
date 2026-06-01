import { useEffect, useState } from "react";
// @ts-ignore — react-dom types not installed but createPortal is exported
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

/**
 * Subtitle styling control. Persists user preferences to localStorage and
 * applies them by overriding the Plyr-style CSS variables defined in
 * globals.css (--plyr-captions-*, --plyr-font-size-*) on the `.vds-player`
 * element. The base CSS does all the heavy lifting — we just adjust the
 * variables, no custom selectors or fullscreen JS observers.
 *
 * Renders into the fullscreen element when active so the panel stays
 * visible while the player is fullscreened (the browser hides everything
 * outside the fullscreen target).
 */
const STORAGE_KEY = "subtitle_settings_v2";

const DEFAULTS = {
  size: 205,           // % — scales the responsive base size up/down
  color: "#FFFFFF",
  bgColor: "#000000",
  bgAlpha: 0.8,        // 0..1
  background: false,   // outline-only by default — cleaner over varied frames
  position: 98,        // % from top (max 100 = stuck to bottom edge)
  lineHeight: 120,     // % — gap between lines
  fontFamily: "inherit",
};

type Settings = typeof DEFAULTS;

const FONTS = [
  { label: "Default", value: "inherit" },
  { label: "Sans-serif", value: "sans-serif" },
  { label: "Serif", value: "serif" },
  { label: "Mono", value: "monospace" },
  { label: "Karla", value: "Karla, sans-serif" },
  { label: "Outfit", value: "Outfit, sans-serif" },
];

const STYLE_EL_ID = "moopa-subtitle-overrides";

// 8-layer outline (ArtPlayer-style) for legibility when background is off.
const OUTLINE_SHADOW =
  "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, " +
  "-1px 0 0 #000, 1px 0 0 #000, 0 -1px 0 #000, 0 1px 0 #000";

function hexToRgba(hex: string, a: number): string {
  const m = hex.replace("#", "").match(/^(..)(..)(..)$/);
  if (!m) return `rgba(0,0,0,${a})`;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function applyToDocument(s: Settings) {
  const bg = s.background ? hexToRgba(s.bgColor, s.bgAlpha) : "transparent";
  const captionBottom = `${100 - s.position}%`;
  const textShadow = s.background ? "none" : OUTLINE_SHADOW;
  // Express size as a multiplier on Plyr's base — keeps the responsive
  // breakpoint behavior intact while letting the user scale up/down.
  const sizeMul = s.size / 100;

  let styleEl = document.getElementById(STYLE_EL_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = STYLE_EL_ID;
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = `
    .vds-player .vds-captions {
      --plyr-captions-background: ${bg};
      --plyr-captions-text-color: ${s.color};
      --plyr-font-size-small: ${Math.round(13 * sizeMul)}px;
      --plyr-font-size-base: ${Math.round(15 * sizeMul)}px;
      --plyr-font-size-large: ${Math.round(18 * sizeMul)}px;
      --plyr-font-size-xlarge: ${Math.round(21 * sizeMul)}px;
      bottom: ${captionBottom} !important;
      font-family: ${s.fontFamily} !important;
    }
    .vds-player [data-part='cue'],
    .vds-player [data-part='cue-display'] {
      text-shadow: ${textShadow} !important;
      font-family: ${s.fontFamily} !important;
      line-height: ${s.lineHeight}% !important;
      ${s.background ? "" : "padding: 0 !important; box-shadow: none !important; border-radius: 0 !important;"}
    }
    .vds-player video::cue {
      text-shadow: ${textShadow};
      font-family: ${s.fontFamily};
      line-height: ${s.lineHeight}%;
    }
  `;
}

function getFullscreenElement(): Element | null {
  return (
    document.fullscreenElement ||
    (document as any).webkitFullscreenElement ||
    null
  );
}

export default function SubtitleSettings({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [s, setS] = useState<Settings>(DEFAULTS);
  const [fsHost, setFsHost] = useState<Element | null>(null);

  // Hydrate from localStorage and re-apply on every change.
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

  useEffect(() => {
    applyToDocument(s);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
  }, [s]);

  // Track fullscreen so we can portal the modal inside the fullscreen target.
  useEffect(() => {
    const update = () => setFsHost(getFullscreenElement());
    update();
    document.addEventListener("fullscreenchange", update);
    document.addEventListener("webkitfullscreenchange", update);
    return () => {
      document.removeEventListener("fullscreenchange", update);
      document.removeEventListener("webkitfullscreenchange", update);
    };
  }, []);

  if (!open) return null;

  const update = (patch: Partial<Settings>) => setS((p) => ({ ...p, ...patch }));

  const panel = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-card bg-as-card p-5 ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-outfit text-lg font-bold text-white">{t("player.subtitles")}</h3>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-white/60 hover:bg-white/10 hover:text-white"
            aria-label={t("player.close")}
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
              {t("player.size")} <span className="font-mono normal-case text-white/80">{s.size}%</span>
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
              {t("player.position")} <span className="font-mono normal-case text-white/80">{s.position}%</span>
            </label>
            <input
              type="range"
              min={50}
              max={100}
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

          {/* Line height (gap between lines) */}
          <div>
            <label className="mb-1.5 flex justify-between text-xs uppercase tracking-wider text-white/50">
              {t("player.lineHeight")} <span className="font-mono normal-case text-white/80">{s.lineHeight}%</span>
            </label>
            <input
              type="range"
              min={100}
              max={250}
              step={5}
              value={s.lineHeight}
              onChange={(e) => update({ lineHeight: +e.target.value })}
              className="w-full accent-as-accent"
            />
            <div className="mt-0.5 flex justify-between text-[10px] text-white/40">
              <span>tight</span>
              <span>loose</span>
            </div>
          </div>

          {/* Text color */}
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs uppercase tracking-wider text-white/50">{t("player.textColor")}</label>
            <input
              type="color"
              value={s.color}
              onChange={(e) => update({ color: e.target.value })}
              className="h-8 w-14 cursor-pointer rounded border-0 bg-transparent"
            />
          </div>

          {/* Background master toggle */}
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs uppercase tracking-wider text-white/50">
              {t("player.background")}
            </label>
            <button
              role="switch"
              aria-checked={s.background}
              onClick={() => update({ background: !s.background })}
              className="relative h-6 w-11 rounded-full transition-colors"
              style={{ backgroundColor: s.background ? "#E94560" : "rgba(255,255,255,0.18)" }}
            >
              <span
                className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform"
                style={{ left: s.background ? "calc(100% - 22px)" : "2px" }}
              />
            </button>
          </div>

          {/* Background color + alpha (dimmed when off) */}
          <div
            className="flex items-center justify-between gap-3"
            style={{ opacity: s.background ? 1 : 0.4, pointerEvents: s.background ? "auto" : "none" }}
          >
            <label className="text-xs uppercase tracking-wider text-white/50">{t("player.bgColor")}</label>
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
            <label className="text-xs uppercase tracking-wider text-white/50">{t("player.font")}</label>
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
            <div className="text-center text-white/40 text-[10px] uppercase mb-2">{t("player.preview")}</div>
            <div
              style={{
                fontSize: `${s.size}%`,
                color: s.color,
                background: s.background ? hexToRgba(s.bgColor, s.bgAlpha) : "transparent",
                fontFamily: s.fontFamily === "inherit" ? undefined : s.fontFamily,
                padding: s.background ? "0.25em 0.5em" : 0,
                textShadow: s.background ? "none" : OUTLINE_SHADOW,
                lineHeight: `${s.lineHeight}%`,
                display: "inline-block",
                borderRadius: 4,
              }}
            >
              {t("player.previewText")}
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <button
              onClick={() => setS(DEFAULTS)}
              className="flex-1 rounded-md bg-white/5 px-3 py-2 text-xs text-white/70 ring-1 ring-white/10 hover:bg-white/10"
            >
              {t("player.reset")}
            </button>
            <button
              onClick={onClose}
              className="flex-1 rounded-md bg-as-accent px-3 py-2 text-xs font-semibold text-white hover:bg-as-accent/90"
            >
              {t("common.done")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  if (fsHost) return createPortal(panel, fsHost);
  return panel;
}
