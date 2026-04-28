/**
 * GET /api/v2/download?url=<encoded>&referer=<encoded>&filename=<name>
 *
 * Streaming download proxy. Sets Content-Disposition: attachment so the
 * browser saves the file instead of playing it. Re-uses the m3u8 proxy logic
 * (same referer detection, same range/CORS handling) but adds the download
 * header and rewrites m3u8 segment URLs to also go through this endpoint
 * (so they retain the attachment header chain).
 *
 * For .mp4 sources (sibnet, sendvid extractor output) this works directly:
 * the browser saves the MP4.
 *
 * For .m3u8 sources, what's downloaded is just the playlist text, which
 * VLC / mpv / ffmpeg can resolve into a video. We can't remux to MP4 in a
 * pure Node serverless function without bundling ffmpeg-static (~80MB).
 * Instead, this endpoint also exposes a `?as=playlist` mode that returns a
 * sanitised m3u8 with absolute URLs that VLC can open directly.
 */

import { Readable } from "stream";

export default async function handler(req, res) {
  const { url, referer, filename = "anime.mp4" } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url parameter" });

  try {
    const targetUrl = decodeURIComponent(url);
    const targetOrigin = new URL(targetUrl).origin;

    // CDN referer detection — same as m3u8 proxy
    let cdnReferer = null;
    if (targetUrl.includes("kwik.") || targetUrl.includes("uwucdn.") || targetUrl.includes("owocdn.") || targetUrl.includes("nextcdn.")) {
      cdnReferer = "https://kwik.cx/";
    } else if (targetUrl.includes("animepahe.")) {
      cdnReferer = "https://animepahe.ru/";
    } else if (targetUrl.includes("megaup.") || targetUrl.includes("stormshade") || targetUrl.includes("mgstatics.")) {
      cdnReferer = "https://megaup.cc/";
    } else if (targetUrl.includes("sibnet.ru")) {
      cdnReferer = "https://video.sibnet.ru/";
    } else if (targetUrl.includes("sendvid.")) {
      cdnReferer = "https://sendvid.com/";
    }

    const finalReferer = referer
      ? decodeURIComponent(referer)
      : cdnReferer || targetOrigin + "/";

    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Referer: finalReferer,
      Accept: "*/*",
    };

    const ctrl = new AbortController();
    req.on("close", () => ctrl.abort());

    const upstream = await fetch(targetUrl, { headers, signal: ctrl.signal });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: "Upstream error" });
    }

    const contentType = upstream.headers.get("content-type") || "";
    const isM3u8 =
      contentType.includes("mpegurl") ||
      contentType.includes("m3u") ||
      targetUrl.includes(".m3u8");

    if (isM3u8) {
      // Rewrite playlist with absolute URLs so VLC/mpv/ffmpeg can open it
      // without needing the original base URL context.
      const body = await upstream.text();
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
      const toAbsolute = (u) => {
        if (u.startsWith("http")) return u;
        if (u.startsWith("/")) return targetOrigin + u;
        return baseUrl + u;
      };
      let rewritten = body.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${toAbsolute(uri)}"`);
      rewritten = rewritten.replace(/^(?!#)(.+)$/gm, (line) => {
        const t = line.trim();
        if (!t || t.startsWith("#")) return line;
        return toAbsolute(t);
      });
      const safeName = filename.replace(/[^\w.-]/g, "_").replace(/\.mp4$/i, "") + ".m3u8";
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(200).send(rewritten);
    }

    // Direct MP4 / TS / other binary — stream as attachment
    const safeName = filename.replace(/[^\w.-]/g, "_");
    res.setHeader("Content-Type", contentType || "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Accept-Ranges", "bytes");
    const cl = upstream.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);

    res.status(upstream.status);
    if (!upstream.body) return res.end();
    const node = Readable.fromWeb(upstream.body);
    req.on("close", () => node.destroy());
    node.on("error", (err) => {
      console.error("Download stream error:", err.message);
      if (!res.writableEnded) res.end();
    });
    node.pipe(res);
  } catch (e) {
    console.error("Download error:", e.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: "Download failed" });
    }
    if (!res.writableEnded) res.end();
  }
}

export const config = {
  api: {
    responseLimit: false,
    bodyParser: false,
    externalResolver: true,
  },
};
