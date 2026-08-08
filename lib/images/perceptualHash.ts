/**
 * Perceptual hashing, for spotting the SAME artwork served by two providers.
 *
 * The Artworks gallery merges fanart.tv and TMDB, and both host the official
 * key art of a show. Measured on BLACK TORCH (AniList 187538): TMDB has only 4
 * posters, yet the gallery rendered the same poster twice — so the duplicate
 * was necessarily one fanart.tv copy and one TMDB copy. No identifier links
 * them: different hosts, different paths, and different pixel dimensions
 * (fanart.tv posters are typically 1000×1426, TMDB's 2000×3000), which is why
 * URL equality and dimension equality both fail here. The only thing the two
 * files share is what they look like.
 *
 * dHash rather than aHash: it compares each pixel to its right-hand neighbour
 * instead of to the image mean, so it keys on gradient structure and shrugs off
 * the global brightness and compression differences you get between two
 * re-encodings of one artwork. 64 bits, as 16 hex chars.
 *
 * COST, and why it is bounded. Hashing means actually downloading the image, so
 * every caller must treat this as expensive: hash the smallest variant a
 * provider offers, cap how many images are hashed per title, and cache the
 * verdict — never hash on a request path that isn't already behind a long TTL.
 *
 * Fail-soft: a hash that can't be computed is null, and a null hash must be
 * treated as "not a duplicate". Dropping a real artwork because a fetch blipped
 * is far worse than showing one duplicate.
 */

import sharp from "sharp";

const FETCH_TIMEOUT_MS = 4000;

/** Hamming distance under which two dHashes are considered the same image.
 *
 *  5/64 bits. Two re-encodings of one artwork typically land within 2-3; genuinely
 *  different images of the same show — same characters, same palette, same
 *  studio — sit well above 10. The gap is wide, so the exact cut-off is not
 *  delicate, but it is deliberately on the CONSERVATIVE side: a false positive
 *  silently deletes artwork, a false negative merely leaves the duplicate the
 *  user already sees. */
export const DUPLICATE_THRESHOLD = 5;

/**
 * 64-bit dHash of an image buffer, as 16 hex chars. Null if sharp can't decode
 * it (SVG, corrupt file, HTML error page served as an image…).
 */
export async function dHash(buf: Buffer): Promise<string | null> {
  try {
    /* 9×8 greyscale: 8 comparisons per row × 8 rows = 64 bits. `raw()` skips
       re-encoding entirely — we only ever read the pixel bytes. */
    const px = await sharp(buf)
      .greyscale()
      .resize(9, 8, { fit: "fill" })
      .raw()
      .toBuffer();

    let bits = "";
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const i = row * 9 + col;
        bits += px[i] > px[i + 1] ? "1" : "0";
      }
    }

    let hex = "";
    for (let i = 0; i < 64; i += 4) {
      hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    return hex;
  } catch {
    return null;
  }
}

/** Download and hash. Null on any failure — see the header's fail-soft rule. */
export async function hashUrl(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return await dHash(buf);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Bits that differ between two hex dHashes. Returns 64 (maximally different)
 *  when either side is missing, so an unhashable image never matches anything. */
export function hammingHex(a: string | null, b: string | null): number {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/**
 * Hash many URLs with bounded concurrency and an overall time budget.
 *
 * Returns a Map of url → hash (missing entries mean "couldn't hash"). Stops
 * issuing new work once the budget is spent, so a slow provider degrades the
 * de-duplication instead of hanging the request — the caller then keeps the
 * images it couldn't compare, which is the safe direction.
 */
export async function hashMany(
  urls: string[],
  { concurrency = 8, budgetMs = 12_000 }: { concurrency?: number; budgetMs?: number } = {},
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const deadline = Date.now() + budgetMs;
  const queue = urls.slice();

  const worker = async () => {
    while (queue.length) {
      if (Date.now() > deadline) return;
      const url = queue.shift();
      if (!url) return;
      const h = await hashUrl(url);
      if (h) out.set(url, h);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, worker),
  );
  return out;
}
