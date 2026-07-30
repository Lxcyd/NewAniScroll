/**
 * Navbar contrast over the page's top artwork.
 *
 * The navbar floats transparent over the info page's banner, so every bit of its
 * chrome is white — links, icons, the search pill. That works because anime
 * banners are usually dark artwork… until one isn't: a white / pastel banner
 * (e.g. Nippon Sangoku) swallows the whole navbar and the user sees an empty
 * strip. Nothing in the AniList metadata tells us how bright a banner is, so the
 * only source of truth is the pixels themselves.
 *
 * So the component that owns the banner <img> reports the mean luminance of the
 * strip the navbar actually covers (`useNavBackdrop`), and the navbar flips to
 * dark chrome when white would be unreadable there (`useNavOnLight`).
 *
 * State lives outside React because the two sides are unrelated components on
 * opposite ends of the tree (the navbar is rendered by the page, the banner by
 * the hero) — a context would mean threading a provider through both layouts for
 * a single boolean.
 */

import { useEffect, useRef, useState } from "react";

/** Height of the artwork strip we judge, in CSS px. The navbar is `py-2` around
 *  a `min-h-[48px]` row = 64px; we look slightly lower so a bright band right
 *  under the links still counts. */
const STRIP_PX = 72;

/**
 * Mean WCAG relative luminance above which white chrome stops holding up.
 *
 * White text over a backdrop of luminance L has contrast `1.05 / (L + 0.05)`;
 * near-black text has `(L + 0.05) / 0.1055`. They cross at L ≈ 0.28, but
 * flipping right at the crossover would repaint the navbar on every mid-grey
 * banner for a marginal gain. We wait for 0.42 — genuinely light artwork —
 * so the site keeps its white chrome everywhere else.
 */
const LIGHT_L = 0.42;

let onLight = false;
const subscribers = new Set<() => void>();

/** Verdict per image URL. The pixels never change, so a second visit (SPA
 *  navigation back to an anime) can flip the navbar on its first paint instead
 *  of waiting for the image to load and be re-measured. */
const verdicts = new Map<string, boolean>();

function emit(): void {
  subscribers.forEach((fn) => {
    try {
      fn();
    } catch {
      /* a stale subscriber must not break the others */
    }
  });
}

export function isNavOnLight(): boolean {
  return onLight;
}

export function setNavOnLight(light: boolean): void {
  if (onLight === light) return;
  onLight = light;
  emit();
}

export function subscribeNavContrast(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** React view of the verdict — for the navbar. */
export function useNavOnLight(): boolean {
  const [light, setLight] = useState(false);
  useEffect(() => {
    const sync = () => setLight(isNavOnLight());
    // Catch a verdict that landed between this render and the subscription
    // (a cached banner can be measured before the navbar mounts its effect).
    sync();
    return subscribeNavContrast(sync);
  }, []);
  return light;
}

/* ── Measuring ──────────────────────────────────────────────────────────── */

function srgbToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** One `object-position` component as a 0..1 fraction. Covers the `%` and
 *  keyword forms our banners use; anything else falls back to the CSS default. */
function axisFraction(token: string | undefined, fallback: number): number {
  if (!token) return fallback;
  if (token.endsWith("%")) {
    const n = parseFloat(token);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n / 100)) : fallback;
  }
  switch (token) {
    case "left":
    case "top":
      return 0;
    case "center":
      return 0.5;
    case "right":
    case "bottom":
      return 1;
    default:
      return fallback;
  }
}

/**
 * Mean luminance of the source pixels that end up under the navbar, or null when
 * they can't be read (image not decoded yet, or a tainted canvas because the CDN
 * answered without CORS headers).
 *
 * The crop is derived from the element, never hardcoded: `object-fit: cover`
 * gives the scale, `object-position` the offset, so we sample exactly the rows
 * the navbar sits on — which is not the top of the file (our banners are drawn
 * from 30-35% down) and moves with the viewport width.
 */
export function measureNavBackdrop(img: HTMLImageElement): number | null {
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  const box = img.getBoundingClientRect();
  if (!nw || !nh || box.width < 1 || box.height < 1) return null;

  const scale = Math.max(box.width / nw, box.height / nh); // object-fit: cover
  const pos = getComputedStyle(img).objectPosition.trim().split(/\s+/);
  const fx = axisFraction(pos[0], 0.5);
  const fy = axisFraction(pos[1] ?? pos[0], 0.5);

  // Source rectangle visible inside the box, then its top STRIP_PX.
  const srcW = Math.min(nw, box.width / scale);
  const srcH = Math.min(nh, box.height / scale);
  const sx = (nw - srcW) * fx;
  const sy = (nh - srcH) * fy;
  const sh = Math.min(srcH, Math.min(box.height, STRIP_PX) / scale);
  if (sh < 1 || srcW < 1) return null;

  // 32×6 is plenty: we want the average tone of a strip, not detail.
  const W = 32;
  const H = 6;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  // High-quality downscale = the browser averages the source block for us
  // instead of point-sampling 192 pixels out of a 1900px-wide banner.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  try {
    ctx.drawImage(img, sx, sy, srcW, sh, 0, 0, W, H);
    const { data } = ctx.getImageData(0, 0, W, H);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum +=
        0.2126 * srgbToLinear(data[i]) +
        0.7152 * srgbToLinear(data[i + 1]) +
        0.0722 * srgbToLinear(data[i + 2]);
    }
    return sum / (data.length / 4);
  } catch {
    // SecurityError (tainted canvas) or a decode failure — keep the default
    // white chrome rather than guessing.
    return null;
  }
}

/* ── Reporting side ─────────────────────────────────────────────────────── */

type BackdropImgProps = {
  ref: (el: HTMLImageElement | null) => void;
  crossOrigin?: "anonymous";
  onLoad: () => void;
  onError: () => void;
};

/**
 * Wire the page's top artwork into the navbar's contrast decision: spread the
 * returned props onto that <img>.
 *
 * `crossOrigin` is what makes the pixels readable — without it the canvas is
 * tainted and `getImageData` throws. AniList's CDN does answer with CORS headers
 * (and the info page preloads the banner with the same `crossorigin`, so this
 * costs no second request). If some host ever doesn't, the image would fail to
 * load *at all* — hence `onError`: it drops the attribute and reloads plainly,
 * giving up on the probe rather than on the banner.
 */
export function useNavBackdrop(src: string | null | undefined): BackdropImgProps {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [cors, setCors] = useState(true);

  const measure = (img: HTMLImageElement, key: string) => {
    const luminance = measureNavBackdrop(img);
    if (luminance === null) return;
    const light = luminance > LIGHT_L;
    verdicts.set(key, light);
    setNavOnLight(light);
  };

  useEffect(() => {
    if (!src) {
      setNavOnLight(false);
      return;
    }
    const known = verdicts.get(src);
    if (known !== undefined) {
      setNavOnLight(known);
    } else {
      // Unknown artwork: assume dark (the site's normal case) until measured.
      setNavOnLight(false);
      // A browser-cached image can be complete before React attaches `onLoad`,
      // in which case that event never fires — measure it here instead.
      const img = imgRef.current;
      if (img?.complete) measure(img, src);
    }
    // Leaving the page (or switching anime) → back to white chrome until the
    // next banner reports in.
    return () => setNavOnLight(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, cors]);

  return {
    ref: (el) => {
      imgRef.current = el;
    },
    crossOrigin: cors ? "anonymous" : undefined,
    onLoad: () => {
      const img = imgRef.current;
      if (!img || !src) return;
      // One frame later: the <img> has its final box (the hero's layout settles
      // in the same paint), and the crop depends on that box.
      requestAnimationFrame(() => measure(img, src));
    },
    onError: () => setCors(false),
  };
}
