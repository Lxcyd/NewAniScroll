// Multi-host standalone resolver: anime-sama slug+season → direct stream URLs
// for a range of episodes, trying hosts in priority order until one yields
// ffmpeg-playable direct streams. Resilient to a single host being down
// (e.g. Sibnet rate-limiting), which a single-host bridge could not handle.
//
// Reuses the project's getExtractor() dispatch + the per-host extractors from
// lib/extractors.js (zero heavy deps besides crypto). Does NOT import the
// Next API route (Redis/Turso-free).
//
// Usage: node resolve.mjs <slug> <seasonDir> <lang> <epStart> <epEnd> [hostPref]
//   hostPref: comma list to override priority, e.g. "sibnet,embed4me,sendvid"
//
// Prints ONE JSON line last: { ok, host, episodes:[{ep,url,isM3U8,host}], errors }

import { getExtractor } from "../../../lib/extractors.js";

const WORKER = "https://aniscroll-proxy.luc-deldem.workers.dev";
const BASE = "https://anime-sama.to";

// Priority: direct-CDN hosts that hand ffmpeg a playable URL with no per-segment
// token games. Sibnet (signed mp4, noip) and embed4me/sendvid (hls2) are best;
// vidmoly is browser-only (IP-bound) so we skip it for server-side audio pull.
const DEFAULT_PRIORITY = ["sibnet", "embed4me", "lpayer", "sendvid", "uqload"];

async function viaWorker(url) {
  const r = await fetch(`${WORKER}?url=${encodeURIComponent(url)}`);
  if (!r.ok) throw new Error(`worker fetch ${r.status} for ${url}`);
  return r.text();
}

function parseEpisodesJs(js) {
  const arrays = [];
  const re = /var\s+eps\d+\s*=\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(js)) !== null) {
    const urls = [];
    const ure = /['"]([^'"]+)['"]/g;
    let um;
    while ((um = ure.exec(m[1])) !== null) urls.push(um[1]);
    if (urls.length) arrays.push(urls);
  }
  return arrays;
}

function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return ""; }
}

function pickArray(arrays, hostKey) {
  for (const arr of arrays) {
    if (arr.length && arr[0].toLowerCase().includes(hostKey)) return arr;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Extract one embed with retry+backoff. Transient blocks (host rate-limits,
// brief 403s, timeouts) often clear within a few seconds; a host is only
// considered failed after RETRIES exhausted. Backoff: 1s, 3s, 7s.
async function extractWithRetry(embed, retries = 3) {
  let lastErr = "no stream";
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep([1000, 3000, 7000][attempt - 1] || 7000);
    try {
      const res = await getExtractor(embed)(embed);
      const s = res?.streams?.[0];
      if (s?.url) {
        // referer is needed by hosts like embed4me for ffmpeg to fetch the m3u8.
        return { ok: true, url: s.url, isM3U8: !!s.isM3U8,
                 referer: s.referer || res.referer || null };
      }
      lastErr = res?.error || "no stream";
    } catch (e) {
      lastErr = e.message;
    }
  }
  return { ok: false, error: lastErr };
}

async function extractRange(arr, hostKey, start, end) {
  const episodes = [];
  const errors = [];
  for (let ep = start; ep <= end; ep++) {
    const embed = arr[ep - 1];
    if (!embed) { errors.push(`ep ${ep}: no embed`); continue; }
    const r = await extractWithRetry(embed);
    if (r.ok) {
      episodes.push({ ep, url: r.url, isM3U8: r.isM3U8, host: hostKey,
                      referer: r.referer });
    } else {
      errors.push(`ep ${ep}: ${r.error}`);
    }
  }
  return { episodes, errors };
}

async function main() {
  const [slug, seasonDir, lang, startS, endS, hostPref] = process.argv.slice(2);
  if (!slug || !seasonDir || !lang || !startS || !endS) {
    console.error("args: <slug> <seasonDir> <lang> <epStart> <epEnd> [hostPref]");
    process.exit(2);
  }
  const start = Number(startS), end = Number(endS);
  const priority = hostPref ? hostPref.split(",") : DEFAULT_PRIORITY;

  const out = { ok: false, host: null, episodes: [], errors: [] };
  let arrays;
  try {
    const js = await viaWorker(`${BASE}/catalogue/${slug}/${seasonDir}/${lang}/episodes.js`);
    arrays = parseEpisodesJs(js);
  } catch (e) {
    out.errors.push(`episodes.js: ${e.message}`);
    console.log(JSON.stringify(out));
    return;
  }

  // Try each host in priority order; keep the first that resolves the WHOLE
  // requested range (so the series bank gets a consistent single-host cut).
  for (const hostKey of priority) {
    const arr = pickArray(arrays, hostKey);
    if (!arr) continue;
    const { episodes, errors } = await extractRange(arr, hostKey, start, end);
    if (episodes.length === end - start + 1) {
      out.ok = true; out.host = hostKey; out.episodes = episodes; out.errors = errors;
      console.log(JSON.stringify(out));
      return;
    }
    // Partial: remember the best attempt but keep trying other hosts.
    if (episodes.length > out.episodes.length) {
      out.host = hostKey; out.episodes = episodes; out.errors = errors;
    }
  }
  out.ok = out.episodes.length > 0;
  console.log(JSON.stringify(out));
}

main();
