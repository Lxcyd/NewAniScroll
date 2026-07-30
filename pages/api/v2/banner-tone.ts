import type { NextApiRequest, NextApiResponse } from "next";
import sharp from "sharp";

/**
 * GET /api/v2/banner-tone?u=<image url>
 *
 * Returns { l: number } — the mean WCAG relative luminance of the top of that
 * image, i.e. the strip the navbar floats over. The caller decides what to do
 * with it (see lib/color/navContrast.ts, which flips the navbar to dark chrome
 * past its threshold).
 *
 * WHY THIS IS A SERVER ROUTE. Reading the pixels in the browser is free — a
 * canvas over the <img> that is already on screen — but the canvas is tainted
 * unless the image was loaded in CORS mode, and AniList's CDN cannot be relied
 * on for that: Cloudflare ignores `Vary: origin` when caching, so whether a
 * request gets `Access-Control-Allow-Origin` back depends on whether that edge
 * PoP happens to hold an Origin-tagged copy. curl sees the header; the browser
 * gets ERR_FAILED because a plain (no-Origin) load populated the cache first —
 * which is exactly what happened on every banner on dev.aniscroll.com.
 *
 * Server-side none of that applies, and the answer is a few bytes that the CDN
 * can hold forever (a banner's pixels never change), so this costs one
 * invocation per banner in existence, not one per page view.
 */

/** Only AniList's media CDN — this endpoint fetches whatever URL it is given,
 *  so it must not become an open proxy / SSRF hop. */
const ALLOWED_HOST = "s4.anilist.co";

/**
 * Share of the image height we judge.
 *
 * The navbar covers the top ~72px of the banner box (360px tall on desktop,
 * 260 on mobile). `object-fit: cover` maps that to different source rows
 * depending on the viewport width, but for the 1900×400-ish files AniList
 * serves it always lands inside the top quarter: rows 0-80 at 1280px wide,
 * 14-86 at 1900px, 47-100 at 2560px. So the top 25% is a good stand-in for a
 * crop the server cannot compute (it doesn't know the viewport), and one that
 * keeps the answer cacheable for every visitor.
 */
const STRIP_FRACTION = 0.25;

const FETCH_TIMEOUT_MS = 6000;
const MAX_BYTES = 8 * 1024 * 1024;

function srgbToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const raw = Array.isArray(req.query.u) ? req.query.u[0] : req.query.u;
  if (!raw) return res.status(400).json({ error: "missing u" });

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return res.status(400).json({ error: "bad url" });
  }
  if (url.protocol !== "https:" || url.hostname !== ALLOWED_HOST) {
    return res.status(400).json({ error: "host not allowed" });
  }

  try {
    const upstream = await fetch(url.toString(), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!upstream.ok) {
      return res.status(502).json({ error: `upstream ${upstream.status}` });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) {
      return res.status(413).json({ error: "too large" });
    }

    const image = sharp(buf);
    const { width, height } = await image.metadata();
    if (!width || !height) {
      return res.status(422).json({ error: "undecodable" });
    }

    // 32×6 is plenty: we want the average tone of a strip, not detail. sharp
    // area-averages on the way down, so every source pixel is counted.
    const { data } = await image
      .extract({
        left: 0,
        top: 0,
        width,
        height: Math.max(1, Math.round(height * STRIP_FRACTION)),
      })
      .resize(32, 6, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let sum = 0;
    for (let i = 0; i < data.length; i += 3) {
      sum +=
        0.2126 * srgbToLinear(data[i]) +
        0.7152 * srgbToLinear(data[i + 1]) +
        0.0722 * srgbToLinear(data[i + 2]);
    }
    const l = sum / (data.length / 3);

    // Immutable by nature: the bytes behind an AniList image URL never change
    // (a new artwork gets a new filename). Long s-maxage = the CDN answers
    // every visitor and this function runs once per banner, ever.
    res.setHeader(
      "Cache-Control",
      "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800"
    );
    return res.status(200).json({ l });
  } catch (e: any) {
    // Never fail loudly: the caller treats an error as "keep the default
    // chrome", which is the correct look for the overwhelming majority of
    // banners anyway.
    return res.status(502).json({ error: e?.message || "probe failed" });
  }
}
