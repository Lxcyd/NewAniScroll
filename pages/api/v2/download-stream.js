/**
 * GET /api/v2/download-stream?url=<m3u8_url>&filename=<name>&referer=<ref>
 *
 * Server-side concatenates all HLS segments into a single .ts download.
 *
 * Inspired by SertraFurr/Anime-Sama-Downloader's segment streaming approach.
 * The browser receives one continuous video/mp2t stream as a single file.
 */

import { Readable } from "stream";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0";

async function fetchSegment(url, referer, signal) {
  const headers = {
    "User-Agent": UA,
    Accept: "*/*",
  };
  if (referer) headers.Referer = referer;

  const r = await fetch(url, { headers, signal });
  if (!r.ok) throw new Error(`segment HTTP ${r.status}`);
  return r;
}

export default async function handler(req, res) {
  const { url, filename = "anime.ts", referer } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url parameter" });

  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());

  try {
    let masterUrl = decodeURIComponent(url);
    const refererStr = referer ? decodeURIComponent(referer) : null;

    // Step 1: fetch the master playlist
    let m3u8Res = await fetchSegment(masterUrl, refererStr, ctrl.signal);
    let m3u8Text = await m3u8Res.text();

    // If it's a master playlist (has EXT-X-STREAM-INF), pick the highest quality
    if (m3u8Text.includes("#EXT-X-STREAM-INF")) {
      const variants = [
        ...m3u8Text.matchAll(
          /#EXT-X-STREAM-INF:[^\n]*RESOLUTION=(\d+)x(\d+)[^\n]*\n([^\n]+)/g
        ),
      ];
      if (variants.length > 0) {
        variants.sort((a, b) => parseInt(b[2]) - parseInt(a[2]));
        const variantPath = variants[0][3].trim();
        const variantUrl = variantPath.startsWith("http")
          ? variantPath
          : new URL(variantPath, masterUrl).href;
        masterUrl = variantUrl;
        m3u8Res = await fetchSegment(variantUrl, refererStr, ctrl.signal);
        m3u8Text = await m3u8Res.text();
      }
    }

    // Step 2: extract segment URLs (resolve relative → absolute)
    const segments = m3u8Text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => (l.startsWith("http") ? l : new URL(l, masterUrl).href));

    if (segments.length === 0) {
      return res.status(404).json({ error: "No segments found in m3u8" });
    }

    // Step 3: stream segments one-by-one, concatenating into the response
    const safeName = filename.replace(/[^\w.-]/g, "_").replace(/\.m3u8$/i, "") +
      (filename.endsWith(".ts") ? "" : ".ts");
    res.setHeader("Content-Type", "video/mp2t");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200);

    let i = 0;
    for (const segUrl of segments) {
      if (ctrl.signal.aborted || res.writableEnded) break;
      try {
        const segRes = await fetchSegment(segUrl, refererStr, ctrl.signal);
        if (segRes.body) {
          const node = Readable.fromWeb(segRes.body);
          await new Promise((resolve, reject) => {
            node.on("end", resolve);
            node.on("error", reject);
            node.pipe(res, { end: false });
          });
        }
        i++;
        // Periodic progress log (server-side)
        if (i % 50 === 0) console.log(`[download-stream] ${i}/${segments.length} segments`);
      } catch (e) {
        if (ctrl.signal.aborted) break;
        console.warn(`[download-stream] segment ${i} failed:`, e.message);
        // Continue to next segment — don't fail the whole download
      }
    }

    if (!res.writableEnded) res.end();
  } catch (e) {
    console.error("download-stream error:", e.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: "Download failed: " + e.message });
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
