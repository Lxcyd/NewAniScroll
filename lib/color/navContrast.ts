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
 * So the page that shows a banner declares it (`useNavBackdrop`), the brightness
 * of its top is measured server-side (`/api/v2/banner-tone` — see that file for
 * why it can't be done in the browser), and the navbar flips to dark chrome when
 * white would be unreadable (`useNavOnLight`).
 *
 * State lives outside React because the two sides are unrelated components on
 * opposite ends of the tree (the navbar is rendered by the page, the banner by
 * the hero) — a context would mean threading a provider through both layouts for
 * a single boolean.
 */

import { useEffect, useState } from "react";

/**
 * Mean WCAG relative luminance above which white chrome stops holding up.
 *
 * White text over a backdrop of luminance L has contrast `1.05 / (L + 0.05)`;
 * near-black text has `(L + 0.05) / 0.1055`. They cross at L ≈ 0.28, but
 * flipping right at the crossover would repaint the navbar on every mid-grey
 * banner for a marginal gain. We wait for 0.42 — genuinely light artwork — so
 * the site keeps its white chrome everywhere else. Measured over 20 real
 * banners: white/pastel ones land at 0.51-0.99, blue-sky ones at 0.28-0.37.
 *
 * The threshold lives here rather than in the API route on purpose: the route's
 * answer is CDN-cached for a year, so tuning this must not need a cache bust.
 */
const LIGHT_L = 0.42;

let onLight = false;
const subscribers = new Set<() => void>();

/** Luminance per image URL. The pixels never change, so a second visit (SPA
 *  navigation back to an anime) flips the navbar on its first paint instead of
 *  waiting for another round-trip. */
const measured = new Map<string, number>();
/** In-flight probes, so two components asking for the same banner (or a fast
 *  back-and-forth) share one request. */
const pending = new Map<string, Promise<number | null>>();

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
    // (a cached measurement is applied the moment the banner mounts).
    sync();
    return subscribeNavContrast(sync);
  }, []);
  return light;
}

/** Mean luminance of the top of `src`, or null if it couldn't be measured. */
async function probe(src: string): Promise<number | null> {
  const cached = measured.get(src);
  if (cached !== undefined) return cached;

  const inFlight = pending.get(src);
  if (inFlight) return inFlight;

  const run = (async () => {
    try {
      const res = await fetch(
        `/api/v2/banner-tone?u=${encodeURIComponent(src)}`
      );
      if (!res.ok) return null;
      const { l } = await res.json();
      if (typeof l !== "number" || !Number.isFinite(l)) return null;
      measured.set(src, l);
      return l;
    } catch {
      // Offline, blocked, upstream down — the navbar keeps its default chrome,
      // which is the right look for the overwhelming majority of banners.
      return null;
    } finally {
      pending.delete(src);
    }
  })();

  pending.set(src, run);
  return run;
}

/**
 * Declare the artwork the navbar currently floats over. Call it from whatever
 * renders the page's banner; it has no visual output of its own.
 *
 * Passing null (or leaving the page) resets the navbar to its default white
 * chrome — the flip must never outlive the banner that justified it.
 */
export function useNavBackdrop(src: string | null | undefined): void {
  useEffect(() => {
    if (!src) {
      setNavOnLight(false);
      return;
    }

    const known = measured.get(src);
    if (known !== undefined) {
      setNavOnLight(known > LIGHT_L);
    } else {
      // Unknown artwork: assume dark (the site's normal case) until measured.
      setNavOnLight(false);
      let cancelled = false;
      void probe(src).then((l) => {
        if (!cancelled && l !== null) setNavOnLight(l > LIGHT_L);
      });
      return () => {
        cancelled = true;
        setNavOnLight(false);
      };
    }

    return () => setNavOnLight(false);
  }, [src]);
}
