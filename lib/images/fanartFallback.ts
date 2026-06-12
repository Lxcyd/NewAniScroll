/**
 * Fallback for fanart images served through the Cloudflare proxy
 * (fanart-proxy.aniscroll.com, see lib/db/fanarts.ts).
 *
 * The proxy converts images to AVIF via CF Image Transformations — limited
 * to 5,000 unique transformations/month on the free tier. Once the month's
 * quota is exhausted, variants that are NOT already in the edge cache come
 * back as an error (429) and the <img> renders broken. Variants transformed
 * earlier in the month keep serving from cache for free, so we must not
 * abandon the proxy wholesale — only the failing images.
 *
 * Strategy (client-side, per tab):
 *  - `onFanartError` (wire it to the <img onError>): swap the failing image
 *    to the ORIGINAL assets.fanart.tv URL — untransformed, no quota — and
 *    raise a session flag.
 *  - `fanartSrc` (wrap the src at render time): once the flag is up, point
 *    every subsequent fanart straight at the origin, so we stop hammering
 *    the exhausted transformation endpoint for the rest of the session.
 */

import type { SyntheticEvent } from "react";

const FANART_ORIGIN = "https://assets.fanart.tv";
const FLAG = "fanart-proxy-exhausted";

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

function markProxyDown(): void {
  try {
    sessionStorage.setItem(FLAG, "1");
  } catch {}
}

/** Wrap every fanart src with this. Passes the proxied URL through normally;
 *  after the first in-session failure it rewrites to the origin URL. */
export function fanartSrc<T extends string | null | undefined>(url: T): T | string {
  if (!url) return url;
  if (!proxyMarkedDown()) return url;
  return originalFanartUrl(url) ?? url;
}

/** onError handler for any <img>/<Image> showing a fanart. Retries the
 *  original (untransformed) URL exactly once — if THAT fails too, the image
 *  is genuinely gone and we leave it alone (no retry loop). */
export function onFanartError(e: SyntheticEvent<HTMLImageElement>): void {
  const img = e.currentTarget;
  const fallback = originalFanartUrl(img.src);
  if (!fallback || fallback === img.src) return;
  markProxyDown();
  img.src = fallback;
  // next/image also tracks `srcset`; clear it so the browser doesn't keep
  // picking the broken proxied candidate over our fallback src.
  img.srcset = "";
}
