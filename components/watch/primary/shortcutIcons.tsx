/**
 * Inline SVG glyphs for each bindable player action, used by the visual
 * keyboard editor to paint an icon on the assigned key (matching the
 * reference design) and by the action list on the side.
 *
 * All icons are 24×24 viewBox, `currentColor` stroke/fill so the key can
 * tint them (white when idle, accent when the row is being edited).
 */
import type { ShortcutAction } from "@/lib/prefs/keybindings";
import type { ReactNode } from "react";

const P = (d: string) => (
  <path d={d} fill="currentColor" />
);

export const SHORTCUT_ICONS: Record<ShortcutAction, ReactNode> = {
  playPause: P("M8 5v14l11-7z"),
  prevEpisode: P("M6 6h2v12H6zm3.5 6l8.5 6V6z"),
  nextEpisode: P("M6 18l8.5-6L6 6v12zM16 6h2v12h-2z"),
  mute: P("M7 9v6h4l5 5V4l-5 5H7zm12.5 3l2.3-2.3-1.4-1.4L18 10.6l-2.3-2.3-1.4 1.4L16.6 12l-2.3 2.3 1.4 1.4L18 13.4l2.4 2.3 1.4-1.4L19.5 12z"),
  toggleStats: P("M4 20h16v2H4v-2zm2-9h3v7H6v-7zm5-6h3v13h-3V5zm5 3h3v10h-3V8z"),
  pictureInPicture: P("M19 7h-8v6h8V7zm4 12V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z"),
  seekBackward: P("M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"),
  seekForward: P("M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"),
  volumeUp: P("M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"),
  volumeDown: P("M18.5 12A4.5 4.5 0 0016 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"),
  rateDown: P("M11 18V6l-8.5 6 8.5 6zM13 6v12l8.5-6L13 6z M2 11h4v2H2z"),
  rateUp: P("M4 18l8.5-6L4 6v12zM13 6v12l8.5-6L13 6z"),
  rateReset: P("M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"),
  skipIntro: P("M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"),
  skipOutro: P("M18 6l-8.5 6L18 18V6zM6 6v12h2V6H6z"),
  chromecast: P("M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z"),
  fullscreen: P("M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"),
  screenshot: P("M12 15.2a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4zM9 2L7.17 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2h-3.17L15 2H9zm3 15a5 5 0 110-10 5 5 0 010 10z"),
  subtitles: P("M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-9 11H6v-2h5v2zm7 0h-5v-2h5v2zm0-4H6V9h12v2z"),
  // Extras
  seekBackwardLong: P("M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"),
  seekForwardLong: P("M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"),
  restart: P("M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"),
  seekToEnd: P("M6 6l8.5 6L6 18V6zm10 0h2v12h-2V6z"),
  frameBackward: P("M15 6l-6 6 6 6V6zM7 6H5v12h2V6z"),
  frameForward: P("M9 6l6 6-6 6V6zm8 0h2v12h-2V6z"),
  toggleTheater: P("M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 12H3V7h18v8z"),
  cycleAspect: P("M19 12h-2v3h-3v2h5v-5zM7 9h3V7H5v5h2V9zm14-6H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16.01H3V4.99h18v14.02z"),
};
