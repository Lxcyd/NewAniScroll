// Stream extractors — pull direct M3U8/MP4 URLs from embed pages.
// Adapted from zuhaz/consumet.ts (github.com/zuhaz/consumet.ts).
// Returning real stream URLs lets us play in our own HLS player and bypass
// X-Frame-Options blocks (sendvid), referer issues, and ad-laden embed pages.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Optional external anime-proxy (github.com/Vertixx01/anime-proxy). When set,
// requests to anti-bot hosts (Vidmoly) go through it instead of our server IP.
// The proxy pre-pends `/api?url=<target>&origin=<referer>` and returns the raw
// upstream body — this lets the proxy's IP pool (Vercel/Cloudflare/Railway)
// bypass per-IP bans that would block our dev server.
const ANIME_PROXY_URL = (process.env.ANIME_PROXY_URL || "").replace(/\/$/, "");

// Fetch wrapper that aborts after `ms` to avoid hung connections.
async function fetchWithTimeout(url, options = {}, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Route a fetch through anime-proxy when configured. Falls back to direct.
// The deployed anime-proxy exposes its proxy at the root path: /?url=...
async function fetchThroughProxy(url, options = {}, ms = 10000) {
  if (ANIME_PROXY_URL) {
    const refererHeader =
      (options.headers && options.headers.Referer) || "";
    const proxied =
      `${ANIME_PROXY_URL}/?url=${encodeURIComponent(url)}` +
      (refererHeader ? `&origin=${encodeURIComponent(refererHeader)}` : "");
    return fetchWithTimeout(proxied, { method: "GET" }, ms);
  }
  return fetchWithTimeout(url, options, ms);
}

/**
 * Extractor result shape:
 *   { streams: [{ url, quality, isM3U8, referer }], error?: string }
 * If extraction fails, returns { error: "..." } — caller should treat as broken.
 */

// ── Vidmoly (vidmoly.to / vidmoly.net / vidmoly.biz) ─────────
// Their anti-bot blocks plain server-side fetches on some IPs and routes
// .to → ads. We try multiple domain variants + a full browser header set
// mimicking what Cat-Catch / JDownloader send; if all fail, caller falls
// back to the raw iframe.
const VIDMOLY_DOMAINS = ["vidmoly.net", "vidmoly.to", "vidmoly.biz"];
const VIDMOLY_BROWSER_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Sec-Ch-Ua": '"Chromium";v="120", "Google Chrome";v="120"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "cross-site",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

async function tryVidmolyDomain(embedUrl, domain) {
  const url = embedUrl.replace(/vidmoly\.(to|biz|net)/, domain);
  const usingProxy = !!ANIME_PROXY_URL;
  console.log(`[vidmoly] fetch ${url}${usingProxy ? " via proxy" : " direct"}`);
  // Use proxy when configured — bypasses vidmoly's per-IP ban on our server.
  const res = await fetchThroughProxy(
    url,
    {
      headers: { ...VIDMOLY_BROWSER_HEADERS, Referer: "https://anime-sama.to/" },
      redirect: "follow",
    },
    10000
  );
  if (!res.ok) {
    console.log(`[vidmoly] ${domain} → HTTP ${res.status}`);
    return null;
  }
  const html = await res.text();
  console.log(`[vidmoly] ${domain} → ${html.length} bytes, contains m3u8=${html.includes(".m3u8")}`);
  // Guard: sometimes vidmoly returns a nearly-empty HTML shell as anti-bot
  if (html.length < 500) return null;

  // Vidmoly embeds use SINGLE quotes in the JWPlayer config:
  //   sources: [{ file: 'https://...master.m3u8?...' }]
  // so patterns must accept both ' and ".
  const patterns = [
    /file:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/,
    /sources:\s*\[\s*\{[^}]*file:\s*['"]([^'"]+)['"]/,
    /<source\s+src=['"]([^'"]+\.m3u8[^'"]*)['"]/,
    /['"](https?:\/\/[^'"\s]+\.m3u8[^'"\s]*)['"]/,
    /file:\s*['"]([^'"]+)['"]/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1] && m[1].startsWith("http")) {
      return { masterUrl: m[1], url };
    }
  }
  return null;
}

// Wrap an m3u8 URL through anime-proxy. The proxy rewrites segment URIs to
// also flow through itself, so segments are fetched from the same IP that
// originally got the token (avoiding IP-binding issues).
function wrapWithAnimeProxy(targetUrl, referer) {
  if (!ANIME_PROXY_URL) return null;
  return (
    `${ANIME_PROXY_URL}/?url=${encodeURIComponent(targetUrl)}` +
    (referer ? `&origin=${encodeURIComponent(referer)}` : "")
  );
}

export async function extractVidmoly(embedUrl) {
  try {
    // Try each domain variant — some are less aggressively blocked than others
    for (const domain of VIDMOLY_DOMAINS) {
      try {
        const hit = await tryVidmolyDomain(embedUrl, domain);
        if (hit) {
          // Pre-wrap through anime-proxy when configured: the resulting URL
          // already contains the rewriting we need, so the client should NOT
          // double-proxy it through our local /api/v2/proxy/m3u8.
          const wrapped = wrapWithAnimeProxy(hit.masterUrl, "https://vidmoly.net/");
          return {
            streams: [{
              url: wrapped || hit.masterUrl,
              quality: "auto",
              isM3U8: hit.masterUrl.includes(".m3u8"),
              referer: hit.url,
              directUrl: !!wrapped, // tells UniversalPlayer to skip local proxy
            }],
          };
        }
        // Hash-fallback: SertraFurr's trick — vidmoly's HTML sometimes hides
        // the source until a second request with `?g=<hash>` is sent.
        // Re-fetch first domain for hash extraction.
        const url = embedUrl.replace(/vidmoly\.(to|biz|net)/, domain);
        const res = await fetchThroughProxy(
          url,
          { headers: { ...VIDMOLY_BROWSER_HEADERS, Referer: "https://anime-sama.to/" }, redirect: "follow" },
          10000
        );
        if (!res.ok) continue;
        const html = await res.text();
        const hashMatch = html.match(/g=([a-f0-9]{32})/);
        if (hashMatch) {
          const hashUrl = `${url}?g=${hashMatch[1]}`;
          console.log(`[vidmoly] hash fallback: ${hashUrl}`);
          const r2 = await fetchThroughProxy(
            hashUrl,
            { headers: { ...VIDMOLY_BROWSER_HEADERS, Referer: url }, redirect: "follow" },
            10000
          );
          if (r2.ok) {
            const h2 = await r2.text();
            const m = h2.match(/file\s*:\s*['"](https?:\/\/[^'"]+)['"]/);
            if (m && m[1]) {
              const wrapped = wrapWithAnimeProxy(m[1], "https://vidmoly.net/");
              return {
                streams: [{
                  url: wrapped || m[1],
                  quality: "auto",
                  isM3U8: m[1].includes(".m3u8"),
                  referer: url,
                  directUrl: !!wrapped,
                }],
              };
            }
          }
        }
      } catch {
        // try next domain
      }
    }
    return { error: "vidmoly: no source found on any domain" };
  } catch (e) {
    return { error: `vidmoly: ${e.message}` };
  }
}

// ── Sibnet (video.sibnet.ru) ─────────────────────────────────
export async function extractSibnet(embedUrl) {
  try {
    const res = await fetchWithTimeout(embedUrl, {
      headers: {
        "User-Agent": UA,
        Referer: "https://video.sibnet.ru/",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!res.ok) return { error: `sibnet HTTP ${res.status}` };
    const html = await res.text();

    const m = html.match(/player\.src\(\[\{src:\s*"([^"]+)",\s*type:\s*"([^"]+)"/);
    if (!m) return { error: "sibnet: no source found" };

    const path = m[1];
    const fullUrl = path.startsWith("http") ? path : `https://video.sibnet.ru${path}`;

    return {
      streams: [{
        url: fullUrl,
        quality: "default",
        isM3U8: m[2].includes("m3u8") || fullUrl.includes(".m3u8"),
        referer: "https://video.sibnet.ru/",
      }],
    };
  } catch (e) {
    return { error: `sibnet: ${e.message}` };
  }
}

// ── Sendvid (sendvid.com) — bypasses X-Frame-Options ─────────
export async function extractSendvid(embedUrl) {
  try {
    const res = await fetchWithTimeout(embedUrl, {
      headers: {
        "User-Agent": UA,
        Referer: "https://sendvid.com/",
      },
    });
    if (res.status === 404) return { error: "sendvid: video removed" };
    if (!res.ok) return { error: `sendvid HTTP ${res.status}` };
    const html = await res.text();

    let videoUrl = null;
    const sourceMatch = html.match(/<source\s+src="([^"]+)"\s+type="video\/mp4"/);
    if (sourceMatch) videoUrl = sourceMatch[1];

    if (!videoUrl) {
      const varMatch = html.match(/var\s+video_source\s*=\s*"([^"]+)"/);
      if (varMatch) videoUrl = varMatch[1];
    }
    if (!videoUrl) {
      const ogMatch = html.match(/<meta\s+property="og:video"\s+content="([^"]+)"/);
      if (ogMatch) videoUrl = ogMatch[1];
    }
    if (!videoUrl) return { error: "sendvid: no source found" };

    return {
      streams: [{
        url: videoUrl,
        quality: "default",
        isM3U8: videoUrl.includes(".m3u8"),
        referer: "https://sendvid.com/",
      }],
    };
  } catch (e) {
    return { error: `sendvid: ${e.message}` };
  }
}

// ── Embed4Me (lpayer.embed4me.com) — AES-CBC decryption ──────
// Their player fetches /api/v1/video?id=<id>, server returns hex-encoded
// AES-CBC ciphertext with hardcoded key/IV. Decrypts to JSON containing
// the source m3u8.
import * as crypto from "crypto";

const EMBED4ME_KEY = Buffer.from("kiemtienmua911ca", "utf8");
const EMBED4ME_IV = Buffer.from("1234567890oiuytr", "utf8");

function aesCbcDecrypt(hexStr, key, iv) {
  const data = Buffer.from(hexStr, "hex");
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export async function extractEmbed4me(embedUrl) {
  try {
    // ID is in fragment (#) or ?id= query
    let m = embedUrl.match(/#([a-zA-Z0-9]+)/);
    if (!m) m = embedUrl.match(/[?&]id=([a-zA-Z0-9]+)/);
    if (!m) return { error: "embed4me: no id in URL" };
    const id = m[1];

    const apiUrl = `https://lpayer.embed4me.com/api/v1/video?id=${id}&w=1920&h=1080&r=https://lpayer.embed4me.com/`;
    // Embed4me's CDN blocks Vercel IPs but allows regular ones — fetch direct,
    // not through anime-proxy. The decrypted m3u8 token also binds to the IP
    // that called the API, so this whole chain must come from the same IP.
    const res = await fetchWithTimeout(
      apiUrl,
      {
        headers: {
          "User-Agent": UA,
          Referer: "https://lpayer.embed4me.com/",
        },
      },
      10000
    );
    if (!res.ok) return { error: `embed4me HTTP ${res.status}` };
    let hex = (await res.text()).trim();
    if (hex.startsWith('"') && hex.endsWith('"')) hex = hex.slice(1, -1);

    let json;
    try {
      const dec = aesCbcDecrypt(hex, EMBED4ME_KEY, EMBED4ME_IV);
      json = JSON.parse(dec);
    } catch (e) {
      return { error: `embed4me: decrypt failed (${e.message})` };
    }
    const source = json?.source;
    if (!source) return { error: "embed4me: no source in payload" };
    // Embed4me allows our IP — return the raw URL; client will wrap through
    // our local /api/v2/proxy/m3u8 which fetches directly with proper Referer.
    return {
      streams: [{
        url: source,
        quality: "auto",
        isM3U8: source.includes(".m3u8"),
        referer: "https://lpayer.embed4me.com/",
      }],
    };
  } catch (e) {
    return { error: `embed4me: ${e.message}` };
  }
}

// ── OneUpload (oneupload.to) — JWPlayer config in <script> ───
export async function extractOneupload(embedUrl) {
  try {
    const res = await fetchThroughProxy(
      embedUrl,
      { headers: { "User-Agent": UA, Referer: new URL(embedUrl).origin + "/" }, redirect: "follow" },
      10000
    );
    if (!res.ok) return { error: `oneupload HTTP ${res.status}` };
    const html = await res.text();
    const m = html.match(/file\s*:\s*['"](https?:\/\/[^'"]+)['"]/);
    if (!m) return { error: "oneupload: no source found" };
    return {
      streams: [{
        url: m[1],
        quality: "auto",
        isM3U8: m[1].includes(".m3u8"),
        referer: embedUrl,
      }],
    };
  } catch (e) {
    return { error: `oneupload: ${e.message}` };
  }
}

// ── Movearnpre / Dingtezuni / Callistanise — packed JS ────────
// Players using `eval(function(p,a,c,k,e,d){...})` packing.
function unpackPackedJs(packed, base, count, words) {
  const toBase = (num, b) => {
    if (num === 0) return "0";
    let out = "";
    while (num > 0) {
      const r = num % b;
      out = (r < 10 ? r.toString() : String.fromCharCode(97 + r - 10)) + out;
      num = Math.floor(num / b);
    }
    return out;
  };
  // Build replacement map: short token → full word
  const map = new Map();
  for (let i = 0; i < count && i < words.length; i++) {
    if (words[i]) map.set(toBase(i, base), words[i]);
  }
  // Sort keys longest-first to avoid partial replacements
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  let out = packed;
  for (const k of keys) {
    out = out.replace(new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), map.get(k));
  }
  return out;
}

function extractPackedCode(html) {
  const m = html.match(
    /eval\(function\(p,a,c,k,e,d\)\{.*?\}\('(.*?)',(\d+),(\d+),'(.*?)'\.split\('\|'\)\)\)/s
  );
  if (!m) return null;
  return {
    packed: m[1],
    base: parseInt(m[2], 10),
    count: parseInt(m[3], 10),
    words: m[4].split("|"),
  };
}

export async function extractMovearnpre(embedUrl) {
  try {
    const origin = new URL(embedUrl).origin;
    // These hosts (movearnpre/dingtezuni/callistanise) allow our IP, so fetch
    // direct — the playback CDN will then validate the same IP for segments.
    const res = await fetchWithTimeout(
      embedUrl,
      { headers: { "User-Agent": UA, Referer: origin }, redirect: "follow" },
      10000
    );
    if (!res.ok) return { error: `movearnpre HTTP ${res.status}` };
    const html = await res.text();

    const pk = extractPackedCode(html);
    if (!pk) return { error: "movearnpre: no packed code" };
    const unpacked = unpackPackedJs(pk.packed, pk.base, pk.count, pk.words);

    // /stream/.../master.m3u8 inside the unpacked code
    const hlsMatch = unpacked.match(/['"](\/stream\/[^'"]*\/master\.m3u8[^'"]*)['"]/);
    if (!hlsMatch) return { error: "movearnpre: no /stream/ HLS path" };

    const masterUrl = embedUrl.split("/embed/")[0] + hlsMatch[1];

    // Resolve highest-resolution variant from the master playlist
    const masterRes = await fetchWithTimeout(
      masterUrl,
      { headers: { "User-Agent": UA, Referer: embedUrl } },
      10000
    );
    if (!masterRes.ok) return { error: `movearnpre master HTTP ${masterRes.status}` };
    const master = await masterRes.text();
    const variants = [
      ...master.matchAll(/#EXT-X-STREAM-INF:[^\n]*RESOLUTION=(\d+)x(\d+)[^\n]*\n([^\n]+\.m3u8)/g),
    ];
    // Direct URLs — our local proxy will handle CORS + segment rewriting.
    if (variants.length === 0) {
      return {
        streams: [{
          url: masterUrl,
          quality: "auto",
          isM3U8: true,
          referer: embedUrl,
        }],
      };
    }
    variants.sort((a, b) => parseInt(b[2]) - parseInt(a[2]));
    const best = variants[0][3].trim();
    const baseUrl = masterUrl.replace(/\/[^/]+$/, "");
    const finalUrl = best.startsWith("http") ? best : `${baseUrl}/${best}`;
    return {
      streams: [{
        url: finalUrl,
        quality: `${variants[0][2]}p`,
        isM3U8: true,
        referer: embedUrl,
      }],
    };
  } catch (e) {
    return { error: `movearnpre: ${e.message}` };
  }
}

// ── Smoothpre / generic JWPlayer-style embeds ────────────────
export async function extractGenericJwplayer(embedUrl) {
  try {
    const origin = new URL(embedUrl).origin;
    // Direct fetch — these hosts allow our IP, and tokens bind to the same IP.
    const res = await fetchWithTimeout(
      embedUrl,
      { headers: { "User-Agent": UA, Referer: origin }, redirect: "follow" },
      10000
    );
    if (!res.ok) return { error: `embed HTTP ${res.status}` };
    const html = await res.text();

    const patterns = [
      /file\s*:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/,
      /file\s*:\s*['"]([^'"]+\.mp4[^'"]*)['"]/,
      /sources\s*:\s*\[\s*\{[^}]*file\s*:\s*['"]([^'"]+)['"]/,
      /source\s*:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/,
      /['"]?(https?:\/\/[^'"\s]+\.m3u8[^'"\s]*)['"]?/,
    ];
    let url = null;
    for (const p of patterns) {
      const m = html.match(p);
      if (m && m[1]) { url = m[1]; break; }
    }
    if (!url) return { error: "embed: no stream found" };

    return {
      streams: [{
        url,
        quality: "auto",
        isM3U8: url.includes(".m3u8"),
        referer: embedUrl,
      }],
    };
  } catch (e) {
    return { error: `embed: ${e.message}` };
  }
}

// Map a host string → extractor function
export function getExtractor(url) {
  const lower = url.toLowerCase();
  if (lower.includes("vidmoly"))                      return extractVidmoly;
  if (lower.includes("sibnet"))                       return extractSibnet;
  if (lower.includes("sendvid"))                      return extractSendvid;
  if (lower.includes("embed4me") || lower.includes("lpayer")) return extractEmbed4me;
  if (
    lower.includes("movearnpre") ||
    lower.includes("dingtezuni") ||
    lower.includes("callistanise") ||
    lower.includes("smoothpre")
  )
    return extractMovearnpre;
  return extractGenericJwplayer;
}
