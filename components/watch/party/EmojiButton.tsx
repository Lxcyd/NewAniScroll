import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { BsEmojiSmile } from "react-icons/bs";
import { ANIME_EMOJIS, ANIME_EMOJI_MAP } from "@/lib/watch2gether/animeEmojis";
import { ANIME_STICKERS, ANIME_STICKER_MAP } from "@/lib/watch2gether/animeStickers";
import { EMOJI_CATEGORIES, ALL_EMOJIS } from "@/lib/watch2gether/unicodeEmojis";

interface Props {
  /** Called with the text to insert (unicode emoji or `:shortcode:`). */
  onPick: (insert: string) => void;
  /** When true, portal the panel into the fullscreen player element so it's
   *  visible over the video (a body portal is hidden behind the FS element). */
  fullscreen?: boolean;
  className?: string;
}

const PANEL_W = 360;
const PANEL_H = 420;

const RECENTS_KEY = "w2g.emoji.recents";
const RECENTS_MAX = 32;

// Read / persist the most-recently-used emojis (unicode chars or :shortcodes:).
function loadRecents(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.slice(0, RECENTS_MAX) : [];
  } catch {
    return [];
  }
}
function pushRecent(insert: string): string[] {
  const next = [insert, ...loadRecents().filter((e) => e !== insert)].slice(0, RECENTS_MAX);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* localStorage may be unavailable */
  }
  return next;
}

// Lightweight, instant emoji picker styled to the app — no heavy third-party
// lib (PicMo was laggy + invisible in fullscreen). First tab is "Popular"
// (recently-used MRU + our custom anime set), then the FULL unicode set grouped
// by category (incl. Flags) with a search box. Wide enough that every category
// tab — Flags included — is visible without horizontal scrolling.
export default function EmojiButton({ onPick, fullscreen, className = "" }: Props) {
  const { t } = useTranslation();
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<string[]>([]);
  // Active tab: "popular" (recents + anime customs combined), or a category name.
  const [cat, setCat] = useState<string>("popular");

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

  // Reset search each time the picker opens, refresh recents, and land on the
  // combined "Popular" tab (recents + anime customs).
  useEffect(() => {
    if (open) {
      setQuery("");
      setRecents(loadRecents());
      setCat("popular");
    }
  }, [open]);

  const pick = (insert: string) => {
    setRecents(pushRecent(insert));
    onPick(insert);
  };

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

  // Real anime stickers (image-only, from /public). Same search behaviour.
  const stickerMatches = useMemo(() => {
    if (!q) return ANIME_STICKERS;
    return ANIME_STICKERS.filter(
      (s) =>
        s.shortcode.toLowerCase().includes(q) ||
        s.label.toLowerCase().includes(q) ||
        s.tags?.some((t) => t.includes(q)),
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

  const unicodeBtn = (u: string, key?: string) => (
    <button
      key={key || u}
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

  const animeBtn = (shortcode: string, label: string, url: string, key?: string) => (
    <button
      key={key || shortcode}
      type="button"
      title={label}
      onClick={() => pick(shortcode)}
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
      <img src={url} alt={label} style={{ width: 22, height: 22 }} loading="lazy" />
    </button>
  );

  // Image-only anime sticker (served from /public). Slightly larger than emoji.
  const stickerBtn = (shortcode: string, label: string, src: string, key?: string) => (
    <button
      key={key || shortcode}
      type="button"
      title={label}
      onClick={() => pick(shortcode)}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 3,
        borderRadius: 6,
        background: "transparent",
        border: "none",
        cursor: "pointer",
      }}
      onMouseEnter={(ev) => (ev.currentTarget.style.background = "rgba(255,255,255,0.1)")}
      onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={label} style={{ width: 28, height: 28 }} loading="lazy" />
    </button>
  );

  // A recent entry is a sticker `:shortcode:`, an anime-custom `:shortcode:`, or
  // a unicode char.
  const recentBtn = (entry: string, i: number) => {
    const sticker = ANIME_STICKER_MAP[entry];
    if (sticker) return stickerBtn(sticker.shortcode, sticker.label, sticker.src, `r-${i}`);
    const custom = ANIME_EMOJI_MAP[entry];
    return custom
      ? animeBtn(custom.emoji, custom.label, custom.url, `r-${i}`)
      : unicodeBtn(entry, `r-${i}`);
  };

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
                placeholder={t("party.emojiSearch")}
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
                  onClick={() => setCat("popular")}
                  title={t("party.emojiPopular")}
                  style={tabStyle(cat === "popular")}
                >
                  ⭐
                </button>
                {/* Anime stickers tab — only shown when at least one sticker is
                    configured (avoids an empty tab while the art is being added). */}
                {ANIME_STICKERS.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setCat("anime")}
                    title={t("party.emojiAnime")}
                    style={tabStyle(cat === "anime")}
                  >
                    🎌
                  </button>
                )}
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
              {/* Anime stickers: their own tab, and surfaced FIRST in search. */}
              {(q || cat === "anime") && stickerMatches.length > 0 && (
                <>
                  <div style={labelStyle}>{t("party.emojiAnime")}</div>
                  {grid(stickerMatches.map((s) => stickerBtn(s.shortcode, s.label, s.src)))}
                </>
              )}

              {/* Popular = the anime custom set FIRST, then recently used (mix of
                  anime + unicode). Also where search shows its anime matches. */}
              {(q || cat === "popular") && animeMatches.length > 0 && (
                <>
                  <div style={labelStyle}>{t("party.emojiPopular")}</div>
                  {grid(animeMatches.map((e) => animeBtn(e.emoji, e.label, e.url)))}
                </>
              )}
              {!q && cat === "popular" && recents.length > 0 && (
                <>
                  <div style={labelStyle}>{t("party.emojiRecents")}</div>
                  {grid(recents.map((entry, i) => recentBtn(entry, i)))}
                </>
              )}

              {/* Unicode emojis. */}
              {unicodeToShow.length > 0 && (
                <>
                  <div style={labelStyle}>{q ? t("party.emojiUnicode") : activeCategory?.name}</div>
                  {grid(unicodeToShow.map((u, i) => unicodeBtn(u, `u-${i}`)))}
                </>
              )}

              {q && animeMatches.length === 0 && stickerMatches.length === 0 && unicodeToShow.length === 0 && (
                <div style={{ ...labelStyle, marginTop: 12 }}>{t("party.emojiNoMatch")}</div>
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
