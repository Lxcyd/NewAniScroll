import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IoSend, IoChatbubbleEllipses } from "react-icons/io5";
import type { PartyContext } from "@/lib/watch2gether/useWatchParty";
import type { ChatMessage } from "@/lib/watch2gether/types";
import ChatText from "./ChatText";
import EmojiButton from "./EmojiButton";

interface Props {
  party: PartyContext;
  /** Player root element to portal into (so it stays visible in fullscreen). */
  playerEl: HTMLElement | null;
  /** Only render when the player is actually fullscreen. */
  active: boolean;
}

const BUBBLE_TTL_MS = 6000; // each bubble fades after ~6s
const IDLE_HIDE_MS = 10000; // hide the whole stack after inactivity

// Phone-style ephemeral chat for fullscreen: incoming messages pop as bubbles on
// the right and auto-dismiss; the stack hides after inactivity and re-reveals on
// hover of the right edge. A slim composer lets you send without leaving FS.
export default function FullscreenChat({ party, playerEl, active }: Props) {
  const { chat, sendChat, myId } = party;
  const [visibleBubbles, setVisibleBubbles] = useState<ChatMessage[]>([]);
  const [stackShown, setStackShown] = useState(true);
  const [composerOpen, setComposerOpen] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const idleTimer = useRef<number | null>(null);
  const lastSeenId = useRef<string | null>(null);

  const bumpActivity = () => {
    setStackShown(true);
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setStackShown(false), IDLE_HIDE_MS);
  };

  // When new messages arrive, surface them as bubbles + schedule their removal.
  useEffect(() => {
    if (!chat.length) return;
    const latest = chat[chat.length - 1];
    if (latest.id === lastSeenId.current) return;

    // Find messages newer than the last we surfaced.
    const idx = lastSeenId.current ? chat.findIndex((m) => m.id === lastSeenId.current) : -1;
    const fresh = idx >= 0 ? chat.slice(idx + 1) : chat.slice(-3);
    lastSeenId.current = latest.id;
    if (!fresh.length) return;

    setVisibleBubbles((prev) => [...prev, ...fresh].slice(-5));
    bumpActivity();

    fresh.forEach((m) => {
      window.setTimeout(() => {
        setVisibleBubbles((prev) => prev.filter((b) => b.id !== m.id));
      }, BUBBLE_TTL_MS);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat]);

  // Clean up on unmount.
  useEffect(() => {
    return () => {
      if (idleTimer.current) window.clearTimeout(idleTimer.current);
    };
  }, []);

  if (!active || !playerEl) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    sendChat(t);
    setText("");
    bumpActivity();
  };

  const overlay = (
    <div
      style={{ position: "absolute", inset: 0, zIndex: 40, pointerEvents: "none" }}
    >
      {/* Right-edge hover zone to re-reveal the stack/composer. */}
      <div
        onMouseEnter={() => {
          setStackShown(true);
          setComposerOpen(true);
          bumpActivity();
        }}
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          width: 80,
          height: "100%",
          pointerEvents: "auto",
        }}
      />

      {/* Bubble stack + composer, pinned to the right. */}
      <div
        onMouseEnter={bumpActivity}
        style={{
          position: "absolute",
          right: 16,
          bottom: 96,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 8,
          maxWidth: "min(360px, 40vw)",
          pointerEvents: "auto",
          opacity: stackShown ? 1 : 0,
          transition: "opacity 250ms ease",
        }}
      >
        {visibleBubbles.map((m) => (
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

        {composerOpen && (
          <form
            onSubmit={submit}
            style={{ display: "flex", alignItems: "center", gap: 4, pointerEvents: "auto" }}
          >
            <EmojiButton onPick={(ins) => setText((p) => p + ins)} />
            <input
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onFocus={bumpActivity}
              maxLength={500}
              placeholder="Message…"
              style={{
                width: 200,
                borderRadius: 10,
                background: "rgba(255,255,255,0.12)",
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

        {!composerOpen && (
          <button
            onClick={() => {
              setComposerOpen(true);
              bumpActivity();
              setTimeout(() => inputRef.current?.focus(), 50);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              borderRadius: 999,
              background: "rgba(0,0,0,0.6)",
              color: "white",
              padding: "8px 14px",
              fontSize: 13,
              border: "none",
              cursor: "pointer",
            }}
          >
            <IoChatbubbleEllipses size={16} /> Chat
          </button>
        )}
      </div>
    </div>
  );

  return createPortal(overlay, playerEl);
}
