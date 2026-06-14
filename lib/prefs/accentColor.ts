/**
 * Accent (brand) colour preference. The whole UI reads `--brand-primary`
 * (Tailwind `action` / `accent` map to it, Vidstack chrome reads it too), so a
 * custom theme is just that one CSS variable on :root. Local, per-device.
 */

import { useEffect, useState } from "react";

export const DEFAULT_ACCENT = "#E94560";
const KEY = "aniscroll:accent";
export const ACCENT_EVENT = "aniscroll:accent:change";

/** A few hand-picked presets shown alongside the free colour picker. */
export const ACCENT_PRESETS = [
  "#E94560", // default rose
  "#3B82F6", // blue
  "#8B5CF6", // violet
  "#22C55E", // green
  "#F97316", // orange
  "#EAB308", // amber
  "#EC4899", // pink
  "#14B8A6", // teal
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function getAccent(): string {
  if (typeof window === "undefined") return DEFAULT_ACCENT;
  try {
    const v = window.localStorage.getItem(KEY);
    return v && HEX_RE.test(v) ? v : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

/** Apply the colour to the document so every `var(--brand-primary)` updates. */
export function applyAccent(color: string): void {
  if (typeof document === "undefined") return;
  const c = HEX_RE.test(color) ? color : DEFAULT_ACCENT;
  document.documentElement.style.setProperty("--brand-primary", c);
}

export function setAccent(color: string): void {
  const c = HEX_RE.test(color) ? color : DEFAULT_ACCENT;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(KEY, c);
    } catch {
      /* best-effort */
    }
    applyAccent(c);
    window.dispatchEvent(new CustomEvent(ACCENT_EVENT));
  }
}

export function useAccent(): string {
  const [accent, setAccentState] = useState(DEFAULT_ACCENT);
  useEffect(() => {
    const read = () => setAccentState(getAccent());
    read();
    window.addEventListener(ACCENT_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(ACCENT_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return accent;
}
