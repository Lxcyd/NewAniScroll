/**
 * GET /api/v2/proxy/m3u8?url=<encoded_url>&referer=<optional_referer>
 *
 * Server-side proxy for HLS m3u8 playlists, .ts segments, MP4 files, etc.
 * Streams binary content directly to avoid buffering huge files in memory
 * (a 100MB sibnet MP4 buffered in RAM × parallel requests = OOM crash).
 */

import { Readable } from "stream";

export default async function handler(req, res) {
  const { url, referer } = req.query;
  if (!url) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  try {
    const targetUrl = decodeURIComponent(url);
    const targetOrigin = new URL(targetUrl).origin;

    // Determine the correct Referer for CDN auth
    let cdnReferer = null;
    let cdnOrigin = null;

    // Kwik / uwucdn / owocdn / nextcdn — all AnimePahe CDNs need kwik referer
    if (
      targetUrl.includes("kwik.") ||
      targetUrl.includes("uwucdn.") ||
      targetUrl.includes("owocdn.") ||
      targetUrl.includes("nextcdn.") ||
      targetUrl.includes("files.nextcdn.")
    ) {
      cdnReferer = "https://kwik.cx/";
      cdnOrigin = "https://kwik.cx";
    }
    // AnimePahe direct
    else if (targetUrl.includes("animepahe.")) {
      cdnReferer = "https://animepahe.ru/";
    }
    // Megaup and its rotating CDN domains (Animekai/Zoro)
    else if (
      targetUrl.includes("megaup.") ||
      targetUrl.includes("stormshade") ||
      targetUrl.includes("mgstatics.") ||
      /rrr\.[a-z0-9]+\.(site|com|xyz)/.test(targetUrl) ||
      /[a-z]+\d+\.(xyz|live|site)/.test(new URL(targetUrl).hostname)
    ) {
      cdnReferer = "https://megaup.cc/";
      cdnOrigin = "https://megaup.cc";
    }
    // Sibnet (video.sibnet.ru and its CDN)
    else if (targetUrl.includes("sibnet.ru")) {
      cdnReferer = "https://video.sibnet.ru/";
      cdnOrigin = "https://video.sibnet.ru";
    }
    // Sendvid CDN
    else if (targetUrl.includes("sendvid.com") || targetUrl.includes("sendvid.")) {
      cdnReferer = "https://sendvid.com/";
      cdnOrigin = "https://sendvid.com";
    }
    // Vidmoly CDN — needs Referer = vidmoly.net for token validation
    else if (targetUrl.includes("vmwesa.") || targetUrl.includes("vidmoly.")) {
      cdnReferer = "https://vidmoly.net/";
      cdnOrigin = "https://vidmoly.net";
    }

    // Priority: explicit referer param > CDN auto-detect > target origin
    const finalReferer = referer
      ? decodeURIComponent(referer)
      : cdnReferer || targetOrigin + "/";
    const finalOrigin = cdnOrigin || targetOrigin;

    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Referer: finalReferer,
      Origin: finalOrigin,
      Accept: "*/*",
    };
    // Forward Range header for MP4 streaming/seeking
    if (req.headers.range) headers.Range = req.headers.range;

    // Abort the upstream fetch if the client disconnects.
    const ctrl = new AbortController();
    req.on("close", () => ctrl.abort());

    // Fetch with one retry on 403 (some CDNs need a warm-up request)
    let response = await fetch(targetUrl, { headers, signal: ctrl.signal });
    if (response.status === 403) {
      await new Promise((r) => setTimeout(r, 300));
      response = await fetch(targetUrl, { headers, signal: ctrl.signal });
    }

    // Allow 200 and 206 (partial content for ranged requests)
    if (!response.ok && response.status !== 206) {
      return res.status(response.status).json({ error: "Upstream error" });
    }

    const contentType = response.headers.get("content-type") || "";
    const isM3u8 =
      contentType.includes("mpegurl") ||
      contentType.includes("m3u") ||
      targetUrl.includes(".m3u8");

    if (isM3u8) {
      let body = await response.text();

      // If we got HTML instead of m3u8, it's an embed page — not a stream
      if (body.trim().startsWith("<!") || body.trim().startsWith("<html")) {
        return res
          .status(502)
          .json({ error: "Got HTML instead of m3u8 stream" });
      }

      // Rewrite URLs in the playlist to go through this proxy
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
      // Propagate the referer (explicit or auto-detected) to segment requests
      const effectiveReferer = referer ? decodeURIComponent(referer) : cdnReferer;
      const refParam = effectiveReferer
        ? `&referer=${encodeURIComponent(effectiveReferer)}`
        : "";

      // Helper to resolve a URL to absolute
      const toAbsolute = (u) => {
        if (u.startsWith("http")) return u;
        if (u.startsWith("/")) return targetOrigin + u;
        return baseUrl + u;
      };

      // Rewrite #EXT-X-KEY URI="..." and similar tags (encryption keys, maps)
      body = body.replace(/URI="([^"]+)"/g, (match, uri) => {
        const abs = toAbsolute(uri);
        return `URI="/api/v2/proxy/m3u8?url=${encodeURIComponent(abs)}${refParam}"`;
      });

      // Rewrite segment/playlist URLs (non-# lines)
      body = body.replace(/^(?!#)(.+)$/gm, (line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line;
        return `/api/v2/proxy/m3u8?url=${encodeURIComponent(toAbsolute(trimmed))}${refParam}`;
      });

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(200).send(body);
    }

    // Binary content (ts segments, MP4, keys, subtitles, etc.)
    // STREAM the response directly — never buffer; large MP4s would OOM the server.
    res.setHeader("Content-Type", contentType || "application/octet-stream");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Accept-Ranges", "bytes");
    const contentRange = response.headers.get("content-range");
    const contentLength = response.headers.get("content-length");
    if (contentRange) res.setHeader("Content-Range", contentRange);
    if (contentLength) res.setHeader("Content-Length", contentLength);

    res.status(response.status);

    if (!response.body) {
      return res.end();
    }

    // Convert WHATWG ReadableStream → Node Readable, pipe to response.
    const nodeStream = Readable.fromWeb(response.body);
    // If the client disconnects, kill the upstream fetch immediately.
    req.on("close", () => nodeStream.destroy());
    nodeStream.on("error", (err) => {
      console.error("Proxy stream error:", err.message);
      if (!res.writableEnded) res.end();
    });
    nodeStream.pipe(res);
  } catch (error) {
    console.error("Proxy error:", error.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: "Proxy failed" });
    }
    if (!res.writableEnded) res.end();
  }
}

export const config = {
  api: {
    responseLimit: false,
    // Disable bodyParser; we're proxying binary streams.
    bodyParser: false,
    // Allow long-lived streaming connections (default 5min is fine for now)
    externalResolver: true,
  },
};
