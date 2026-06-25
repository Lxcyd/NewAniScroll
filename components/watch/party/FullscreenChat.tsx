import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { IoSend, IoChatbubbleEllipses } from "react-icons/io5";
import type { PartyEvent, ChatMessage } from "@/lib/watch2gether/types";
import ChatText from "./ChatText";
import EmojiButton from "./EmojiButton";
import { replaceShortcodes } from "@/lib/watch2gether/animeEmojis";

// The "hover the right edge" hint shows EACH TIME the user enters fullscreen
// with a party — it's discreet, auto-dismisses, and vanishes the instant they
// open the chat, so it's never in the way. (A lifetime cap made it silently
// disappear after a few sessions, which read as a bug.)
const HINT_DURATION_MS = 4500;

interface Props {
  /** Stable subscribe fn — FullscreenChat keeps its OWN message list from this
   *  so it stays reactive even though the (memoized) player doesn't re-render. */
  onRemote: (handler: (e: PartyEvent) => void) => () => void;
  sendChat: (text: string) => void;
  myId: string | null;
  /** Player root element to portal into (so it stays visible in fullscreen). */
  playerEl: HTMLElement | null;
  /** Only render when the player is actually fullscreen. */
  active: boolean;
}

const BUBBLE_TTL_MS = 4000; // each ephemeral bubble fades after ~4s
const RECENT_MAX = 30; // history kept for the hover panel
// Keep the panel up for a beat after the cursor leaves the input while typing,
// so a quick reach for the emoji picker doesn't slam it shut. Empty input → it
// closes instantly on mouse-leave (the requested behaviour).
const TYPING_GRACE_MS = 400;

export default function FullscreenChat({ onRemote, sendChat, playerEl, active }: Props) {
  const { t } = useTranslation();
  const [recent, setRecent] = useState<ChatMessage[]>([]);
  const [bubbles, setBubbles] = useState<ChatMessage[]>([]);
  // open === mouse is over the chat zone (or briefly after, while typing).
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  // The discreet onboarding hint pulsing on the right edge right after entering
  // fullscreen. Auto-dismisses; never shown once the user has opened the chat.
  const [hint, setHint] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<number | null>(null);

  // ── Intro hint ──
  // Each time we enter fullscreen, pulse the right-edge affordance so the user
  // knows the chat lives there. Auto-dismisses after a few seconds (and the
  // moment they open the chat — see openNow).
  useEffect(() => {
    if (!active) {
      setHint(false);
      return;
    }
    setHint(true);
    const id = window.setTimeout(() => setHint(false), HINT_DURATION_MS);
    return () => window.clearTimeout(id);
  }, [active]);

  const cancelClose = () => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const openNow = () => {
    cancelClose();
    setHint(false); // they found it — stop hinting
    setOpen(true);
  };

  // Close instantly, unless the user is mid-message (then a short grace so a
  // hop to the emoji picker / send button doesn't dismiss it).
  const requestClose = () => {
    cancelClose();
    if (inputRef.current?.value) {
      closeTimer.current = window.setTimeout(() => setOpen(false), TYPING_GRACE_MS);
    } else {
      setOpen(false);
    }
  };

  // Subscribe once to live chat — self-contained so we don't depend on the
  // player re-rendering. Incoming messages still surface as ephemeral bubbles
  // even while the panel is closed.
  useEffect(() => {
    const unsub = onRemote((e) => {
      if (e.type === "chat" && e.payload) {
        const msg = e.payload as ChatMessage;
        setRecent((prev) => [...prev, msg].slice(-RECENT_MAX));
        setBubbles((prev) => [...prev, msg].slice(-6));
        window.setTimeout(() => {
          setBubbles((prev) => prev.filter((b) => b.id !== msg.id));
        }, BUBBLE_TTL_MS);
      }
    });
    return () => {
      unsub();
      cancelClose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRemote]);

  // Auto-scroll the expanded log to the newest message.
  useEffect(() => {
    if (open && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [recent, open]);

  if (!active || !playerEl) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const tx = text.trim();
    if (!tx) return;
    sendChat(tx);
    setText("");
    cancelClose();
    inputRef.current?.focus();
  };

  // Keep EVERYTHING above the player's control bar so we never intercept clicks
  // on PiP / fullscreen / etc.
  const BOTTOM = 96;
  const PANEL_W = 340; // px, matched by the min() below
  // The hover trigger zone matches the CHAT's own footprint (width + height) so
  // the area that opens it is as big as the panel itself, not a thin edge strip.
  const ZONE_W = `min(${PANEL_W + 24}px, 42vw)`;
  const ZONE_H = "58vh";

  const overlay = (
    <div style={{ position: "absolute", inset: 0, zIndex: 40, pointerEvents: "none" }}>
      {/* Hover trigger zone — sized to the chat panel's footprint (bottom-right,
          above the control bar). Entering it opens the chat; leaving it (or the
          panel) closes it instantly. Sits above the controls so PiP / fullscreen
          stay clickable. */}
      <div
        onMouseEnter={openNow}
        onMouseLeave={requestClose}
        style={{
          position: "absolute",
          right: 0,
          bottom: BOTTOM,
          width: ZONE_W,
          height: ZONE_H,
          pointerEvents: "auto",
        }}
      />

      {/* Discreet intro hint — anchored to the RIGHT EDGE at the same height the
          chat opens (bottom-right, above the controls), so it points exactly to
          the reveal zone. Translucent pill flush against the edge; only the inner
          CONTENT nudges left (the background band stays pinned to the edge, so the
          leftward motion never leaves a gap on the right). Fades + slides away on
          its own, or the moment the user opens the chat. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          right: 0,
          bottom: BOTTOM + 4,
          transform: hint ? "translateX(0)" : "translateX(110%)",
          opacity: hint ? 1 : 0,
          transition: "opacity 320ms ease, transform 320ms cubic-bezier(.22,1,.36,1)",
          pointerEvents: "none",
          // Translucent band, pinned to the right edge. Extra right padding keeps
          // the bg covering the edge even as the content nudges left inside it.
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "rgba(0,0,0,0.4)",
          backdropFilter: "blur(5px)",
          color: "rgba(255,255,255,0.92)",
          padding: "9px 16px 9px 14px",
          borderTopLeftRadius: 999,
          borderBottomLeftRadius: 999,
          fontSize: 13,
          boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            // Only the content nudges — the band above stays flush to the edge.
            animation: hint ? "w2gFsHintNudge 1.5s ease-in-out infinite" : "none",
          }}
        >
          {/* left-pointing chevron — points toward the edge the cursor reaches */}
          <svg viewBox="0 0 24 24" width={14} height={14} fill="currentColor" style={{ opacity: 0.75 }}>
            <path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
          </svg>
          <IoChatbubbleEllipses size={16} />
          <span>{t("party.fsHint")}</span>
        </div>
      </div>

      {/* The panel itself. Slides in from the right + fades; closing is the same
          transition reversed, so it disappears "instantly with an animation". */}
      <div
        onMouseEnter={openNow}
        onMouseLeave={requestClose}
        style={{
          position: "absolute",
          right: 16,
          bottom: BOTTOM,
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
          gap: 8,
          width: `min(${PANEL_W}px, 38vw)`,
          pointerEvents: open ? "auto" : "none",
          opacity: open ? 1 : 0,
          transform: open ? "translateX(0)" : "translateX(24px)",
          transition: "opacity 160ms ease, transform 160ms ease",
        }}
      >
        <div
          ref={logRef}
          className="scrollbar-hide"
          style={{
            maxHeight: "46vh",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            background: "rgba(0,0,0,0.5)",
            backdropFilter: "blur(6px)",
            borderRadius: 12,
            padding: 10,
          }}
        >
          {recent.length === 0 && (
            <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, textAlign: "center" }}>
              {t("party.fsNoMessages")}
            </span>
          )}
          {recent.map((m) => (
            <div key={m.id} style={{ color: "white", fontSize: 14, lineHeight: 1.3 }}>
              <span
                style={{
                  fontWeight: 600,
                  marginRight: 6,
                  color: "var(--brand-primary, #E94560)",
                }}
              >
                {m.name}
              </span>
              <ChatText text={m.text} size={16} />
            </div>
          ))}
        </div>

        <form onSubmit={submit} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <EmojiButton
            onPick={(ins) => {
              setText((p) => replaceShortcodes(p + ins));
              cancelClose();
              inputRef.current?.focus();
            }}
            fullscreen
          />
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(replaceShortcodes(e.target.value))}
            onFocus={openNow}
            maxLength={500}
            placeholder={t("party.message")}
            style={{
              flex: 1,
              borderRadius: 10,
              background: "rgba(255,255,255,0.14)",
              color: "white",
              padding: "8px 12px",
              fontSize: 14,
              outline: "none",
              border: "none",
            }}
          />
          <button
            type="submit"
            style={{
              display: "flex",
              height: 36,
              width: 36,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 10,
              background: "var(--brand-primary, #E94560)",
              color: "white",
              border: "none",
              cursor: "pointer",
            }}
          >
            <IoSend size={16} />
          </button>
        </form>
      </div>

      {/* Ephemeral incoming-message bubbles — shown only while the panel is
          CLOSED, so they don't double up with the open history. */}
      {!open && bubbles.length > 0 && (
        <div
          style={{
            position: "absolute",
            right: 16,
            bottom: BOTTOM,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            alignItems: "flex-end",
            width: `min(${PANEL_W}px, 38vw)`,
            pointerEvents: "none",
          }}
        >
          {bubbles.map((m) => (
            <div
              key={m.id}
              style={{
                background: "rgba(0,0,0,0.6)",
                backdropFilter: "blur(4px)",
                borderRadius: 14,
                padding: "6px 12px",
                maxWidth: "100%",
                color: "white",
                fontSize: 14,
                lineHeight: 1.3,
              }}
            >
              <span
                style={{
                  fontWeight: 600,
                  marginRight: 6,
                  color: "var(--brand-primary, #E94560)",
                }}
              >
                {m.name}
              </span>
              <ChatText text={m.text} size={16} />
            </div>
          ))}
        </div>
      )}

      <style>{`
        @keyframes w2gFsHintNudge {
          0%, 100% { transform: translateX(0); }
          50% { transform: translateX(-6px); }
        }
      `}</style>
    </div>
  );

  return createPortal(overlay, playerEl);
}
