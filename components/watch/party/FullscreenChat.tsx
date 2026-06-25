import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { IoSend, IoChatbubbleEllipses } from "react-icons/io5";
import type { PartyEvent, ChatMessage } from "@/lib/watch2gether/types";
import ChatText from "./ChatText";
import EmojiButton from "./EmojiButton";
import { replaceShortcodes } from "@/lib/watch2gether/animeEmojis";

// Show the "hover the right edge" hint only the first few times the user enters
// fullscreen with a party — once they've learned it, stop nagging.
const HINT_SEEN_KEY = "w2g.fsChat.hintSeen";
const HINT_MAX_SHOWS = 3;

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
  // When we (re)enter fullscreen, briefly pulse the right-edge affordance so the
  // user learns the chat lives there. Capped to HINT_MAX_SHOWS lifetime.
  useEffect(() => {
    if (!active) {
      setHint(false);
      return;
    }
    let shows = 0;
    try {
      shows = parseInt(localStorage.getItem(HINT_SEEN_KEY) || "0", 10) || 0;
    } catch {
      /* ignore */
    }
    if (shows >= HINT_MAX_SHOWS) return;
    setHint(true);
    try {
      localStorage.setItem(HINT_SEEN_KEY, String(shows + 1));
    } catch {
      /* ignore */
    }
    const id = window.setTimeout(() => setHint(false), 3600);
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

  const overlay = (
    <div style={{ position: "absolute", inset: 0, zIndex: 40, pointerEvents: "none" }}>
      {/* Right-edge hover zone — entering it opens the chat; leaving it (or the
          panel) closes it instantly. Stops above the control bar so PiP /
          fullscreen stay clickable. */}
      <div
        onMouseEnter={openNow}
        onMouseLeave={requestClose}
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          width: 64,
          height: `calc(100% - ${BOTTOM + 8}px)`,
          pointerEvents: "auto",
        }}
      />

      {/* Discreet intro hint: a soft pill on the right edge that gently pulses,
          telling the user to move the cursor there. Fades on its own. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          right: 0,
          top: "50%",
          transform: `translateY(-50%) translateX(${hint ? "0" : "16px"})`,
          opacity: hint ? 1 : 0,
          transition: "opacity 360ms ease, transform 360ms ease",
          pointerEvents: "none",
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "rgba(0,0,0,0.6)",
          backdropFilter: "blur(6px)",
          color: "white",
          padding: "8px 12px 8px 14px",
          borderTopLeftRadius: 999,
          borderBottomLeftRadius: 999,
          fontSize: 13,
          animation: hint ? "w2gFsHintPulse 1.6s ease-in-out infinite" : "none",
        }}
      >
        <IoChatbubbleEllipses size={16} />
        <span>{t("party.fsHint")}</span>
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
        @keyframes w2gFsHintPulse {
          0%, 100% { transform: translateY(-50%) translateX(0); }
          50% { transform: translateY(-50%) translateX(-5px); }
        }
      `}</style>
    </div>
  );

  return createPortal(overlay, playerEl);
}
