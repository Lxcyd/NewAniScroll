import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IoSend } from "react-icons/io5";
import type { PartyEvent, ChatMessage } from "@/lib/watch2gether/types";
import ChatText from "./ChatText";
import EmojiButton from "./EmojiButton";
import { replaceShortcodes } from "@/lib/watch2gether/animeEmojis";

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
const IDLE_HIDE_MS = 3000; // hide the (idle) UI after this with no activity
const RECENT_MAX = 30; // history kept for the hover panel

export default function FullscreenChat({ onRemote, sendChat, myId, playerEl, active }: Props) {
  const [recent, setRecent] = useState<ChatMessage[]>([]);
  const [bubbles, setBubbles] = useState<ChatMessage[]>([]);
  const [shown, setShown] = useState(false); // expanded (hover) view
  const [text, setText] = useState("");
  const [hasText, setHasText] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const idleTimer = useRef<number | null>(null);
  const hoveringRef = useRef(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Keep the UI alive while there are bubbles OR the user is typing/hovering.
  const bumpActivity = () => {
    setShown(true);
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => {
      // Don't hide if still hovering or mid-typing.
      if (hoveringRef.current || inputRef.current?.value) {
        bumpActivity();
        return;
      }
      setShown(false);
    }, IDLE_HIDE_MS);
  };

  // Subscribe once to live chat — self-contained so we don't depend on the
  // player re-rendering.
  useEffect(() => {
    const unsub = onRemote((e) => {
      if (e.type === "chat" && e.payload) {
        const msg = e.payload as ChatMessage;
        setRecent((prev) => [...prev, msg].slice(-RECENT_MAX));
        setBubbles((prev) => [...prev, msg].slice(-6));
        bumpActivity();
        window.setTimeout(() => {
          setBubbles((prev) => prev.filter((b) => b.id !== msg.id));
        }, BUBBLE_TTL_MS);
      }
    });
    return () => {
      unsub();
      if (idleTimer.current) window.clearTimeout(idleTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRemote]);

  // Auto-scroll the expanded log to the newest message.
  useEffect(() => {
    if (shown && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [recent, shown]);

  if (!active || !playerEl) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    sendChat(t);
    setText("");
    setHasText(false);
    bumpActivity();
    inputRef.current?.focus();
  };

  // The composer is visible whenever the panel is "shown" (hover/activity) OR
  // there are live bubbles OR the user has typed something — so it never
  // disappears out from under you while a conversation is active.
  const showComposer = shown || bubbles.length > 0 || hasText;

  const overlay = (
    <div style={{ position: "absolute", inset: 0, zIndex: 40, pointerEvents: "none" }}>
      {/* Right-edge hover zone to reveal the full panel. */}
      <div
        onMouseEnter={() => {
          hoveringRef.current = true;
          bumpActivity();
        }}
        onMouseLeave={() => {
          hoveringRef.current = false;
          bumpActivity();
        }}
        style={{ position: "absolute", top: 0, right: 0, width: 96, height: "100%", pointerEvents: "auto" }}
      />

      <div
        onMouseEnter={() => {
          hoveringRef.current = true;
          bumpActivity();
        }}
        onMouseLeave={() => {
          hoveringRef.current = false;
          bumpActivity();
        }}
        style={{
          position: "absolute",
          right: 16,
          bottom: 88,
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
          gap: 8,
          width: "min(340px, 38vw)",
          pointerEvents: "auto",
        }}
      >
        {/* Expanded history (on hover/activity) vs ephemeral bubbles. */}
        {shown ? (
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
                No messages yet
              </span>
            )}
            {recent.map((m) => (
              <div key={m.id} style={{ color: "white", fontSize: 14, lineHeight: 1.3 }}>
                <span
                  style={{
                    fontWeight: 600,
                    marginRight: 6,
                    color: m.userId === myId ? "var(--brand-primary, #E94560)" : "rgba(255,255,255,0.85)",
                  }}
                >
                  {m.name}
                </span>
                <ChatText text={m.text} size={16} />
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
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
                    color: m.userId === myId ? "var(--brand-primary, #E94560)" : "rgba(255,255,255,0.85)",
                  }}
                >
                  {m.name}
                </span>
                <ChatText text={m.text} size={16} />
              </div>
            ))}
          </div>
        )}

        {showComposer && (
          <form onSubmit={submit} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <EmojiButton onPick={(ins) => { setText((p) => replaceShortcodes(p + ins)); setHasText(true); inputRef.current?.focus(); }} fullscreen />
            <input
              ref={inputRef}
              value={text}
              onChange={(e) => {
                const v = replaceShortcodes(e.target.value);
                setText(v);
                setHasText(!!v);
                bumpActivity();
              }}
              onFocus={bumpActivity}
              maxLength={500}
              placeholder="Message…"
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
        )}
      </div>
    </div>
  );

  return createPortal(overlay, playerEl);
}
