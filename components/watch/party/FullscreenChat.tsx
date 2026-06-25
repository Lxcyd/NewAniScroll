import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { IoSend, IoChatbubbleEllipses, IoClose } from "react-icons/io5";
import type { PartyEvent, ChatMessage } from "@/lib/watch2gether/types";
import ChatText from "./ChatText";
import EmojiButton from "./EmojiButton";
import { replaceShortcodes } from "@/lib/watch2gether/animeEmojis";

const HIDDEN_KEY = "w2g.fsChat.hidden";

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

export default function FullscreenChat({ onRemote, sendChat, playerEl, active }: Props) {
  const { t } = useTranslation();
  const [recent, setRecent] = useState<ChatMessage[]>([]);
  const [bubbles, setBubbles] = useState<ChatMessage[]>([]);
  const [shown, setShown] = useState(false); // expanded (hover) view
  const [text, setText] = useState("");
  const [hasText, setHasText] = useState(false);
  // Definitively hidden (via the cross) — persisted so it stays hidden across
  // fullscreen toggles. A floating chat button brings it back.
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    try {
      setHidden(localStorage.getItem(HIDDEN_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);
  const setHiddenPersist = (v: boolean) => {
    setHidden(v);
    try {
      localStorage.setItem(HIDDEN_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  };
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

  // Common bottom offset: keep EVERYTHING above the player's control bar so we
  // never intercept clicks on PiP / fullscreen / etc. (the old full-height hover
  // zone swallowed those).
  const BOTTOM = 96;

  // When hidden (cross clicked), nothing renders by default. The chat reappears
  // only when the mouse enters the right-edge zone (which stops above the
  // controls). A small "shown=false" state keeps just the icon.
  const overlay = (
    <div style={{ position: "absolute", inset: 0, zIndex: 40, pointerEvents: "none" }}>
      {/* Right-edge hover zone — reveals the panel. Stops above the control bar
          so PiP/fullscreen stay clickable. */}
      <div
        onMouseEnter={() => {
          hoveringRef.current = true;
          if (hidden) setHiddenPersist(false);
          bumpActivity();
        }}
        onMouseLeave={() => {
          hoveringRef.current = false;
          bumpActivity();
        }}
        style={{ position: "absolute", top: 0, right: 0, width: 96, height: `calc(100% - ${BOTTOM + 8}px)`, pointerEvents: "auto" }}
      />

      {/* When hidden, render nothing else (only the hover zone above is live). */}
      {hidden ? null : (
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
          bottom: BOTTOM,
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
          gap: 8,
          width: "min(340px, 38vw)",
          pointerEvents: "auto",
        }}
      >
        {/* Collapsed: a chat icon with a cross at its bottom-left. Hovering the
            icon reveals the chat; the cross hides it for good (until the user
            hovers the right edge again). */}
        {!shown && (
          <div style={{ alignSelf: "flex-end", position: "relative" }}>
            <button
              onMouseEnter={bumpActivity}
              onClick={() => {
                bumpActivity();
                setTimeout(() => inputRef.current?.focus(), 50);
              }}
              title={t("party.fsShow")}
              aria-label={t("party.fsShow")}
              style={{
                display: "flex",
                height: 40,
                width: 40,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 999,
                background: "rgba(0,0,0,0.6)",
                backdropFilter: "blur(4px)",
                color: "white",
                border: "none",
                cursor: "pointer",
              }}
            >
              <IoChatbubbleEllipses size={20} />
            </button>
            <button
              onClick={() => setHiddenPersist(true)}
              title={t("party.fsHide")}
              aria-label={t("party.fsHide")}
              style={{
                position: "absolute",
                bottom: -4,
                left: -4,
                display: "flex",
                height: 18,
                width: 18,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 999,
                background: "rgba(0,0,0,0.85)",
                color: "white",
                border: "1px solid rgba(255,255,255,0.2)",
                cursor: "pointer",
                padding: 0,
              }}
            >
              <IoClose size={12} />
            </button>
          </div>
        )}

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
        )}
      </div>
      )}
    </div>
  );

  return createPortal(overlay, playerEl);
}
