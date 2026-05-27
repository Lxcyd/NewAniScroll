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
 */

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

async function handle(request) {
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
    Origin: finalOrigin,
    Accept: "*/*",
  };
  const rangeHeader = request.headers.get("range");
  if (rangeHeader) headers.Range = rangeHeader;
  if (vcookie) {
    try {
      headers.Cookie = decodeURIComponent(vcookie);
    } catch {
      headers.Cookie = vcookie;
    }
  }

  // Single retry on 403 — some CDNs reject the first cold hit.
  let response = await serializedFetch(targetUrl, {
    headers,
    redirect: "follow",
  });
  if (response.status === 403) {
    await new Promise((r) => setTimeout(r, 300));
    response = await serializedFetch(targetUrl, {
      headers,
      redirect: "follow",
    });
  }

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

    body = body.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${rewrite(toAbsolute(uri))}"`);
    body = body.replace(/^(?!#)(.+)$/gm, (line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return line;
      return rewrite(toAbsolute(t));
    });

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

    return new Response(body, {
      status: 200,
      headers: corsHeaders({
        "Content-Type": "application/vnd.apple.mpegurl",
        // m3u8 manifests can rotate tokens — short edge cache only.
        "Cache-Control": "public, s-maxage=30, max-age=0",
      }),
    });
  }

  // Binary content — keys, .ts segments, MP4. The huge bandwidth win lives
  // here: segments are content-addressed by their URL, never change, and
  // Cloudflare's edge can fan one origin hit out to thousands of viewers.
  // We deliberately strip the upstream Cache-Control (some CDNs ship
  // `no-store`) and substitute our own — the URL token is the cache key, so
  // when the token rotates a new request misses cache and re-fetches.
  const passthroughHeaders = corsHeaders({
    "Content-Type": contentType || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, s-maxage=86400, max-age=3600, immutable",
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

  return new Response(response.body, {
    status: response.status,
    headers: passthroughHeaders,
  });
}

export default {
  async fetch(request) {
    try {
      return await handle(request);
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
