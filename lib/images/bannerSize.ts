/**
 * Is this AniList banner too small for a full-bleed hero?
 *
 * The info page keeps AniList's banner (user decision, 2026-08-08 — TMDB
 * backdrops are scoped to the home page). The exceptions the user asked for
 * are "banner absent OR genuinely pixelated". Absence is free to detect. This
 * module handles the other half, and it does it by MEASURING rather than
 * guessing, because an AniList banner URL carries no dimensions.
 *
 * HOW, without paying for the image. A JPEG's size lives in its SOF marker,
 * within the first few kilobytes; a PNG's is in the IHDR chunk at byte 16. So
 * a `Range: bytes=0-65535` request is enough to read the real pixel
 * dimensions, and it downloads ~64 kB at worst instead of the whole banner
 * (AniList's are 100-400 kB). The verdict is then cached for 30 days keyed on
 * the URL, so a title costs this once.
 *
 * WHERE THE THRESHOLDS COME FROM — measured 2026-08-08 over the 50 most
 * popular titles (49 had a banner):
 *
 *     1900 px wide … 42 titles      the platform standard, by a wide margin
 *     1800 …………………  1
 *     1721 …………………  2
 *     1720 …………………  1
 *     1600 …………………  2            e.g. Code Geass 1600×465
 *     1500 …………………  1            Kimetsu no Yaiba: Mugen Ressha-hen, 1500×315
 *
 * A second sample over 50 LOW-popularity titles found that only ONE of them
 * had a banner at all — which is the real shape of this problem: obscure
 * titles have no banner (handled by the absence branch), and titles that do
 * have one are almost always 1900 wide.
 *
 * So the bar is set just under the cluster: anything below 1700 px wide, or
 * shorter than 350 px, is meaningfully below what the hero renders at on a
 * normal desktop viewport and will visibly upscale. That flags the 1500 and
 * 1600 cases and leaves the 1720/1721 group — which is within 10% of standard
 * — alone.
 *
 * FAILURE POLICY: anything we cannot measure is treated as FINE. A network
 * blip, a redirect, an unexpected format must never demote a banner that is
 * probably perfect — the cost of a false positive (replacing the show's chosen
 * art) is higher than the cost of a false negative (a slightly soft banner).
 */

import { getCachedJson, setCachedJson } from "@/lib/db/tmdbImagesCache";

const MIN_WIDTH = 1700;
const MIN_HEIGHT = 350;

const TTL_S = 30 * 24 * 60 * 60;
const TIMEOUT_MS = 3000;
/* 64 kB covers the JPEG header comfortably. AniList banners carry an ICC
   profile and sometimes EXIF ahead of the SOF marker, so a 2 kB range would
   miss it on a minority of files. */
const RANGE = "bytes=0-65535";

/** Process-level memo — the homepage and info page re-ask for the same few
 *  banners within a render, and this saves the Turso round-trip. */
const memo = new Map<string, boolean>();

interface Probe {
  width: number;
  height: number;
}

/** Read a JPEG's dimensions from its SOF marker. Null if not a JPEG or the
 *  marker isn't within the bytes we fetched. */
function jpegSize(buf: Buffer): Probe | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    /* SOF0-SOF15 carry the frame header. c4 (DHT), c8 (JPG) and cc (DAC) fall
       in the same numeric range but are not frame headers — reading sizes off
       them yields garbage. */
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    const segLen = buf.readUInt16BE(i + 2);
    if (segLen < 2) return null; // malformed — bail rather than loop forever
    i += 2 + segLen;
  }
  return null;
}

/** Read a PNG's dimensions from IHDR. */
function pngSize(buf: Buffer): Probe | null {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function probe(url: string): Promise<Probe | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Range: RANGE },
    });
    // 206 is the range hit; 200 means the CDN ignored Range and sent it all,
    // which still parses.
    if (!res.ok && res.status !== 206) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return jpegSize(buf) ?? pngSize(buf);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True only when the banner was successfully measured AND is below the bar.
 * Unmeasurable → false, deliberately (see the header's failure policy).
 */
export async function isBannerLowRes(
  url: string | null | undefined,
): Promise<boolean> {
  if (!url) return false;

  const hit = memo.get(url);
  if (hit !== undefined) return hit;

  const key = `bannerSize:v1:${url}`;
  const cached = await getCachedJson<{ low: boolean }>(key, TTL_S);
  if (cached) {
    memo.set(url, cached.low);
    return cached.low;
  }

  const size = await probe(url);
  const low = size ? size.width < MIN_WIDTH || size.height < MIN_HEIGHT : false;

  // Cache the measurement either way — including "we couldn't measure it", so
  // a banner served by a flaky host isn't re-probed on every render.
  await setCachedJson(key, { low, ...(size ?? {}) });
  memo.set(url, low);
  if (low && size) {
    console.warn(
      `[banner] low-res ${size.width}x${size.height} → TMDB backdrop: ${url}`,
    );
  }
  return low;
}
