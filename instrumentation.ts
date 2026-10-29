/**
 * Runs once when a Node server/function starts.
 *
 * Vercel strips `s-maxage` and `stale-while-revalidate` from `Cache-Control`
 * before the response leaves its CDN (measured 30/10/2026: anilist-health sends
 * "public, s-maxage=300, stale-while-revalidate=600", the client gets
 * "public"). A CDN in front of Vercel (Cloudflare) then sees a bare `public`
 * and applies its own default TTL — 2 h, so /source links would outlive their
 * tokens. `CDN-Cache-Control` is forwarded untouched and read by both Vercel
 * (first) and Cloudflare.
 *
 * So: every `Cache-Control` carrying `s-maxage` is mirrored into
 * `CDN-Cache-Control`, unless the route already set one. ~40 call sites, one
 * rule. Vercel keeps the same TTLs (it already preferred CDN-Cache-Control).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ServerResponse } = await import("http");
  const setHeader = ServerResponse.prototype.setHeader;
  ServerResponse.prototype.setHeader = function (name, value) {
    if (
      typeof name === "string" &&
      name.toLowerCase() === "cache-control" &&
      String(value).includes("s-maxage") &&
      !this.hasHeader("cdn-cache-control")
    ) {
      setHeader.call(this, "CDN-Cache-Control", value);
    }
    return setHeader.call(this, name, value);
  };
}
