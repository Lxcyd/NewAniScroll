import { CSSProperties, useRef, useCallback, useEffect } from "react";
import Link from "next/link";
import { MediaRecommendation } from "types/info/AnilistInfoTypes";
import { useTranslation } from "react-i18next";

type Props = {
  items: MediaRecommendation[];
  forTitle: string;
};

const DRAG_THRESHOLD = 8;

export default function Recommendations({ items, forTitle }: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const dragMovedRef = useRef(false);

  const scroll = (dir: number) => {
    ref.current?.scrollBy({ left: dir * 520, behavior: "smooth" });
  };

  // Mouse-only drag-to-scroll. We deliberately do NOT use setPointerCapture:
  // capturing the pointer on the scroll container steals the trailing `click`
  // from the child <Link>, so plain clicks on a card never navigated. Instead
  // we bind mousemove/mouseup on window for the duration of a mouse drag.
  // Touch is left entirely to native overflow scrolling (no JS), so taps stay
  // taps and remain tappable on mobile.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let isDown = false;
    let startX = 0;
    let startScroll = 0;

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      isDown = true;
      startX = e.clientX;
      startScroll = el.scrollLeft;
      dragMovedRef.current = false;
    };
    const onMove = (e: MouseEvent) => {
      if (!isDown) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > DRAG_THRESHOLD) dragMovedRef.current = true;
      el.scrollLeft = startScroll - dx;
    };
    const onUp = () => {
      isDown = false;
    };

    el.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      el.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (dragMovedRef.current) {
      e.preventDefault();
      e.stopPropagation();
      dragMovedRef.current = false;
    }
  }, []);

  // AniList can list the same target anime across several recommendation
  // edges, which surfaced as visible duplicates in the carousel (e.g. the
  // same title twice in a row). Dedup by media id, keeping first occurrence.
  const seen = new Set<number>();
  const uniqueItems = (items || []).filter((r) => {
    if (r?.id == null || seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
  if (uniqueItems.length === 0) return null;
  return (
    <div style={rStyles.wrap}>
      <div style={rStyles.header}>
        <div>
          <div style={rStyles.kicker}>{t("anime.sectionRecommendations")}</div>
          <div style={rStyles.headTitle}>{t("anime.becauseWatching", { title: forTitle })}</div>
        </div>
        <div style={rStyles.nav}>
          <button style={rStyles.navBtn} onClick={() => scroll(-1)} aria-label={t("anime.prev")}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button style={rStyles.navBtn} onClick={() => scroll(1)} aria-label={t("anime.next")}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      </div>
      <div
        ref={ref}
        style={rStyles.carousel}
        onClickCapture={onClickCapture}
      >
        {uniqueItems.map((r) => (
          <Link
            key={r.id}
            href={`/en/anime/${r.id}`}
            draggable={false}
            style={{ ...rStyles.cardLink } as CSSProperties}
          >
            <div style={rStyles.cover}>
              {r.coverImage?.extraLarge && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={r.coverImage.extraLarge}
                  alt={r.title?.romaji || ""}
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                  }}
                />
              )}
              <div style={rStyles.recPlay}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
                  <polygon points="5 3 19 12 5 21" />
                </svg>
              </div>
            </div>
            <div style={rStyles.body}>
              <div style={rStyles.title}>{r.title?.english || r.title?.romaji}</div>
              <div style={rStyles.meta}>
                {r.seasonYear && <span>{r.seasonYear}</span>}
                {r.seasonYear && r.averageScore != null && (
                  <span style={rStyles.dot} />
                )}
                {r.averageScore != null && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="#f6c544">
                      <polygon points="12 2 15 9 22 9 17 14 19 21 12 17 5 21 7 14 2 9 9 9" />
                    </svg>
                    {(r.averageScore / 10).toFixed(1)}
                  </span>
                )}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

const rStyles: Record<string, CSSProperties> = {
  wrap: { display: "flex", flexDirection: "column", gap: 14 },
  header: { display: "flex", alignItems: "flex-end", justifyContent: "space-between" },
  kicker: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.14em",
    color: "var(--txt-3)",
    marginBottom: 4,
  },
  headTitle: { fontSize: 20, fontWeight: 700, letterSpacing: "-0.01em", color: "var(--txt-0)" },
  nav: { display: "flex", gap: 6 },
  navBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    background: "var(--bg-2)",
    border: "1px solid var(--line)",
    display: "grid",
    placeItems: "center",
    color: "var(--txt-1)",
    cursor: "pointer",
  },
  carousel: {
    display: "flex",
    gap: 14,
    overflowX: "auto",
    overflowY: "hidden",
    paddingBottom: 8,
    // No scroll-snap: `x mandatory` fought the click-and-drag handler — the
    // snap held the scroll, then jumped a whole card at once ("teleport by
    // one card"). Free scrolling lets the drag track the pointer smoothly.
    userSelect: "none",
    cursor: "grab",
  },
  cardLink: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    /* Fixed 180px-wide card per the design handoff. flex-basis alone
       isn't enough when the carousel is shorter than the viewport: the
       browser distributes free space and stretches each card. width
       pins them. */
    flex: "0 0 180px",
    width: 180,
    textDecoration: "none",
    color: "inherit",
    alignSelf: "flex-start",
  },
  cover: {
    position: "relative",
    width: "100%",
    aspectRatio: "3/4",
    borderRadius: 10,
    overflow: "hidden",
    border: "1px solid var(--line)",
    background: "var(--bg-3)",
    flexShrink: 0,
  },
  recPlay: {
    position: "absolute",
    bottom: 8,
    right: 8,
    width: 30,
    height: 30,
    borderRadius: 8,
    background: "var(--accent)",
    display: "grid",
    placeItems: "center",
    paddingLeft: 2,
  },
  body: { display: "flex", flexDirection: "column", gap: 2 },
  title: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--txt-0)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  meta: { display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--txt-3)" },
  dot: { width: 3, height: 3, borderRadius: 2, background: "var(--txt-3)" },
};
