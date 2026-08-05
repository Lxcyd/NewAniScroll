// Client-side Vidmoly extractor.
//
// Why this exists: Vidmoly issues a per-IP master.m3u8 token. When the
// extraction runs server-side, that token is bound to the server IP — so
// playback HAS to go through a same-IP proxy (CF Worker / Fly anime-proxy /
// Vercel FOT). All three eat bandwidth budget. Pulling the embed page from
// the user's browser instead binds the token to the browser's IP, so the
// player can fetch master.m3u8 + segments directly from the vidmoly CDN with
// no intermediate.
//
// CORS: vidmoly.biz reflects any Origin in Access-Control-Allow-Origin, so
// fetch() from our origin succeeds. The CDN (vmwesa) is unverified — if it
// refuses CORS, hls.js will fail with `manifestLoadError` and the caller
// should fall back to the iframe.
//
// Returns { masterUrl } on success or { error } on failure.

// Trace logger — off by default. Set NEXT_PUBLIC_DEBUG_SOURCE=1 to surface
// the `[client-vidmoly] HIT …` lines in the browser console during debugging.
// Mirrors DEBUG_SOURCE on the server side (pages/api/v2/source).
const DEBUG = process.env.NEXT_PUBLIC_DEBUG_SOURCE === "1";
const dlog = DEBUG ? console.log.bind(console) : () => {};

// ansembed.net is the same Vidmoly backend on a white-label domain (see
// VIDMOLY_DOMAINS in lib/extractors.js). It matters twice here: an ansembed
// embed must be recognised at all, and its slug namespace is its OWN — an
// ansembed slug does not exist on vidmoly.biz. So we try the embed on the host
// it came from FIRST and only then walk the mirrors, instead of rewriting the
// domain blindly and 404-ing on a slug that was never there.
const VIDMOLY_DOMAINS = ["vidmoly.biz", "vidmoly.net", "vidmoly.to"];
const VIDMOLY_HOST_RE = /(vidmoly\.(?:to|biz|net)|ansembed\.net)/i;

function domainCandidates(embedUrl) {
  if (/ansembed\.net/i.test(embedUrl)) return ["ansembed.net"];
  return VIDMOLY_DOMAINS;
}

const M3U8_PATTERNS = [
  /file:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/,
  /sources:\s*\[\s*\{[^}]*file:\s*['"]([^'"]+)['"]/,
  /<source\s+src=['"]([^'"]+\.m3u8[^'"]*)['"]/,
  /['"](https?:\/\/[^'"\s]+\.m3u8[^'"\s]*)['"]/,
  /file:\s*['"]([^'"]+)['"]/,
];

function findMasterUrl(html) {
  for (const p of M3U8_PATTERNS) {
    const m = html.match(p);
    if (m && m[1] && m[1].startsWith("http")) return m[1];
  }
  return null;
}

async function fetchEmbed(url, signal) {
  // Browser fetch — we can't set User-Agent or Referer (forbidden headers
  // for cross-origin). Browser sends our own origin as Referer, which is
  // fine: vidmoly.biz reflects any Origin and doesn't appear to validate
  // Referer on the HTML embed page itself (the CDN token does the real
  // anti-leech). credentials:"omit" keeps third-party cookies out of the
  // request (we don't have any vidmoly cookies and sending them would
  // disable CORS reflection on some setups).
  const res = await fetch(url, {
    method: "GET",
    credentials: "omit",
    redirect: "follow",
    signal,
  });
  if (!res.ok) return { html: null, status: res.status };
  return { html: await res.text(), status: res.status };
}

export async function extractVidmolyClient(embedUrl, { signal } = {}) {
  const t0 = Date.now();
  for (const domain of domainCandidates(embedUrl)) {
    const url = embedUrl.replace(VIDMOLY_HOST_RE, domain);
    let html, status;
    try {
      ({ html, status } = await fetchEmbed(url, signal));
    } catch (e) {
      if (signal?.aborted) return { error: "aborted" };
      // CORS rejection surfaces as a TypeError in fetch — keep trying other
      // domains before giving up so we don't bail on a single hop.
      dlog(`[client-vidmoly] ${domain} fetch threw: ${e.message}`);
      continue;
    }
    if (!html) {
      dlog(`[client-vidmoly] ${domain} HTTP ${status}`);
      continue;
    }
    if (html.length < 500) {
      dlog(`[client-vidmoly] ${domain} body too short (${html.length}b)`);
      continue;
    }
    const masterUrl = findMasterUrl(html);
    if (masterUrl) {
      dlog(
        `[client-vidmoly] HIT ${domain} (${Date.now() - t0}ms) → ${masterUrl.slice(0, 90)}…`
      );
      return { masterUrl };
    }
    dlog(`[client-vidmoly] ${domain} no m3u8 in ${html.length}b body`);
  }
  return { error: "no source found on any vidmoly domain" };
}
