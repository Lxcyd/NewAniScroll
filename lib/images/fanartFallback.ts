/**
 * Fallback for fanart images served through the Cloudflare proxy
 * (fanart-proxy.aniscroll.com, see lib/db/fanarts.ts).
 *
 * The proxy converts images to AVIF via CF Image Transformations — limited
 * to 5,000 unique transformations/month on the free tier. Two distinct
 * failure shapes:
 *   - 429: the month's quota is spent AND this variant was never transformed,
 *     so CF refuses to make a new one. Persistent until the quota resets.
 *   - 502: a transient CF Image Resizing hiccup (origin fanart.tv slow on a
 *     cold variant). Retrying the SAME proxied URL usually works seconds later.
 *
 * A variant already in the edge cache is served (free, CF-Cache-Status: HIT)
 * regardless of quota — so we must NEVER abandon the proxy wholesale on a
 * single blip, or we'd throw away every cached AVIF for the rest of the
 * session over one transient 502.
 *
 * Strategy (client-side, per tab):
 *  - `onFanartError` (wire to <img onError>): swap the failing image to the
 *    ORIGINAL assets.fanart.tv URL (untransformed, no quota) so it renders
 *    immediately, and count the failure.
 *  - Only after several failures in the session do we conclude the quota is
 *    genuinely exhausted and set a flag.
 *  - `fanartSrc` (wrap the src at render time): once that flag is up, point
 *    every subsequent fanart straight at the origin — we stop hammering an
 *    exhausted endpoint. Below the threshold we keep using the proxy so a
 *    transient 502 doesn't cost us the cached AVIFs.
 */

import type { SyntheticEvent } from "react";

const FANART_ORIGIN = "https://assets.fanart.tv";
const FLAG = "fanart-proxy-exhausted";
const COUNT_KEY = "fanart-proxy-failures";
// Below this many in-session failures we treat each as a transient blip and
// keep using the proxy for OTHER images (only the failing one falls back).
// At/above it we conclude the quota is spent and route everything to origin.
const EXHAUSTION_THRESHOLD = 3;

/** Proxied URLs keep fanart.tv's path (/fanart/<slug>/<file>); only the host
 *  differs. Returns null when the URL isn't a proxied fanart (nothing to
 *  fall back to). Host-agnostic so FANART_PROXY_HOST changes keep working. */
export function originalFanartUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.origin === FANART_ORIGIN) return null; // already the original
    if (!u.pathname.startsWith("/fanart/")) return null; // not a fanart URL
    return FANART_ORIGIN + u.pathname + u.search;
  } catch {
    return null;
  }
}

function proxyMarkedDown(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}

/** Record one proxy failure; flip the session flag once enough have piled up
 *  that it's clearly the monthly quota, not a transient 502. */
function recordFailure(): void {
  try {
    const n = (Number(sessionStorage.getItem(COUNT_KEY)) || 0) + 1;
    sessionStorage.setItem(COUNT_KEY, String(n));
    if (n >= EXHAUSTION_THRESHOLD) sessionStorage.setItem(FLAG, "1");
  } catch {}
}

/** Wrap every fanart src with this. Passes the proxied URL through normally;
 *  once enough in-session failures prove the quota is exhausted, it rewrites
 *  to the origin URL so we stop calling the dead transformation endpoint. */
export function fanartSrc<T extends string | null | undefined>(url: T): T | string {
  if (!url) return url;
  if (!proxyMarkedDown()) return url;
  return originalFanartUrl(url) ?? url;
}

/** onError handler for any <img>/<Image> showing a fanart. Swaps to the
 *  original (untransformed) URL exactly once — if THAT fails too, the image
 *  is genuinely gone and we leave it alone (no retry loop). Each swap counts
 *  toward the exhaustion threshold. */
export function onFanartError(e: SyntheticEvent<HTMLImageElement>): void {
  const img = e.currentTarget;
  const fallback = originalFanartUrl(img.src);
  if (!fallback || fallback === img.src) return;
  recordFailure();
  img.src = fallback;
  // next/image also tracks `srcset`; clear it so the browser doesn't keep
  // picking the broken proxied candidate over our fallback src.
  img.srcset = "";
}
