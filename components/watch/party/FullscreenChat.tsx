import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { IoSend, IoChatbubbleEllipses } from "react-icons/io5";
import type { PartyEvent, ChatMessage } from "@/lib/watch2gether/types";
import ChatText from "./ChatText";
import ChatComposer, { type ChatComposerHandle } from "./ChatComposer";
import EmojiButton from "./EmojiButton";
import { replaceShortcodes } from "@/lib/watch2gether/animeEmojis";
import { isAnimeSticker } from "@/lib/watch2gether/animeStickers";

// The "hover the right edge" hint shows ONCE per Watch-party session: the first
// time the user enters fullscreen. It's discreet, auto-dismisses, and vanishes
// the instant they open the chat. (Once-per-session = a `useRef` that lives as
// long as this component, which is mounted for the whole party session.)
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
  /** Hide the chat while a player menu/overlay (settings, subtitles, stats…) is
   *  open, so it doesn't sit on top of / fight those controls in fullscreen. */
  suppressed?: boolean;
}

const BUBBLE_TTL_MS = 4000; // each ephemeral bubble fades after ~4s
const RECENT_MAX = 30; // history kept for the hover panel
// Keep the panel up for a beat after the cursor leaves the input while typing,
// so a quick reach for the emoji picker doesn't slam it shut. Empty input → it
// closes instantly on mouse-leave (the requested behaviour).
const TYPING_GRACE_MS = 400;

export default function FullscreenChat({ onRemote, sendChat, playerEl, active, suppressed }: Props) {
  const { t } = useTranslation();
  const [recent, setRecent] = useState<ChatMessage[]>([]);
  const [bubbles, setBubbles] = useState<ChatMessage[]>([]);
  // open === mouse is over the chat zone (or briefly after, while typing).
  const [open, setOpen] = useState(false);
  // The discreet onboarding hint pulsing on the right edge right after entering
  // fullscreen. Auto-dismisses; never shown once the user has opened the chat.
  const [hint, setHint] = useState(false);
  const composerRef = useRef<ChatComposerHandle | null>(null);
  // Whether the composer currently has content (drives the typing-grace on close).
  const hasTextRef = useRef(false);
  // Whether the chat composer currently holds keyboard focus. When it does, a
  // click on the video must NOT toggle play/pause — it should just defocus the
  // chat and close the panel (see the capture-phase veto effect below).
  const focusedRef = useRef(false);
  // The chat panel root, so the veto can tell a click INSIDE the chat (which
  // must keep working) from a click on the video surface.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<number | null>(null);
  // Once-per-session guard: persists for the component's lifetime (the whole
  // party), so the hint shows only on the FIRST fullscreen entry of the session.
  const hintShownRef = useRef(false);

  // ── Intro hint ──
  // On the FIRST fullscreen entry of the session, pulse the right-edge
  // affordance so the user knows the chat lives there. Auto-dismisses after a
  // few seconds (and the moment they open the chat — see openNow).
  useEffect(() => {
    if (!active) {
      setHint(false);
      return;
    }
    if (hintShownRef.current) return; // already shown once this session
    hintShownRef.current = true;
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
    if (hasTextRef.current) {
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

  // Keyboard shortcut ("t"): UniversalPlayer dispatches this after making sure
  // we're fullscreen. Open the panel and focus the composer so the user can
  // type straight away — the same result as hovering the reveal zone, minus the
  // mouse. `active`-gated so a stray event while windowed does nothing.
  useEffect(() => {
    if (!active) return;
    const onOpen = () => {
      openNow();
      // Focus after the panel's open transition begins (pointer-events flip to
      // auto) so the caret reliably lands in the input.
      window.setTimeout(() => composerRef.current?.focus(), 60);
    };
    window.addEventListener("aniscroll:openPartyChat", onOpen);
    return () => window.removeEventListener("aniscroll:openPartyChat", onOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // ── "Click video while typing = just defocus the chat" ──
  // While the composer holds focus, a click on the video surface should NOT
  // toggle play/pause. Instead it should feel like a click-away: blur the
  // composer and close the panel, leaving playback alone.
  //
  // Vidstack's play/pause GESTURE listens for `pointerup` (→ `touchend` on
  // coarse pointers) on the PLAYER ROOT element itself — the very same element
  // we portal into. So:
  //  • We must veto `pointerup`/`touchend`, NOT `pointerdown`/`click`
  //    (an earlier version keyed on the wrong events, so the gesture always
  //     fired and the video paused anyway).
  //  • A CAPTURE-phase `stopPropagation()` on that element stops the event
  //    before Vidstack's own (bubble-phase) listener on the same element runs.
  //  • By `pointerup`, the composer may already have blurred (focus left on the
  //    preceding `pointerdown`), so `focusedRef` can read false. We therefore
  //    latch "was the chat focused when the press STARTED" on `pointerdown` and
  //    consult that latch on `pointerup`.
  useEffect(() => {
    if (!active || !playerEl) return;

    // Did the press begin while the composer held focus AND land outside the
    // chat panel? If so, the matching release must be swallowed (no play/pause)
    // and instead just defocus + close the chat.
    let armed = false;

    const isOutsideChat = (e: Event) => {
      const target = e.target as Node | null;
      return !(target && panelRef.current?.contains(target));
    };

    const onDown = (e: Event) => {
      // Latch state at press time — focus is still on the composer here.
      armed = focusedRef.current && isOutsideChat(e);
      if (armed) {
        // Swallow the down too so Vidstack never even arms anything from it.
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const onUp = (e: Event) => {
      if (!armed) return; // normal playback gesture
      armed = false;
      // Swallow the release so Vidstack's pointerup toggle never fires.
      e.preventDefault();
      e.stopPropagation();
      composerRef.current?.blur();
      focusedRef.current = false;
      requestClose();
    };

    playerEl.addEventListener("pointerdown", onDown, { capture: true });
    playerEl.addEventListener("pointerup", onUp, { capture: true });
    // Coarse pointers (touch): Vidstack maps the gesture to touchstart/touchend.
    playerEl.addEventListener("touchstart", onDown, { capture: true });
    playerEl.addEventListener("touchend", onUp, { capture: true });
    return () => {
      playerEl.removeEventListener("pointerdown", onDown, { capture: true } as any);
      playerEl.removeEventListener("pointerup", onUp, { capture: true } as any);
      playerEl.removeEventListener("touchstart", onDown, { capture: true } as any);
      playerEl.removeEventListener("touchend", onUp, { capture: true } as any);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, playerEl]);

  if (!active || !playerEl) return null;

  // Send the composer's serialized text (sticker <img> → :shortcode:).
  const send = (tx: string) => {
    const trimmed = tx.trim();
    if (!trimmed) return;
    sendChat(trimmed);
    composerRef.current?.clear();
    hasTextRef.current = false;
    cancelClose();
    composerRef.current?.focus();
  };

  // Emoji/sticker pick: stickers stay as :shortcode: (composer renders the
  // image inline); unicode-backed emoji are converted to their char first.
  const onPick = (token: string) => {
    composerRef.current?.insert(isAnimeSticker(token) ? token : replaceShortcodes(token));
    hasTextRef.current = true;
    cancelClose();
    composerRef.current?.focus();
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
    // While a player menu is open (suppressed), hide the whole chat overlay so
    // it doesn't overlap / fight the settings, subtitles or stats panels. We use
    // display:none rather than unmounting so the live message subscription and
    // bubble timers keep running underneath.
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 40,
        pointerEvents: "none",
        display: suppressed ? "none" : undefined,
      }}
    >
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
        ref={panelRef}
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

        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <EmojiButton onPick={onPick} fullscreen />
          <ChatComposer
            ref={composerRef}
            placeholder={t("party.message")}
            onSubmit={send}
            onChange={(v) => {
              hasTextRef.current = !!v;
              openNow();
            }}
            onFocus={() => {
              focusedRef.current = true;
              openNow();
            }}
            onBlur={() => {
              focusedRef.current = false;
            }}
            style={{
              flex: 1,
              borderRadius: 10,
              background: "rgba(255,255,255,0.14)",
              color: "white",
              padding: "8px 12px",
              fontSize: 14,
            }}
          />
          <button
            type="button"
            onClick={() => send(composerRef.current?.getText() || "")}
            className="w2g-fs-send"
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
        </div>
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
