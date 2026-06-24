import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BsEmojiSmile } from "react-icons/bs";
import { ANIME_EMOJIS } from "@/lib/watch2gether/animeEmojis";
import { EMOJI_CATEGORIES, ALL_EMOJIS } from "@/lib/watch2gether/unicodeEmojis";

interface Props {
  /** Called with the text to insert (unicode emoji or `:shortcode:`). */
  onPick: (insert: string) => void;
  /** When true, portal the panel into the fullscreen player element so it's
   *  visible over the video (a body portal is hidden behind the FS element). */
  fullscreen?: boolean;
  className?: string;
}

const PANEL_W = 300;
const PANEL_H = 340;

// Lightweight, instant emoji picker styled to the app — no heavy third-party
// lib (PicMo was laggy + invisible in fullscreen). Shows our custom anime
// emojis first, then the FULL unicode set grouped by category with a search box.
export default function EmojiButton({ onPick, fullscreen, className = "" }: Props) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [query, setQuery] = useState("");
  // Active category for the tab bar; "anime" is our custom set.
  const [cat, setCat] = useState<string>("anime");

  // Position the panel above the trigger.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    let left = r.left;
    left = Math.min(left, window.innerWidth - PANEL_W - 8);
    left = Math.max(8, left);
    const top = Math.max(8, r.top - PANEL_H - 8);
    setPos({ top, left });
  }, [open]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node))
        return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Reset search/category each time the picker opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setCat("anime");
    }
  }, [open]);

  const pick = (insert: string) => onPick(insert);

  // When searching, match anime shortcodes/labels/tags AND scan all unicode
  // emojis (we can't keyword unicode without a huge map, so a non-empty query
  // simply collapses to the anime matches + the full unicode grid).
  const q = query.trim().toLowerCase();
  const animeMatches = useMemo(() => {
    if (!q) return ANIME_EMOJIS;
    return ANIME_EMOJIS.filter(
      (e) =>
        e.emoji.toLowerCase().includes(q) ||
        e.label.toLowerCase().includes(q) ||
        e.tags?.some((t) => t.includes(q)),
    );
  }, [q]);

  // Portal target: the fullscreen element (so it shows over the video) or body.
  const portalTarget =
    typeof document === "undefined"
      ? null
      : fullscreen
        ? ((document.fullscreenElement as HTMLElement) ||
           (document as any).webkitFullscreenElement ||
           document.body)
        : document.body;

  const grid = (children: React.ReactNode) => (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 2 }}>{children}</div>
  );

  const unicodeBtn = (u: string) => (
    <button
      key={u}
      type="button"
      onClick={() => pick(u)}
      style={{
        fontSize: 20,
        lineHeight: "28px",
        padding: 2,
        borderRadius: 6,
        background: "transparent",
        border: "none",
        cursor: "pointer",
      }}
      onMouseEnter={(ev) => (ev.currentTarget.style.background = "rgba(255,255,255,0.1)")}
      onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}
    >
      {u}
    </button>
  );

  // Body: either the active category grid, or — when searching — anime matches
  // followed by the full unicode set (so "all the emojis" stay reachable).
  const activeCategory = EMOJI_CATEGORIES.find((c) => c.name === cat);
  const unicodeToShow = q ? ALL_EMOJIS : activeCategory?.emojis || [];

  const panel =
    open && pos && portalTarget
      ? createPortal(
          <div
            ref={panelRef}
            className="scrollbar-hide"
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              width: PANEL_W,
              height: PANEL_H,
              display: "flex",
              flexDirection: "column",
              zIndex: 2147483000,
              background: "#212127",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 12,
              boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
              overflow: "hidden",
            }}
          >
            {/* Search */}
            <div style={{ padding: "8px 8px 6px" }}>
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search emoji…"
                style={{
                  width: "100%",
                  fontSize: 13,
                  padding: "6px 10px",
                  borderRadius: 8,
                  background: "rgba(255,255,255,0.08)",
                  border: "none",
                  outline: "none",
                  color: "#fff",
                }}
              />
            </div>

            {/* Category tabs (hidden while searching). */}
            {!q && (
              <div
                className="scrollbar-hide"
                style={{
                  display: "flex",
                  gap: 2,
                  padding: "0 6px 6px",
                  overflowX: "auto",
                  flexShrink: 0,
                }}
              >
                <button
                  type="button"
                  onClick={() => setCat("anime")}
                  title="Anime"
                  style={tabStyle(cat === "anime")}
                >
                  ⭐
                </button>
                {EMOJI_CATEGORIES.map((c) => (
                  <button
                    key={c.name}
                    type="button"
                    onClick={() => setCat(c.name)}
                    title={c.name}
                    style={tabStyle(cat === c.name)}
                  >
                    {c.icon}
                  </button>
                ))}
              </div>
            )}

            {/* Scrollable body */}
            <div className="scrollbar-hide" style={{ overflowY: "auto", padding: "0 10px 10px", flex: 1 }}>
              {/* Anime custom emojis: shown on the Anime tab or as search matches. */}
              {(q || cat === "anime") && animeMatches.length > 0 && (
                <>
                  <div style={labelStyle}>Anime</div>
                  {grid(
                    animeMatches.map((e) => (
                      <button
                        key={e.emoji}
                        type="button"
                        title={e.label}
                        onClick={() => pick(e.emoji)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: 4,
                          borderRadius: 6,
                          background: "transparent",
                          border: "none",
                          cursor: "pointer",
                        }}
                        onMouseEnter={(ev) => (ev.currentTarget.style.background = "rgba(255,255,255,0.1)")}
                        onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={e.url} alt={e.label} style={{ width: 22, height: 22 }} loading="lazy" />
                      </button>
                    )),
                  )}
                </>
              )}

              {/* Unicode emojis. */}
              {unicodeToShow.length > 0 && (
                <>
                  <div style={labelStyle}>{q ? "Emoji" : activeCategory?.name}</div>
                  {grid(unicodeToShow.map(unicodeBtn))}
                </>
              )}

              {q && animeMatches.length === 0 && (
                <div style={{ ...labelStyle, marginTop: 12 }}>No anime emoji match</div>
              )}
            </div>
          </div>,
          portalTarget,
        )
      : null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Emoji"
        className={`flex h-9 w-9 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white ${className}`}
      >
        <BsEmojiSmile size={18} />
      </button>
      {panel}
    </>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: "rgba(255,255,255,0.5)",
  margin: "8px 2px 6px",
  position: "sticky",
  top: 0,
  background: "#212127",
};

function tabStyle(active: boolean): React.CSSProperties {
  return {
    flexShrink: 0,
    fontSize: 16,
    lineHeight: "24px",
    width: 30,
    height: 30,
    borderRadius: 8,
    border: "none",
    cursor: "pointer",
    background: active ? "rgba(255,255,255,0.14)" : "transparent",
  };
}
