/**
 * AniScroll HLS proxy — Cloudflare Worker edition.
 *
 * Same contract as /api/v2/proxy/m3u8 on the Next.js side:
 *   GET https://<worker>/?url=<encoded>&referer=<optional>&vcookie=<optional>
 *
 * Why a Worker:
 *   - Vercel Fast Origin Transfer is metered (10 GB free), and every .ts segment
 *     goes through the proxy. A single popular episode burns 200-700 MB.
 *   - Cloudflare Workers have unmetered bandwidth + global edge cache. We can
 *     keep the Vercel proxy as a fallback (NEXT_PUBLIC_PROXY_BASE unset) while
 *     production points everything at the Worker.
 *
 * VOE cookie handling:
 *   The Next.js side already captures VOE's DDoS-Guard cookies during extract.
 *   To make the cookie available to the Worker without a shared store, the
 *   extractor embeds it as `vcookie=` in the playback URL handed to the client.
 *   The Worker reads it back here and forwards it as the `Cookie` header.
 *
 * This Worker also serves a few endpoints offloaded from Vercel to cut Fluid
 * Active CPU — see ./edge-endpoints.js (/w/health, /w/broadcast, /w/track).
 */

import { handleEdgeEndpoint } from "./edge-endpoints.js";

// CDNs that genuinely need single-flight requests per IP. Keep this list short
// — every entry slows down playback for that host. Only VOE's
// cloudwindow-route.com is documented to 403 on parallel hits.
const SERIALIZED_HOST_PATTERNS = [/cloudwindow-route\.com$/];
const serialQueues = new Map(); // host -> promise tail

function shouldSerialize(host) {
  return SERIALIZED_HOST_PATTERNS.some((re) => re.test(host));
}

async function serializedFetch(targetUrl, init) {
  const host = new URL(targetUrl).hostname;
  if (!shouldSerialize(host)) return fetch(targetUrl, init);
  const prev = serialQueues.get(host) || Promise.resolve();
  let release;
  const ours = new Promise((r) => (release = r));
  serialQueues.set(host, ours);
  try {
    await prev;
    return await fetch(targetUrl, init);
  } finally {
    release();
    if (serialQueues.get(host) === ours) serialQueues.delete(host);
  }
}

// Mirrors the host → referer logic from pages/api/v2/proxy/m3u8.js so direct
// links built by the client (which don't carry a referer query param for
// historical reasons) still authenticate against the upstream CDN.
function detectReferer(targetUrl) {
  if (
    targetUrl.includes("kwik.") ||
    targetUrl.includes("uwucdn.") ||
    targetUrl.includes("owocdn.") ||
    targetUrl.includes("nextcdn.") ||
    targetUrl.includes("files.nextcdn.")
  ) {
    return { referer: "https://kwik.cx/", origin: "https://kwik.cx" };
  }
  if (targetUrl.includes("animepahe.")) {
    return { referer: "https://animepahe.ru/", origin: null };
  }
  let host;
  try {
    host = new URL(targetUrl).hostname;
  } catch {
    host = "";
  }
  if (
    targetUrl.includes("megaup.") ||
    targetUrl.includes("stormshade") ||
    targetUrl.includes("mgstatics.") ||
    /rrr\.[a-z0-9]+\.(site|com|xyz)/.test(targetUrl) ||
    /[a-z]+\d+\.(xyz|live|site)/.test(host)
  ) {
    return { referer: "https://megaup.cc/", origin: "https://megaup.cc" };
  }
  if (targetUrl.includes("sibnet.ru")) {
    return {
      referer: "https://video.sibnet.ru/",
      origin: "https://video.sibnet.ru",
    };
  }
  if (targetUrl.includes("sendvid.")) {
    return { referer: "https://sendvid.com/", origin: "https://sendvid.com" };
  }
  if (targetUrl.includes("vmwesa.") || targetUrl.includes("vidmoly.")) {
    return { referer: "https://vidmoly.net/", origin: "https://vidmoly.net" };
  }
  if (
    targetUrl.includes("mewstream.buzz") ||
    targetUrl.includes("lostproject.club") ||
    targetUrl.includes("megaplay.buzz")
  ) {
    return { referer: "https://megaplay.buzz/", origin: "https://megaplay.buzz" };
  }
  return { referer: null, origin: null };
}

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges, Content-Type",
    ...extra,
  };
}

async function handle(request, env, ctx) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  const reqUrl = new URL(request.url);
  const url = reqUrl.searchParams.get("url");
  const referer = reqUrl.searchParams.get("referer");
  const vcookie = reqUrl.searchParams.get("vcookie");
  // Download mode. When set, the response is served as `Content-Disposition:
  // attachment` so the browser saves it. For binary content (.mp4 / .ts /
  // single segments) this works directly. For .m3u8 we rewrite the manifest
  // with ABSOLUTE proxy URLs (instead of relative-to-proxy ones) and serve
  // it as a downloadable playlist file — the user opens it in VLC / mpv /
  // yt-dlp / ffmpeg which then fetches the segments directly from Cloudflare
  // (zero Vercel transit). Free CF Workers cap subrequests at 50/req which
  // is below the ~240-segment count of a typical 24-min HLS episode, so we
  // intentionally don't concat server-side here.
  const isDownload = reqUrl.searchParams.get("dl") === "1";
  const downloadFilename = reqUrl.searchParams.get("filename") || null;
  // Pre-warm depth budget (see the m3u8 warm-up below). A normal player request
  // arrives with no `warm` param (depth 0); it warms its child PLAYLISTS at
  // depth 1, then stops. We deliberately warm ONLY the manifest tree (master →
  // variant playlists — small text files, a few KB each) and NOT the segments:
  // a segment is a multi-MB binary, and an earlier 2-level version that warmed
  // the opening segments re-downloaded ~12 × multi-MB in parallel, starving the
  // Worker's I/O budget and turning a 0.5 s cold segment into a 25-78 s stall on
  // less-popular titles. Warming just the playlists kills the manifest-resolution
  // spike (the part that visibly delayed Play/seek) at near-zero cost; the deep
  // hls.js buffer covers the segments themselves.
  const warmDepth = Math.max(0, parseInt(reqUrl.searchParams.get("warm") || "0", 10) || 0);
  const WARM_MAX_DEPTH = 1;

  if (!url) {
    return new Response(JSON.stringify({ error: "Missing url parameter" }), {
      status: 400,
      headers: corsHeaders({ "Content-Type": "application/json" }),
    });
  }

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(url);
  } catch {
    targetUrl = url;
  }

  let targetOrigin;
  try {
    targetOrigin = new URL(targetUrl).origin;
  } catch {
    return new Response(JSON.stringify({ error: "Bad target URL" }), {
      status: 400,
      headers: corsHeaders({ "Content-Type": "application/json" }),
    });
  }

  const auto = detectReferer(targetUrl);
  const finalReferer = referer
    ? decodeURIComponent(referer)
    : auto.referer || targetOrigin + "/";
  const finalOrigin = auto.origin || targetOrigin;

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Referer: finalReferer,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Sec-Fetch-Dest": "video",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "cross-site",
  };
  // Origin is only set when actually needed (some CDNs reject when it's
  // present for same-origin asset fetches — sibnet's video pipeline being
  // the canonical case where Origin: video.sibnet.ru caused a 400).
  if (
    finalOrigin &&
    !targetUrl.includes("sibnet.ru") &&
    !targetUrl.includes("acek-cdn.com")
  ) {
    headers.Origin = finalOrigin;
  }
  const rangeHeader = request.headers.get("range");
  if (rangeHeader) headers.Range = rangeHeader;
  if (vcookie) {
    try {
      headers.Cookie = decodeURIComponent(vcookie);
    } catch {
      headers.Cookie = vcookie;
    }
  }

  // CF edge cache lookup — the same URL across viewers hits this and skips
  // the upstream fetch entirely. Critical for the proxy-routed hosts: most
  // segments after the first viewer are free.
  const cache = caches.default;
  // Normalise the cache key by stripping vcookie (per-user) and download
  // params — the upstream bytes are identical, only the wrapper differs.
  // `warm` is stripped too so a pre-warm subrequest stores under the SAME key
  // the player's plain request later looks up (otherwise the warm would be a
  // wasted miss).
  const cacheKeyUrl = new URL(reqUrl);
  cacheKeyUrl.searchParams.delete("vcookie");
  cacheKeyUrl.searchParams.delete("dl");
  cacheKeyUrl.searchParams.delete("filename");
  cacheKeyUrl.searchParams.delete("warm");
  const cacheKey = new Request(cacheKeyUrl.toString(), { method: "GET" });
  // Only use cache for GET. (HEAD doesn't have a body to cache.)
  if (request.method === "GET" && !isDownload) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  let response;
  // Manual redirect handling.
  //
  // Cloudflare's `fetch(..., { redirect: "follow" })` does NOT carry our
  // explicit headers across the redirect — it issues a fresh request without
  // Referer/Origin, which some CDNs (sibnet's dv97/cvnXX hop chain is the
  // canonical case) reject with 400. We follow manually so every hop keeps
  // the same User-Agent + Referer the original request had, AND so any
  // Set-Cookie a hop hands out is replayed on the next hop.
  let currentUrl = targetUrl;
  let currentHeaders = { ...headers };
  const MAX_REDIRECTS = 5;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    response = await serializedFetch(currentUrl, {
      headers: currentHeaders,
      redirect: "manual",
    });
    // Single retry on 403 (cold CDN hit) — applies only to the FINAL hop.
    if (response.status === 403 && i === 0) {
      await new Promise((r) => setTimeout(r, 300));
      response = await serializedFetch(currentUrl, {
        headers: currentHeaders,
        redirect: "manual",
      });
    }
    // Not a redirect → done. 3xx without Location is also "done" (treated
    // as terminal so we don't loop forever on a broken upstream).
    const status = response.status;
    const isRedirect = status >= 300 && status < 400 && status !== 304;
    const location = isRedirect ? response.headers.get("location") : null;
    if (!isRedirect || !location) break;
    // Resolve protocol-relative + relative URLs against the current URL.
    let next;
    try {
      next = new URL(location, currentUrl).toString();
    } catch {
      break;
    }
    // Carry any Set-Cookie the hop issued into the next hop's Cookie header.
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      // Keep only the `key=value` pair from each Set-Cookie (strip path /
      // expires / domain attributes).
      const pairs = setCookie
        .split(/,\s*(?=[^;]+=)/)
        .map((c) => c.split(";")[0].trim())
        .filter(Boolean)
        .join("; ");
      currentHeaders = {
        ...currentHeaders,
        Cookie: currentHeaders.Cookie
          ? `${currentHeaders.Cookie}; ${pairs}`
          : pairs,
      };
    }
    currentUrl = next;
  }

  // Helper that stores the final response under the normalised cache key
  // before returning it. Skip caching for downloads (Content-Disposition
  // varies per filename) and for error / partial responses (don't pin a
  // 4xx upstream blip in cache for 24h).
  const respondAndCache = (res) => {
    const okToCache =
      !isDownload &&
      request.method === "GET" &&
      (res.status === 200 || res.status === 206);
    if (okToCache && ctx) {
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }
    return res;
  };

  if (!response.ok && response.status !== 206) {
    const fatal = [401, 403, 404, 410].includes(response.status)
      ? 410
      : response.status;
    return new Response(
      JSON.stringify({ error: "Upstream error", upstream: response.status }),
      {
        status: fatal,
        headers: corsHeaders({ "Content-Type": "application/json" }),
      },
    );
  }

  const contentType = response.headers.get("content-type") || "";
  const isM3u8 =
    contentType.includes("mpegurl") ||
    contentType.includes("m3u") ||
    targetUrl.includes(".m3u8");

  // Build the proxy URL the manifest will reference for nested resources. We
  // use the SAME origin the client hit so manifest rewrites stay relative to
  // the deployment that served them — works whether you're on the Worker, a
  // preview deploy, or the Vercel fallback.
  const proxyBase = `${reqUrl.origin}${reqUrl.pathname}`;

  if (isM3u8) {
    let body = await response.text();
    const trimmed = body.trim();
    if (trimmed.startsWith("<!") || trimmed.startsWith("<html")) {
      return new Response(
        JSON.stringify({ error: "Got HTML instead of m3u8 stream" }),
        {
          status: 502,
          headers: corsHeaders({ "Content-Type": "application/json" }),
        },
      );
    }

    // Propagate the referer + vcookie to nested requests so segments / keys
    // authenticate the same way the manifest did. In download mode we use
    // the same params (segments and keys still go through this Worker), the
    // only difference is the manifest gets sent as a downloadable file.
    const effectiveReferer = referer ? decodeURIComponent(referer) : auto.referer;
    const refParam = effectiveReferer
      ? `&referer=${encodeURIComponent(effectiveReferer)}`
      : "";
    const cookieParam = vcookie ? `&vcookie=${encodeURIComponent(decodeURIComponent(vcookie))}` : "";

    const toAbsolute = (u) => {
      if (u.startsWith("http")) return u;
      try {
        return new URL(u, targetUrl).toString();
      } catch {
        return u;
      }
    };
    const rewrite = (abs) =>
      `${proxyBase}?url=${encodeURIComponent(abs)}${refParam}${cookieParam}`;

    // Collect the first few resource URLs (in playlist order) as we rewrite, so
    // we can pre-warm them into the edge cache below. For a MASTER playlist these
    // are the variant sub-playlists; for a MEDIA playlist they're the opening
    // .ts/.m4s segments — both are exactly what the player fetches next, and both
    // are where the mewstream/lumiflow CDN's cold-hit latency spikes (measured up
    // to ~5 s on a cache miss). Warming them now, while the manifest is still in
    // flight to the player, means the player's request lands on a HIT instead of
    // paying that spike on the user's first Play / seek.
    const resourceUrls = [];
    body = body.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${rewrite(toAbsolute(uri))}"`);
    body = body.replace(/^(?!#)(.+)$/gm, (line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return line;
      const abs = toAbsolute(t);
      resourceUrls.push(abs);
      return rewrite(abs);
    });

    // Pre-warm the first N resources through this same Worker URL so they get
    // stored under the normal cache key (respondAndCache path) — the player's
    // subsequent request then matches the edge cache. Fire-and-forget via
    // waitUntil so it never delays the manifest response. Cap at 3 to keep the
    // warm-up cheap (one extra subrequest budget item each) and avoid hammering
    // the CDN; the deep hls.js buffer covers everything past the opening few.
    if (ctx && warmDepth < WARM_MAX_DEPTH && resourceUrls.length > 0) {
      const childDepth = warmDepth + 1;
      // Only warm child PLAYLISTS, never segments — keep the warm to small text
      // fetches so it can't compete for I/O with the player's real segment
      // requests. A master playlist's children are variant .m3u8s; a media
      // playlist's children are .ts/.m4s segments (skipped). Cap at 4 variants.
      const playlists = resourceUrls
        .filter((u) => /\.m3u8(\?|$)/i.test(u))
        .slice(0, 4);
      if (playlists.length > 0) {
        const warm = async () => {
          // Sequential, not parallel: a warm fetch must never burst alongside
          // the player's foreground requests. Carry warm=<childDepth> so the
          // cache key (which strips `warm`) matches the player's plain lookup.
          for (const abs of playlists) {
            await fetch(`${rewrite(abs)}&warm=${childDepth}`).catch(() => {});
          }
        };
        ctx.waitUntil(warm());
      }
    }

    // Download mode → emit as attachment so the browser saves the .m3u8
    // playlist. VLC / mpv / yt-dlp / ffmpeg can open it directly and fetch
    // segments straight from the Worker — bytes never touch Vercel.
    if (isDownload) {
      const name = (downloadFilename || "episode.m3u8")
        .replace(/[^\w.-]/g, "_")
        .replace(/\.(ts|mp4)$/i, ".m3u8");
      return new Response(body, {
        status: 200,
        headers: corsHeaders({
          "Content-Type": "application/vnd.apple.mpegurl",
          "Content-Disposition": `attachment; filename="${name}"`,
          // Don't cache downloads — the file points at signed segment
          // URLs whose tokens rotate; serving stale would deliver a
          // playlist with expired links.
          "Cache-Control": "private, no-store",
        }),
      });
    }

    return respondAndCache(
      new Response(body, {
        status: 200,
        headers: corsHeaders({
          "Content-Type": "application/vnd.apple.mpegurl",
          // m3u8 manifests can rotate tokens — short edge cache only.
          "Cache-Control": "public, s-maxage=30, max-age=0",
        }),
      }),
    );
  }

  // Pick a cache policy by content type:
  //   - Binary (.ts / mp4 / keys): 24 h immutable. Token in URL is the cache
  //     key, so a rotation misses cache automatically. This is the bandwidth
  //     win.
  //   - HTML / JS / JSON (anime-sama catalog pages, embed shells, episodes.js,
  //     extractor responses): cap at 60 s. These pages embed short-lived
  //     tokens — caching them for 24 h would re-serve a dead token long after
  //     it expired upstream.
  const isTextContent =
    contentType.includes("text/html") ||
    contentType.includes("application/xhtml") ||
    contentType.includes("application/javascript") ||
    contentType.includes("text/javascript") ||
    contentType.includes("application/json") ||
    contentType.includes("text/plain");
  const cacheControl = isTextContent
    ? "public, s-maxage=60, max-age=0"
    : "public, s-maxage=86400, max-age=3600, immutable";
  const passthroughHeaders = corsHeaders({
    "Content-Type": contentType || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl,
  });
  const upstreamRange = response.headers.get("content-range");
  const upstreamLength = response.headers.get("content-length");
  if (upstreamRange) passthroughHeaders["Content-Range"] = upstreamRange;
  if (upstreamLength) passthroughHeaders["Content-Length"] = upstreamLength;

  // Download mode for direct binary files (MP4 sources, single .ts blobs):
  // add Content-Disposition so the browser saves instead of inlining.
  // Cache stays public — the file's URL token is its cache key, so a fresh
  // download with the same token hits the edge, and a token rotation
  // automatically misses (just like normal segment serving).
  if (isDownload) {
    const ext = (contentType.includes("mp4") ? "mp4" : "ts");
    const fallbackName = downloadFilename || `episode.${ext}`;
    const safe = fallbackName.replace(/[^\w.-]/g, "_");
    passthroughHeaders["Content-Disposition"] = `attachment; filename="${safe}"`;
  }

  return respondAndCache(
    new Response(response.body, {
      status: response.status,
      headers: passthroughHeaders,
    }),
  );
}

export default {
  async fetch(request, env, ctx) {
    try {
      // Offloaded-from-Vercel endpoints (/w/health, /w/broadcast, /w/track) are
      // routed first; everything else is the HLS/scrape proxy.
      const edge = await handleEdgeEndpoint(request, env, ctx);
      if (edge) return edge;
      return await handle(request, env, ctx);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Proxy failed", detail: String(err) }),
        {
          status: 500,
          headers: corsHeaders({ "Content-Type": "application/json" }),
        },
      );
    }
  },
};
