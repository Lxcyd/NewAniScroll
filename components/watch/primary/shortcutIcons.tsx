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

// Percentage-jump glyph: a slim progress track with a filled portion up to
// `pct`, plus the tens digit centred — reads as "jump to N0%".
const Pct = (pct: number) => (
  <>
    <rect x="2" y="7.5" width="20" height="3.2" rx="1.6" fill="currentColor" opacity="0.28" />
    <rect x="2" y="7.5" width={20 * (pct / 100)} height="3.2" rx="1.6" fill="currentColor" />
    <text
      x="12"
      y="20.5"
      textAnchor="middle"
      fontFamily="Space Grotesk, system-ui, sans-serif"
      fontSize="9"
      fontWeight="700"
      fill="currentColor"
    >
      {pct}
    </text>
  </>
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
  // Speed down/up: the full Material "speed" gauge (dial + centred needle),
  // remapped from its 0 -960 960 960 viewBox into 0 0 24 24 (scale 0.02).
  // rateDown keeps the Material orientation (needle exits the opening on the
  // RIGHT); rateUp mirrors the DIAL horizontally (needle exits on the LEFT) so
  // the two read as opposites — but the +/− badge stays in the top-right
  // corner for both (the badge is NOT mirrored).
  rateDown: (
    <>
      <g transform="translate(1,22.5) scale(0.02)">
        <path d="M536-343q26-26 24-60t-30-56q-79-62-164-115T199-682q54 83 107 167.5T418-347q20 29 56 29.5t62-25.5ZM205-160q-22 0-40.5-9.5T135-198q-28-48-42-100.5T79-406q1-56 18.5-109T146-616l48 76q-17 32-26 66.5t-9 69.5q0 44 11.5 85.5T205-240h551q21-36 32.5-76.5T800-400q0-133-93.5-226.5T480-720q-37 0-72.5 9T340-686l-76-48q48-32 102.5-49T480-800q83 0 155.5 31.5t127 86q54.5 54.5 86 127T880-400q0 54-14 105t-40 97q-11 19-30 28.5t-40 9.5H205Z" fill="currentColor" />
      </g>
      {/* minus badge, top-right */}
      <rect x="17" y="2.5" width="5.5" height="2.2" rx="1.1" fill="currentColor" />
    </>
  ),
  rateUp: (
    <>
      {/* dial mirrored horizontally around x=12 (scale −0.02 x, translate 23) */}
      <g transform="translate(23,22.5) scale(-0.02,0.02)">
        <path d="M536-343q26-26 24-60t-30-56q-79-62-164-115T199-682q54 83 107 167.5T418-347q20 29 56 29.5t62-25.5ZM205-160q-22 0-40.5-9.5T135-198q-28-48-42-100.5T79-406q1-56 18.5-109T146-616l48 76q-17 32-26 66.5t-9 69.5q0 44 11.5 85.5T205-240h551q21-36 32.5-76.5T800-400q0-133-93.5-226.5T480-720q-37 0-72.5 9T340-686l-76-48q48-32 102.5-49T480-800q83 0 155.5 31.5t127 86q54.5 54.5 86 127T880-400q0 54-14 105t-40 97q-11 19-30 28.5t-40 9.5H205Z" fill="currentColor" />
      </g>
      {/* plus badge, top-right (not mirrored) */}
      <path d="M19.75 1.5a1.1 1.1 0 0 1 1.1 1.1v1.05h1.05a1.1 1.1 0 1 1 0 2.2h-1.05v1.05a1.1 1.1 0 1 1-2.2 0V5.85h-1.05a1.1 1.1 0 1 1 0-2.2h1.05V2.6a1.1 1.1 0 0 1 1.1-1.1Z" fill="currentColor" />
    </>
  ),
  rateReset: P("M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"),
  // Same "OP"/"ED" badge as the Settings > Automation panel, for visual
  // consistency between the two places this action appears.
  skipIntro: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="3.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <text x="12" y="15.4" textAnchor="middle" fontFamily="Space Grotesk, system-ui, sans-serif" fontSize="8.2" fontWeight="700" letterSpacing="0.3" fill="currentColor">OP</text>
    </>
  ),
  skipOutro: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="3.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <text x="12" y="15.4" textAnchor="middle" fontFamily="Space Grotesk, system-ui, sans-serif" fontSize="8.2" fontWeight="700" letterSpacing="0.3" fill="currentColor">ED</text>
    </>
  ),
  chromecast: P("M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z"),
  fullscreen: P("M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"),
  screenshot: P("M12 15.2a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4zM9 2L7.17 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2h-3.17L15 2H9zm3 15a5 5 0 110-10 5 5 0 010 10z"),
  subtitles: P("M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-9 11H6v-2h5v2zm7 0h-5v-2h5v2zm0-4H6V9h12v2z"),
  // Extras — the "long" seeks use a double-chevron (replay_10/forward_10 look)
  // so they read distinctly from the single-chevron ±5s icons.
  seekBackwardLong: P("M11 7V3.5L6.5 8 11 12.5V9c2.76 0 5 2.24 5 5s-2.24 5-5 5-5-2.24-5-5H4c0 3.87 3.13 7 7 7s7-3.13 7-7-3.13-7-7-7z"),
  seekForwardLong: P("M13 7V3.5L17.5 8 13 12.5V9c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5h2c0 3.87-3.13 7-7 7s-7-3.13-7-7 3.13-7 7-7z"),
  restart: P("M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"),
  seekToEnd: P("M6 6l8.5 6L6 18V6zm10 0h2v12h-2V6z"),
  frameBackward: P("M15 6l-6 6 6 6V6zM7 6H5v12h2V6z"),
  frameForward: P("M9 6l6 6-6 6V6zm8 0h2v12h-2V6z"),
  // "swap/cycle servers" — two arrows looping between stacked layers.
  cycleServer: P("M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0020 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 004 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"),
  // "copy timestamped link" — link/chain glyph.
  copyTimestamp: P("M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"),
  // "horizontal mirror" (flip): two triangles pointing away from a centre line.
  mirror: P("M11 3h2v18h-2V3zM9 7v10l-6-5 6-5zm6 0l6 5-6 5V7z"),
  // Percentage jumps.
  seekPct10: Pct(10),
  seekPct20: Pct(20),
  seekPct30: Pct(30),
  seekPct40: Pct(40),
  seekPct50: Pct(50),
  seekPct60: Pct(60),
  seekPct70: Pct(70),
  seekPct80: Pct(80),
  seekPct90: Pct(90),
};
