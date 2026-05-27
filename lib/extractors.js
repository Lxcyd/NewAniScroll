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

// Cloudflare Worker URL — used as a low-cost extraction proxy. Routing the
// embed-page fetches (Sibnet, Sendvid, Vidmoly, Smoothpre/Movearnpre, …)
// through the Worker means EXTRACTION runs from Cloudflare IPs, the same
// network the BROWSER uses for playback. That keeps any IP-bound tokens the
// upstream hands out valid for the subsequent segment fetches. Without this
// extraction happened on Vercel AWS IPs while playback went via Cloudflare —
// the mismatch made tokens get rejected mid-playback.
const WORKER_PROXY_URL = (process.env.NEXT_PUBLIC_PROXY_BASE || "").replace(/\/$/, "");

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

// Route an extractor fetch through the Cloudflare Worker. The Worker forwards
// the Referer (auto-detected from the target host) and returns the upstream
// body verbatim, so our existing parsing logic doesn't need to change. Falls
// back to a direct fetch when the Worker URL isn't configured (local dev).
async function fetchViaWorker(targetUrl, options = {}, ms = 10000) {
  if (!WORKER_PROXY_URL) return fetchWithTimeout(targetUrl, options, ms);
  const refererHeader = options.headers?.Referer || options.headers?.referer || "";
  const proxied =
    `${WORKER_PROXY_URL}/?url=${encodeURIComponent(targetUrl)}` +
    (refererHeader ? `&referer=${encodeURIComponent(refererHeader)}` : "");
  // We strip the Referer header from the inner fetch — the Worker handles it
  // via the query param, and the browser block our setting Referer anyway.
  const { headers: rawHeaders, ...rest } = options;
  const headers = { ...(rawHeaders || {}) };
  delete headers.Referer;
  delete headers.referer;
  return fetchWithTimeout(proxied, { ...rest, headers }, ms);
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
  // Prefer the dedicated anime-proxy when configured (its IP pool was
  // designed for vidmoly's per-IP bans). Otherwise route via the Cloudflare
  // Worker so extraction shares the Cloudflare network the player uses for
  // segment playback — keeps any IP-bound tokens valid end-to-end.
  const fetcher = ANIME_PROXY_URL ? fetchThroughProxy : fetchViaWorker;
  console.log(`[vidmoly] fetch ${url} via ${ANIME_PROXY_URL ? "anime-proxy" : WORKER_PROXY_URL ? "worker" : "direct"}`);
  const res = await fetcher(
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
        const hashFetcher = ANIME_PROXY_URL ? fetchThroughProxy : fetchViaWorker;
        const res = await hashFetcher(
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
          const r2 = await hashFetcher(
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
    // Sibnet blocks Cloudflare Worker IPs at the source (400 on the first
    // hop, no redirect) BUT — and this is the win — once we follow the
    // 302 chain (sibnet.ru → dv97 → cvnXX) to the final CDN URL, that
    // final URL is signed with a `noip=1` flag. That flag means:
    //   - any IP can fetch it (no IP binding)
    //   - no Referer required (verified: 206 from a fresh browser-style
    //     fetch with Referer: aniscroll.com AND with no Referer at all)
    //
    // So we resolve the chain server-side and hand the browser the final
    // cvn URL. Vidstack <video src> plays it directly — no Worker, no
    // proxy, no per-segment hops. Same network path as anime-sama's
    // native iframe, minus the 302 chain (we already paid it once
    // server-side; the browser hits the final URL once and is done).
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
    const initialUrl = path.startsWith("http") ? path : `https://video.sibnet.ru${path}`;

    // Resolve the 302 chain. Range: bytes=0-0 keeps the body to a single
    // byte (we're only here for `response.url` after redirects).
    let finalUrl = initialUrl;
    try {
      const follow = await fetchWithTimeout(initialUrl, {
        method: "GET",
        headers: {
          "User-Agent": UA,
          Referer: "https://video.sibnet.ru/",
          Range: "bytes=0-0",
        },
        redirect: "follow",
      });
      if (follow.ok || follow.status === 206) {
        finalUrl = follow.url || initialUrl;
      }
    } catch {
      // Fall back to the un-resolved URL — the worker / proxy chain will
      // pick up the slack (slow but functional).
    }

    return {
      streams: [{
        url: finalUrl,
        quality: "default",
        isM3U8: m[2].includes("m3u8") || finalUrl.includes(".m3u8"),
        referer: null,
        directUrl: true, // browser plays the cvn URL straight — no proxy needed
        noCors: true,    // sibnet's CDN doesn't send Access-Control-Allow-Origin
      }],
    };
  } catch (e) {
    return { error: `sibnet: ${e.message}` };
  }
}

// ── Sendvid (sendvid.com) — bypasses X-Frame-Options ─────────
export async function extractSendvid(embedUrl) {
  try {
    const res = await fetchViaWorker(embedUrl, {
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
    // Route via Worker — embed4me IP-binds its decrypted m3u8 token to the
    // caller IP. Doing the API call from Cloudflare (same network the player
    // uses for segment playback) keeps the token valid end-to-end.
    const res = await fetchViaWorker(
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
    // The playback CDN (dramiyos-cdn / acek-cdn / mindbodywellness.space)
    // blocks Cloudflare Worker IPs outright (responds 530). Extract direct
    // from the Vercel function and flag the stream so playback goes through
    // the Vercel-side proxy — same AWS IP pool from end to end.
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

    // The unpacked JWPlayer config exposes multiple HLS sources, e.g.
    //   var links = {
    //     "hls2": "https://eXXX.dramiyos-cdn.com/.../master.m3u8?t=...",  ← REAL VIDEO
    //     "hls3": "https://eXXX.mindbodywellness.space/.../master.txt",   ← fallback
    //     "hls4": "/stream/.../master.m3u8"                                ← TIKTOK IMAGE TRAP
    //   };
    //   sources: [{ file: links.hls4 || links.hls3 || links.hls2 }]
    //
    // The relative /stream/ path is a poisoned playlist that serves TikTok
    // image URLs in place of .ts segments — anti-bot/server-side scraping
    // detection. We must prefer the absolute https:// CDN URL ("hls2"),
    // which carries a signed token that's valid for ~1.5h.
    //
    // Preference order: hls2 (signed CDN m3u8) → hls (any external https
    // m3u8) → hls3 (.txt master, sometimes works) → hls4 (last resort,
    // likely poisoned but caller can still try).
    const linkRegex =
      /['"](hls\d?)['"]\s*:\s*['"]([^'"]+\.(?:m3u8|txt)[^'"]*)['"]/g;
    const linkMap = new Map();
    let mm;
    while ((mm = linkRegex.exec(unpacked)) !== null) {
      linkMap.set(mm[1], mm[2]);
    }

    let chosen = null;
    for (const key of ["hls2", "hls", "hls3", "hls4"]) {
      const v = linkMap.get(key);
      if (!v) continue;
      // Skip the relative /stream/ poisoned path
      if (v.startsWith("/")) continue;
      chosen = { key, url: v };
      break;
    }

    // Legacy fallback: if no link map matched, look for any absolute m3u8
    // (covers older variants of the embed page format).
    if (!chosen) {
      const anyAbs = unpacked.match(
        /['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/
      );
      if (anyAbs) chosen = { key: "abs", url: anyAbs[1] };
    }

    if (!chosen) return { error: "movearnpre: no usable absolute m3u8 (only /stream/ trap)" };

    const masterUrl = chosen.url;
    const referer = origin + "/";

    // .txt master playlists (hls3) are sometimes served as text/plain but
    // contain valid HLS — let the client treat them as m3u8.
    const isM3u8Like = masterUrl.includes(".m3u8") || masterUrl.includes(".txt");

    // Skip the variant probe when the URL is already a variant playlist
    // (smoothpre often returns `index-v1-a1.m3u8` which IS a media playlist
    // — no #EXT-X-STREAM-INF inside, just segments). In that case fetching
    // it just to discover that fact wastes 500ms-1s of latency. Heuristic:
    // master playlists are conventionally named `master.m3u8`; anything
    // matching `/index-v\d` or `/playlist-v\d` is already a variant.
    const looksLikeMaster = /\/master\.(?:m3u8|txt)(?:\?|$)/.test(masterUrl);
    let finalUrl = masterUrl;
    let quality = "auto";
    if (looksLikeMaster) {
      try {
        const masterRes = await fetchWithTimeout(
          masterUrl,
          { headers: { "User-Agent": UA, Referer: referer } },
          10000
        );
        if (masterRes.ok) {
          const master = await masterRes.text();
          const variants = [
            ...master.matchAll(
              /#EXT-X-STREAM-INF:[^\n]*RESOLUTION=(\d+)x(\d+)[^\n]*\n([^\n]+)/g
            ),
          ];
          if (variants.length > 0) {
            variants.sort((a, b) => parseInt(b[2]) - parseInt(a[2]));
            const best = variants[0][3].trim();
            const baseUrl = masterUrl.replace(/\/[^/]+(?:\?[^?]*)?$/, "");
            finalUrl = best.startsWith("http") ? best : `${baseUrl}/${best}`;
            quality = `${variants[0][2]}p`;
          }
        }
      } catch {
        // Master probe failed — fall back to the original URL, hls.js can
        // resolve variants client-side.
      }
    }

    return {
      streams: [{
        url: finalUrl,
        quality,
        isM3U8: isM3u8Like || finalUrl.includes(".m3u8"),
        referer,
        // acek-cdn host is detected by the Worker and routed via
        // ANIME_PROXY_URL — no per-stream flag needed any more.
      }],
    };
  } catch (e) {
    return { error: `movearnpre: ${e.message}` };
  }
}

// ── Megaplay (megaplay.buzz/stream/ani/<aniId>/<ep>/<sub|dub>) ────
// Megaplay is HiAnime/AniWatch's MegaCloud-derivative. Two things to know:
//   1. It refuses requests without a Referer (returns a 410 error page).
//      We send Referer: https://megaplay.buzz/ which is enough.
//   2. The embed page contains `data-id="<fileId>"` in the player div. That
//      file ID is what /stream/getSources?id=<id> uses to return JSON with
//      a clean m3u8 + a list of subtitle tracks.
//
// JSON shape:
//   {
//     sources: { file: "https://cdn.mewstream.buzz/.../master.m3u8" },
//     tracks: [
//       { file: "...subtitles/eng-2.vtt", label: "English", kind: "captions", default: true },
//       { file: "...subtitles/fre-12.vtt", label: "French", kind: "captions" },
//       ...
//     ]
//   }
//
// No token expiry on the m3u8 — segments validate by Referer only.
export async function extractMegaplay(embedUrl) {
  try {
    // Step 1: Megaplay 410's any GET without a Referer. Use its own origin.
    const pageRes = await fetchWithTimeout(
      embedUrl,
      {
        headers: {
          "User-Agent": UA,
          Referer: "https://megaplay.buzz/",
          "Sec-Fetch-Dest": "iframe",
        },
      },
      10000
    );
    if (!pageRes.ok) return { error: `megaplay HTTP ${pageRes.status}` };
    const html = await pageRes.text();

    // The error page has <title>Error - MegaPlay</title>; valid pages have
    // <title>File 1234 - MegaPlay</title>.
    if (/Error - MegaPlay/i.test(html) || /We can't find the file/i.test(html)) {
      return { error: "megaplay: file not found" };
    }

    // Step 2: pull the internal file ID from `data-id="..."` on the player div.
    const idMatch = html.match(/data-id="(\d+)"/);
    if (!idMatch) return { error: "megaplay: data-id not in page" };
    const fileId = idMatch[1];

    // Step 3: fetch the JSON sources endpoint.
    const apiRes = await fetchWithTimeout(
      `https://megaplay.buzz/stream/getSources?id=${fileId}`,
      {
        headers: {
          "User-Agent": UA,
          Referer: embedUrl,
          Accept: "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
        },
      },
      10000
    );
    if (!apiRes.ok) return { error: `megaplay API HTTP ${apiRes.status}` };
    let data;
    try {
      data = JSON.parse(await apiRes.text());
    } catch (e) {
      return { error: `megaplay: API JSON parse (${e.message})` };
    }

    const m3u8 = data?.sources?.file;
    if (!m3u8) return { error: "megaplay: no source.file in API response" };

    const subtitles = (data?.tracks || [])
      .filter((t) => t?.kind === "captions" || t?.kind === "subtitles")
      .map((t) => ({
        file: t.file,
        label: t.label || t.lang || "Subtitle",
        // Use the label as the BCP47-ish language code if no separate language
        // field; the player uses this only for accessibility tagging.
        language: (t.label || "").split(" ")[0].slice(0, 5).toLowerCase() || "en",
        kind: t.kind || "captions",
        default: !!t.default,
      }));

    return {
      streams: [
        {
          url: m3u8,
          quality: "auto",
          isM3U8: m3u8.includes(".m3u8"),
          referer: "https://megaplay.buzz/",
        },
      ],
      subtitles,
    };
  } catch (e) {
    return { error: `megaplay: ${e.message}` };
  }
}

// ── VOE (voe.sx → mirror domain → obfuscated JSON payload) ───
// VOE rotates its playback domains and hides the source behind a multi-step
// obfuscation. The `voe.sx/e/<id>` page is a tiny JS redirect to a mirror
// host (e.g. maryspecialwatch.com), which serves the real player page with
// a `<script type="application/json">["..."]</script>` payload.
//
// Decoder algorithm — extracted verbatim from VOE's loader.js:
//   1. ROT13 every letter
//   2. Strip noise tokens: @$ ^^ ~@ %? *~ !! #&
//   3. Strip every "_" character
//   4. Base64 decode (binary string)
//   5. Subtract 3 from each char code
//   6. Reverse the string
//   7. Base64 decode again (utf-8 this time — JSON has unicode)
//   8. JSON.parse → { source, direct_access_url, title, ... }
//
// `source` is an HLS master.m3u8; `direct_access_url` is an MP4 fallback.
// Both carry signed tokens that bind to our server's IP for ~4h.
function decodeVoePayload(s) {
  // ROT13
  s = s.replace(/[a-zA-Z]/g, (c) => {
    const code = c.charCodeAt(0);
    const base = code <= 90 ? 65 : 97;
    return String.fromCharCode(((code - base + 13) % 26) + base);
  });
  for (const t of ["@$", "^^", "~@", "%?", "*~", "!!", "#&"]) {
    s = s.split(t).join("");
  }
  s = s.split("_").join("");
  s = Buffer.from(s, "base64").toString("binary");
  s = [...s].map((c) => String.fromCharCode(c.charCodeAt(0) - 3)).join("");
  s = s.split("").reverse().join("");
  s = Buffer.from(s, "base64").toString("utf8");
  return JSON.parse(s);
}

// VOE protects its CDN with DDoS-Guard cookies (`__ddg9_` = IP binding,
// `voe_session`, etc.) that the mirror page issues on first visit. Segments
// fetched by hls.js then go through our /api/v2/proxy/m3u8, which reissues
// the request from the same IP — but without the cookies, the CDN returns
// 403. So we capture the Set-Cookie headers during extraction and stash them
// keyed by the playback CDN host. The m3u8 proxy reads this jar when it
// detects a cloudwindow-route.com / VOE host and forwards them.
//
// Entries are valid for ~90 minutes (token TTL is 4h, but DDoS-Guard cookies
// expire faster). Old entries are GC'd lazily on lookup to avoid leaking.
const VOE_COOKIE_JAR = new Map(); // host → { cookie, expires }

export function getVoeCookieFor(host) {
  const lower = host.toLowerCase();
  for (const [key, { cookie, expires }] of VOE_COOKIE_JAR) {
    if (Date.now() > expires) {
      VOE_COOKIE_JAR.delete(key);
      continue;
    }
    if (lower.includes(key) || key.includes(lower)) return cookie;
  }
  return null;
}

function storeVoeCookies(cdnHost, cookieHeader) {
  // Set-Cookie header may be a single string with multiple cookies separated
  // by ", " — we keep the whole thing and let the proxy forward it as-is.
  if (!cookieHeader) return;
  // Normalize "name=value; attr=...; name2=value2; attr=..." into "name=value; name2=value2"
  // by stripping all attributes (Path, Domain, Expires, Max-Age, Secure, etc.).
  const cookies = [];
  // Set-Cookie can have multiple values joined by comma; node-fetch joins them
  // but commas can also appear in dates. We split on `, ` only when followed
  // by a name=value pattern.
  const parts = cookieHeader.split(/,(?=\s*[a-zA-Z_][a-zA-Z0-9_-]*=)/);
  for (const part of parts) {
    const nameValue = part.trim().split(";")[0];
    if (nameValue.includes("=")) cookies.push(nameValue);
  }
  if (cookies.length === 0) return;
  VOE_COOKIE_JAR.set(cdnHost, {
    cookie: cookies.join("; "),
    expires: Date.now() + 90 * 60 * 1000,
  });
}

export async function extractVoe(embedUrl) {
  try {
    // Step 1: follow the voe.sx → mirror redirect.
    // The redirect happens via JS (window.location.href = '...'), so we
    // fetch the page, parse the redirect URL, and follow it manually.
    let pageUrl = embedUrl;
    let html = "";
    let lastSetCookie = "";
    for (let hop = 0; hop < 4; hop++) {
      const res = await fetchWithTimeout(
        pageUrl,
        {
          headers: {
            "User-Agent": UA,
            Referer: "https://voir-anime.to/",
          },
          redirect: "follow",
        },
        10000
      );
      if (!res.ok) return { error: `voe HTTP ${res.status} on ${pageUrl}` };
      // Capture Set-Cookie from the mirror response — DDoS-Guard issues these.
      const sc =
        res.headers.getSetCookie?.()?.join(", ") ||
        res.headers.get("set-cookie") ||
        "";
      if (sc) lastSetCookie = sc;
      html = await res.text();

      // Look for either the JSON payload (we're on the player page) or
      // a redirect target.
      if (/<script[^>]*type="application\/json"/.test(html)) break;
      const redirect =
        html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/)?.[1] ||
        html.match(/<meta[^>]*http-equiv=["']?refresh["']?[^>]*url=([^"'>\s]+)/i)?.[1];
      if (!redirect) return { error: "voe: no JSON payload and no redirect" };
      pageUrl = redirect;
    }

    // Step 2: extract and decode the JSON payload.
    const m = html.match(
      /<script[^>]*type="application\/json"[^>]*>\s*\[\s*"([^"]+)"\s*\]\s*<\/script>/
    );
    if (!m) return { error: "voe: JSON payload not found on player page" };

    let data;
    try {
      data = decodeVoePayload(m[1]);
    } catch (e) {
      return { error: `voe: decode failed (${e.message})` };
    }

    const hls = data?.source;
    const mp4 = data?.direct_access_url;
    if (!hls && !mp4) return { error: "voe: payload had no source URL" };

    // Prefer HLS (multi-bitrate, faster start). The `pageUrl` is the mirror
    // domain that issued the signed token — segments validate against it.
    const chosen = hls || mp4;

    // Stash the DDoS-Guard cookies from the mirror under the CDN's host.
    // The m3u8 proxy will read them when forwarding segment requests.
    try {
      const cdnHost = new URL(chosen).hostname;
      // Keep just the suffix that's likely shared across rotating subdomains
      // (e.g. `cloudwindow-route.com`) so future tokens with different
      // wildcard subdomains still match.
      const parts = cdnHost.split(".");
      const suffix = parts.slice(-2).join(".");
      storeVoeCookies(suffix, lastSetCookie);
    } catch {}

    // Playability check: VOE sometimes returns a payload with a `source` URL
    // that's already invalid (token bound to a different IP, the file was
    // removed mid-session, or the playlist is empty). A HEAD passing isn't
    // enough — broken streams routinely return 200 HEAD then 403 / empty body
    // on the actual segment GET, which is the "chip appears, disappears on
    // click" symptom users see. So for HLS we fetch the playlist body and
    // verify it parses; for MP4 we keep HEAD and probe a tiny Range request
    // for actual bytes.
    const isHls = chosen.includes(".m3u8");
    try {
      const cdnHost = new URL(chosen).hostname;
      const cookie = getVoeCookieFor(cdnHost);
      const probe = await fetchWithTimeout(
        chosen,
        {
          method: isHls ? "GET" : "HEAD",
          headers: {
            "User-Agent": UA,
            Referer: pageUrl,
            ...(isHls ? {} : { Range: "bytes=0-1023" }),
            ...(cookie ? { Cookie: cookie } : {}),
          },
        },
        5000
      );
      // 4xx (except 405 Method Not Allowed which some CDNs use to reject HEAD)
      // means the stream is dead. 5xx is transient — let the player try.
      if (
        probe.status >= 400 &&
        probe.status < 500 &&
        probe.status !== 405 &&
        probe.status !== 416 // some CDNs reject Range on tiny files
      ) {
        return { error: `voe: stream HTTP ${probe.status}` };
      }
      if (isHls && probe.ok) {
        // Validate the playlist body. A real master.m3u8 starts with #EXTM3U
        // and contains either #EXT-X-STREAM-INF (master) or #EXTINF (media).
        // VOE's broken streams sometimes return 200 with an HTML error page
        // (Cloudflare challenge, "video deleted") that would pass HEAD but
        // crash hls.js. The player can't recover from those, so we treat
        // anything that doesn't look like HLS as a dead stream.
        const body = await probe.text();
        if (!body.startsWith("#EXTM3U")) {
          return { error: "voe: playlist not HLS (token likely expired)" };
        }
        const isMaster = body.includes("#EXT-X-STREAM-INF");
        if (!isMaster && !body.includes("#EXTINF")) {
          return { error: "voe: playlist has no variants/segments" };
        }
        // Master playlist passing isn't enough — VOE often serves a valid
        // master while every variant/segment 410s (IP-bound tokens, removed
        // file). Resolve the first non-comment line after each STREAM-INF /
        // EXTINF, then probe that URL. If it 410s, the stream is dead from
        // the player's perspective too.
        const lines = body.split(/\r?\n/);
        let childUrl = null;
        for (let i = 0; i < lines.length - 1 && !childUrl; i++) {
          const tag = lines[i].trim();
          const next = lines[i + 1].trim();
          if (!next || next.startsWith("#")) continue;
          if (tag.startsWith("#EXT-X-STREAM-INF") || tag.startsWith("#EXTINF")) {
            childUrl = next;
          }
        }
        if (childUrl) {
          // Resolve relative URL against the master's URL.
          const resolved = new URL(childUrl, chosen).toString();
          try {
            const child = await fetchWithTimeout(
              resolved,
              {
                method: "GET",
                headers: {
                  "User-Agent": UA,
                  Referer: pageUrl,
                  Range: "bytes=0-1023",
                  ...(cookie ? { Cookie: cookie } : {}),
                },
              },
              4000
            );
            if (
              child.status >= 400 &&
              child.status < 500 &&
              child.status !== 405 &&
              child.status !== 416
            ) {
              return { error: `voe: child ${child.status} (${isMaster ? "variant" : "segment"} dead)` };
            }
          } catch {
            // Network error — don't block; the master was at least valid.
          }
        }
      }
    } catch {
      // Network error on probe — don't block, the player will surface the
      // real error if any.
    }

    // Capture the cookie at extraction time so the proxy (whether it's the
    // in-tree Vercel endpoint or the Cloudflare Worker) can forward it
    // without sharing in-memory state with the extractor. Without this hop,
    // the Worker has no way to authenticate against cloudwindow-route.
    let voeCookie = null;
    try {
      const cdnHost = new URL(chosen).hostname;
      voeCookie = getVoeCookieFor(cdnHost);
    } catch {}

    return {
      streams: [
        {
          url: chosen,
          quality: "auto",
          isM3U8: chosen.includes(".m3u8"),
          referer: pageUrl,
          voeCookie,
        },
      ],
    };
  } catch (e) {
    return { error: `voe: ${e.message}` };
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
  if (lower.includes("voe.sx") || lower.includes("voe."))     return extractVoe;
  if (
    lower.includes("movearnpre") ||
    lower.includes("dingtezuni") ||
    lower.includes("callistanise") ||
    lower.includes("smoothpre")
  )
    return extractMovearnpre;
  return extractGenericJwplayer;
}
