// Standalone resolver: anime-sama slug + season → Sibnet embed URLs → direct
// m3u8/mp4 stream URLs via the project's own extractSibnet.
//
// Deliberately does NOT import pages/api/v2/source/index.js (that pulls in
// Redis/Turso/AniList). It re-implements the tiny episodes.js parsing inline
// and reuses ONLY extractSibnet from lib/extractors.js (zero heavy deps).
//
// Usage:
//   node resolve_sibnet.mjs <slug> <seasonDir> <lang> <epStart> <epEnd>
// Example:
//   node resolve_sibnet.mjs shingeki-no-kyojin saison1 vostfr 1 5
//
// Prints one JSON object to stdout: { ok, host, episodes: [{ ep, url, isM3U8 }], errors }

import { extractSibnet } from "../../../lib/extractors.js";

const WORKER = "https://aniscroll-proxy.luc-deldem.workers.dev";
const BASE = "https://anime-sama.to";

async function viaWorker(url) {
  const r = await fetch(`${WORKER}?url=${encodeURIComponent(url)}`);
  if (!r.ok) throw new Error(`worker fetch ${r.status} for ${url}`);
  return r.text();
}

// Mirror of parseEpisodesJs in pages/api/v2/source/index.js.
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

function findHostArray(arrays, host) {
  for (const arr of arrays) {
    if (arr.length && arr[0].toLowerCase().includes(host)) return arr;
  }
  return null;
}

async function main() {
  const [slug, seasonDir, lang, startS, endS] = process.argv.slice(2);
  if (!slug || !seasonDir || !lang || !startS || !endS) {
    console.error("args: <slug> <seasonDir> <lang> <epStart> <epEnd>");
    process.exit(2);
  }
  const start = Number(startS);
  const end = Number(endS);

  const out = { ok: false, host: "sibnet.ru", episodes: [], errors: [] };
  try {
    const js = await viaWorker(`${BASE}/catalogue/${slug}/${seasonDir}/${lang}/episodes.js`);
    const arrays = parseEpisodesJs(js);
    const sibnet = findHostArray(arrays, "sibnet");
    if (!sibnet) {
      out.errors.push("no sibnet array in episodes.js");
      console.log(JSON.stringify(out));
      return;
    }
    for (let ep = start; ep <= end; ep++) {
      const idx = ep - 1;
      const embed = sibnet[idx];
      if (!embed) {
        out.errors.push(`ep ${ep}: no embed at index ${idx}`);
        continue;
      }
      const res = await extractSibnet(embed);
      const s = res?.streams?.[0];
      if (s?.url) {
        out.episodes.push({ ep, url: s.url, isM3U8: !!s.isM3U8, embed });
      } else {
        out.errors.push(`ep ${ep}: ${res?.error || "no stream"}`);
      }
    }
    out.ok = out.episodes.length > 0;
  } catch (e) {
    out.errors.push(e.message);
  }
  console.log(JSON.stringify(out));
}

main();
