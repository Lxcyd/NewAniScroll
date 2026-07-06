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
  // Prev/next EPISODE: skip-to-start / skip-to-end (|◄ / ►|).
  prevEpisode: P("M6 6h2v12H6zm3.5 6l8.5 6V6z"),
  nextEpisode: P("M6 18l8.5-6L6 6v12zM16 6h2v12h-2z"),
  // Mute: speaker + ✕, with the ✕ pushed further right for clarity.
  mute: P("M7 9v6h4l5 5V4l-5 5H7zm15.5 3 2.3-2.3-1.4-1.4L21 10.6l-2.3-2.3-1.4 1.4 2.3 2.3-2.3 2.3 1.4 1.4 2.3-2.3 2.3 2.3 1.4-1.4z"),
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
  // Reset speed: the "arch" speedometer dial supplied by the user — the base
  // gauge plus two mirrored top arches (so the ring is closed) and a needle
  // pointing top-right (neutral speed). Remapped from its 0 -960 960 960 viewBox
  // into 0 0 24 24 by wrapping the whole thing (defs geometry AND clip rects,
  // all authored in the same 960 space) in one translate(0,24) scale(0.025).
  // A small "restart" (circular arrow) badge sits in the top-right corner.
  rateReset: (
    // Faithful reproduction of the supplied SVG (viewBox 0 -960 960 1022.55):
    // the "arch" dial + top-right restart badge are authored together in the
    // 960 space, so the WHOLE thing maps to 0 0 24 24 via one
    // translate(0,24) scale(0.025). Everything is currentColor so the key can
    // tint it (the source's dark badge fill would be invisible on our keys).
    <g transform="translate(0,24) scale(0.025)" fill="currentColor">
      <defs>
        <path
          id="rr-cadran"
          d="M480-800q59 0 113.5 16.5T696-734l-76 48q-33-17-68.5-25.5T480-720q-133 0-226.5 93.5T160-400q0 42 11.5 83t32.5 77h552q23-38 33.5-79t10.5-85q0-36-8.5-70T766-540l48-76q30 47 47.5 100T880-406q1 57-13 109t-41 99q-11 18-30 28t-40 10H204q-21 0-40-10t-30-28q-26-45-40-95.5T80-400q0-83 31.5-155.5t86-127Q252-737 325-768.5T480-800Z"
        />
        <clipPath id="rr-arche-haute">
          <rect x="250" y="-960" width="515" height="300" />
        </clipPath>
        <clipPath id="rr-base-etendue">
          <rect x="0" y="-960" width="250" height="960" />
          <rect x="810" y="-960" width="150" height="960" />
          <rect x="0" y="-660" width="960" height="660" />
        </clipPath>
        <use
          id="rr-arche"
          href="#rr-cadran"
          clipPath="url(#rr-arche-haute)"
          transform="rotate(-45 480 -400)"
        />
      </defs>
      <use href="#rr-cadran" clipPath="url(#rr-base-etendue)" />
      <use href="#rr-arche" />
      <use href="#rr-arche" transform="translate(960,0) scale(-1,1)" />
      <path
        transform="rotate(-45 480 -400)"
        d="M480-316.5q38-.5 56-27.5l224-336-336 224q-27 18-28.5 55t22.5 61q24 24 62 23.5Z"
      />
      {/* restart badge, top-right — nested transforms straight from the SVG */}
      <g transform="translate(696,-658) scale(0.32)">
        <g transform="translate(0,-960) scale(40)">
          <path
            d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"
            stroke="currentColor"
            strokeWidth="1"
            strokeLinejoin="round"
          />
        </g>
      </g>
    </g>
  ),
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
  // ±5s seeks: just the text "−5" / "+5", a bit larger for legibility.
  seekBackwardLong: (
    <text x="12" y="17" textAnchor="middle" fontFamily="Space Grotesk, system-ui, sans-serif" fontSize="15" fontWeight="700" fill="currentColor">−5</text>
  ),
  seekForwardLong: (
    <text x="12" y="17" textAnchor="middle" fontFamily="Space Grotesk, system-ui, sans-serif" fontSize="15" fontWeight="700" fill="currentColor">+5</text>
  ),
  restart: P("M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"),
  // Prev/next FRAME ("image précédente/suivante"): Material "photo + arrow"
  // frame (image with mountains), arrow LEFT (prev) / RIGHT (next). Frame path
  // remapped from its 0 -960 960 960 viewBox; arrow drawn in 24×24 space.
  frameBackward: (
    <>
      <g transform="translate(0,24) scale(0.025)">
        <path d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h320v80H200v560h560v-280h80v280q0 33-23.5 56.5T760-120H200Zm40-160h480L570-480 450-320l-90-120-120 160Z" fill="currentColor" />
      </g>
      {/* arrow → left (nudged 1px right so it doesn't overlap the frame edge) */}
      <path d="M22.5 4.75h-5.4l1.7-1.7-1.2-1.2-3.75 3.75 3.75 3.75 1.2-1.2-1.7-1.7h5.4z" fill="currentColor" />
    </>
  ),
  frameForward: (
    <>
      <g transform="translate(0,24) scale(0.025)">
        <path d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h320v80H200v560h560v-280h80v280q0 33-23.5 56.5T760-120H200Zm40-160h480L570-480 450-320l-90-120-120 160Z" fill="currentColor" />
      </g>
      {/* arrow → right */}
      <path d="M14 4.75h5.4l-1.7-1.7 1.2-1.2 3.75 3.75L18.9 9.35l-1.2-1.2 1.7-1.7H14z" fill="currentColor" />
    </>
  ),
  // "swap/cycle servers" — two arrows looping between stacked layers.
  cycleServer: P("M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0020 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 004 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"),
  // "copy timestamped link" — link/chain glyph.
  copyTimestamp: P("M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"),
  // Rotate 90°: Material "rotate 90° with two arrows" glyph, remapped from its
  // 0 -960 960 960 viewBox into 0 0 24 24.
  rotate: (
    <g transform="translate(0,24) scale(0.025)">
      <path d="M487-104 150-440h114l280 280 200-200H640v-80h240v240h-80v-104L600-104q-23 23-56.5 23T487-104ZM80-520v-240h80v104l200-200q23-23 56.5-23t56.5 23l337 336H696L416-800 216-600h104v80H80Z" fill="currentColor" />
    </g>
  ),
  // Ambient lights: same Material "lightbulb_outline" glyph as the Settings >
  // Ambient Lights toggle, for visual consistency between the two places.
  toggleAmbient: P("M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7zm2.85 11.1-.85.6V16h-4v-2.3l-.85-.6C7.8 12.16 7 10.63 7 9c0-2.76 2.24-5 5-5s5 2.24 5 5c0 1.63-.8 3.16-2.15 4.1z"),
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
