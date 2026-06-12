import { CSSProperties, useEffect, useState } from "react";
import { collectArtworks, FanartResponse } from "./helpers";
import styles from "./styles.module.css";
import { useTranslation } from "react-i18next";
import { fanartSrc, onFanartError } from "@/lib/images/fanartFallback";

type Props = {
  fanarts: FanartResponse | null;
  /** Cover from AniList — always include as a default artwork. */
  coverFallback?: string | null;
  bannerFallback?: string | null;
};

const TYPE_LABEL: Record<string, string> = {
  background: "Key Visual",
  poster: "Poster",
  banner: "Banner",
  thumb: "Thumbnail",
  seasonposter: "Season Poster",
  seasonbanner: "Season Banner",
  seasonthumb: "Season Thumb",
};

export default function Artworks({
  fanarts,
  coverFallback,
  bannerFallback,
}: Props) {
  const { t } = useTranslation();
  const typeLabel = (type: string) =>
    TYPE_LABEL[type] ? t(`anime.artType.${type}`) : type;
  const arts = collectArtworks(fanarts);
  const [lightbox, setLightbox] = useState<string | null>(null);

  // Augment with the AniList cover / banner if we have basically nothing else.
  const augmented =
    arts.length === 0
      ? [
          ...(coverFallback
            ? [
                {
                  url: coverFallback,
                  type: "poster",
                  language: null,
                  likes: 0,
                  season: null,
                  label: "safe",
                },
              ]
            : []),
          ...(bannerFallback
            ? [
                {
                  url: bannerFallback,
                  type: "background",
                  language: null,
                  likes: 0,
                  season: null,
                  label: "safe",
                },
              ]
            : []),
        ]
      : arts;

  // Close lightbox on Escape + lock page scroll while it's open.
  // We can't just set body.overflow=hidden because the site already sets
  // body { overflow-x: hidden } globally — so the actual scroll
  // container is <html>. Lock both axes on the html element, and pin
  // the body in place with `position: fixed; top: -scrollY` so iOS
  // Safari doesn't keep scrolling under the modal either.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", onKey);

    const scrollY = window.scrollY;
    const html = document.documentElement;
    const body = document.body;
    const prev = {
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
      bodyPosition: body.style.position,
      bodyTop: body.style.top,
      bodyLeft: body.style.left,
      bodyRight: body.style.right,
      bodyWidth: body.style.width,
    };

    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";

    return () => {
      window.removeEventListener("keydown", onKey);
      html.style.overflow = prev.htmlOverflow;
      body.style.overflow = prev.bodyOverflow;
      body.style.position = prev.bodyPosition;
      body.style.top = prev.bodyTop;
      body.style.left = prev.bodyLeft;
      body.style.right = prev.bodyRight;
      body.style.width = prev.bodyWidth;
      // Restore scroll position — `position: fixed` resets it to 0.
      window.scrollTo(0, scrollY);
    };
  }, [lightbox]);

  if (augmented.length === 0) {
    return (
      <div
        style={{
          padding: 16,
          background: "var(--bg-2)",
          border: "1px solid var(--line)",
          borderRadius: 10,
          color: "var(--txt-3)",
          fontSize: 13,
        }}
      >
        No artworks available for this title.
      </div>
    );
  }

  return (
    <>
      {/* CSS column masonry: each image keeps its natural aspect ratio
          (width:100%; height:auto), and the browser packs them into
          balanced columns top-to-bottom, then left-to-right.
          A landscape banner naturally takes ~2 column-rows of space; a
          square poster takes ~1; a tall key visual takes ~1.5. No JS
          measurement, no row-span heuristics, no cropping. */}
      <div className={styles.artworkCols}>
        {augmented.map((a, i) => (
          <button
            key={`${a.type}-${a.url}-${i}`}
            onClick={() => setLightbox(a.url)}
            style={aStyles.card}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={fanartSrc(a.url)}
              alt={typeLabel(a.type)}
              style={aStyles.img}
              loading="lazy"
              decoding="async"
              onError={onFanartError}
            />
            <div style={aStyles.gradient} />
            <div style={aStyles.label}>
              <span
                className="mono"
                style={{ fontSize: 10, color: "rgba(255,255,255,0.65)" }}
              >
                ART · {String(i + 1).padStart(2, "0")}
              </span>
              <span
                style={{ fontSize: 13, fontWeight: 600, color: "white" }}
              >
                {typeLabel(a.type)}
              </span>
            </div>
            <span style={aStyles.expand}>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
              </svg>
            </span>
          </button>
        ))}
      </div>

      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={aStyles.lightbox}
          role="dialog"
          aria-modal="true"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={fanartSrc(lightbox)}
            alt=""
            style={aStyles.lightboxImg}
            onError={onFanartError}
          />
          <button
            onClick={(e) => {
              e.stopPropagation();
              setLightbox(null);
            }}
            style={aStyles.lightboxClose}
            aria-label={t("anime.close")}
          >
            ✕
          </button>
        </div>
      )}
    </>
  );
}

const aStyles: Record<string, CSSProperties> = {
  card: {
    /* `break-inside: avoid` keeps a card from being split across
       columns. `display: inline-block` is required for column flow
       items so block-level <button> doesn't break the layout. */
    display: "inline-block",
    width: "100%",
    marginBottom: 12,
    breakInside: "avoid",
    position: "relative",
    borderRadius: 12,
    overflow: "hidden",
    border: "1px solid var(--line)",
    padding: 0,
    background: "var(--bg-2)",
    cursor: "zoom-in",
    verticalAlign: "top",
  },
  img: {
    display: "block",
    width: "100%",
    height: "auto",
    /* Whole image visible, no cropping — preserves the original
       aspect ratio of each fanart (banner, poster, thumb…). */
    objectFit: "contain",
  },
  gradient: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: "35%",
    background:
      "linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.7) 80%)",
    pointerEvents: "none",
  },
  label: {
    position: "absolute",
    left: 12,
    bottom: 10,
    display: "flex",
    flexDirection: "column",
    gap: 2,
    /* Hard shadow so text stays readable against any artwork content
       below it now that the bottom scrim is gone. */
    textShadow: "0 1px 4px rgba(0,0,0,0.9), 0 0 12px rgba(0,0,0,0.8)",
  },
  expand: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 26,
    height: 26,
    borderRadius: 6,
    display: "grid",
    placeItems: "center",
    background: "rgba(0,0,0,0.4)",
    backdropFilter: "blur(6px)",
    WebkitBackdropFilter: "blur(6px)",
    color: "rgba(255,255,255,0.85)",
    border: "1px solid rgba(255,255,255,0.1)",
  },
  /* Lightbox layout: the site navbar is fixed at the top with z-index
     9999, so a full-screen modal would render *behind* it and clip the
     image's top edge. We push the modal down by NAV_OFFSET so the image
     centers in the visible area below the navbar, and cap its height
     accordingly. The backdrop still spans the full viewport. */
  lightbox: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    /* Darker tint + blur. The page behind the modal stays scroll-locked
       (cf. the body.overflow=hidden in the effect), so the backdrop is
       a static snapshot — blurring it makes the focused artwork pop
       without competing with the neighbouring tiles. */
    background: "rgba(0,0,0,0.75)",
    backdropFilter: "blur(18px)",
    WebkitBackdropFilter: "blur(18px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 100,
    /* Top padding leaves room for the fixed navbar (~64px) + a small
       buffer; bottom matches so the image stays vertically balanced. */
    padding: "80px 24px 32px",
    cursor: "zoom-out",
  },
  lightboxImg: {
    maxWidth: "min(1400px, calc(100vw - 48px))",
    /* Subtract the same top+bottom padding that the lightbox container
       reserves so the bitmap never overflows underneath the navbar. */
    maxHeight: "calc(100vh - 112px)",
    objectFit: "contain",
    borderRadius: 8,
    boxShadow: "0 24px 60px rgba(0,0,0,0.7)",
    /* Browsers default <img>'s intrinsic baseline to text — that adds a
       few px of phantom height that lets the image bleed under the
       navbar at exact viewport heights. block kills it. */
    display: "block",
  },
  lightboxClose: {
    position: "fixed",
    /* Sit just below the navbar so it's always reachable, even when the
       lightboxImg is tall and pushes against the top padding. */
    top: 80,
    right: 16,
    width: 40,
    height: 40,
    borderRadius: 20,
    background: "rgba(255,255,255,0.1)",
    border: "1px solid rgba(255,255,255,0.2)",
    color: "white",
    fontSize: 16,
    cursor: "pointer",
    zIndex: 101,
  },
};
