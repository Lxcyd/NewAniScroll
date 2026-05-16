/**
 * AniScroll theme — single source of truth for every color used in the app.
 *
 * Why this file exists
 * ────────────────────
 * Before, the brand color (#E94560) was hard-coded in dozens of places —
 * tailwind.config.js, globals.css, individual components, the Vidstack
 * theme variables, the subtitle settings panel, the navbar, etc.
 * Changing the look required hunting it down across the codebase.
 *
 * Now: every color lives here. The exports below are consumed by:
 *   • tailwind.config.js          → reads BRAND_HEX to populate the `as.*`
 *                                   and `action` palette tokens.
 *   • styles/globals.css          → reads the same hex via CSS custom
 *                                   properties declared on :root (set by
 *                                   _app.tsx at boot from this module).
 *   • Components that need a JS value (Vidstack inline styles, SubtitleSettings
 *     toggle, ambient lights, etc.) import directly from here.
 *
 * To rebrand AniScroll: change BRAND.primary below and reload.
 */

export const BRAND = {
  /** Main accent — used for buttons, focus rings, active states, sliders. */
  primary: "#E94560",
  /** Secondary accent — used for warm gradients (logo torii). */
  secondary: "#FF7F57",
  /** Slightly darker tint of primary, used for hover/pressed. */
  primaryHover: "#D83A55",
  /** Even darker, used for active/pressed feedback. */
  primaryActive: "#C12F4A",
  /** Soft tinted background — used for ambient glow, subtle accents. */
  glow: "rgba(233, 69, 96, 0.35)",
};

export const SURFACE = {
  /** Page background. */
  bg: "#0e0e16",
  /** Card / panel background. */
  card: "#1a1a24",
  /** Slightly elevated surface (inputs, secondary buttons). */
  surface: "#22222e",
  /** Darker secondary (footer, nav scrim). */
  tertiary: "#0c0d10",
};

export const TEXT = {
  /** Default body text. */
  body: "#dbdcdd",
  /** Secondary / muted text. */
  muted: "rgba(255, 255, 255, 0.6)",
  /** Subtle / faint text (labels, captions). */
  faint: "rgba(255, 255, 255, 0.4)",
};

/** Status colors — used in profile lists, watch state badges, etc. */
export const STATUS = {
  watching: "#10B981",
  rewatching: "#06B6D4",
  completed: "#3B82F6",
  planning: "#A855F7",
  paused: "#F59E0B",
  dropped: "#EF4444",
  score: "#FFD700",
  episodes: "#0F3460",
};

/**
 * Returns an object suitable for assigning to document.documentElement.style
 * so the same colors are available as CSS custom properties at runtime. Called
 * from _app.tsx on mount; reload reflects edits to this file instantly.
 */
export function asCssVars() {
  return {
    "--brand-primary": BRAND.primary,
    "--brand-secondary": BRAND.secondary,
    "--brand-primary-hover": BRAND.primaryHover,
    "--brand-primary-active": BRAND.primaryActive,
    "--brand-glow": BRAND.glow,
    "--surface-bg": SURFACE.bg,
    "--surface-card": SURFACE.card,
    "--surface-surface": SURFACE.surface,
    "--surface-tertiary": SURFACE.tertiary,
    "--text-body": TEXT.body,
    "--text-muted": TEXT.muted,
    "--text-faint": TEXT.faint,
  } as Record<string, string>;
}
