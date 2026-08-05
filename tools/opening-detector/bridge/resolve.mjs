// Multi-host standalone resolver: anime-sama slug+season → direct stream URLs
// for a range of episodes, trying hosts in priority order until one yields
// ffmpeg-playable direct streams. Resilient to a single host being down
// (e.g. Sibnet rate-limiting), which a single-host bridge could not handle.
//
// Reuses the project's getExtractor() dispatch + the per-host extractors from
// lib/extractors.js (zero heavy deps besides crypto). Does NOT import the
// Next API route (Redis/Turso-free).
//
// Usage: node resolve.mjs <slug> <seasonDir> <lang> <epStart> <epEnd> [hostPref] [malId] [vaSlug]
//   hostPref: comma list to override priority, e.g.
//             "sibnet,sendvid,megaplay,vidmoly,vidmoly-va"
//   malId: required only if "megaplay" is in hostPref/priority — megaplay's
//          embed URL is built directly from a MAL id, it doesn't come from
//          anime-sama's episodes.js at all (see extractMegaplayRange below).
//   vaSlug: required only if "vidmoly-va" is in hostPref/priority — the
//           voir-anime slug (e.g. "shingeki-no-kyojin-vostfr"). voir-anime is a
//           separate site (WordPress/Madara) with its own per-season slugs, so
//           it can't be derived from the anime-sama slug (see resolveVoiranime).
//
// Prints ONE JSON line last: { ok, host, episodes:[{ep,url,isM3U8,host}], errors }

import { getExtractor, extractMegaplay } from "../../../lib/extractors.js";

const WORKER = "https://aniscroll-proxy.luc-deldem.workers.dev";
const BASE = "https://anime-sama.to";
const VOIRANIME_BASE = "https://voir-anime.to";
const VIDMOLY_DOMAINS = ["vidmoly.net", "vidmoly.to", "vidmoly.biz"];
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Vidmoly's master m3u8 token is IP-bound to whoever fetched the embed page.
// lib/extractors.js's extractVidmoly deliberately fetches via the CF Worker so
// the token binds to the Worker (matching the BROWSER's playback path). That's
// wrong for THIS offline tool: ffmpeg pulls from this machine's own IP, so we
// must extract from HERE too — then the token binds to this IP and ffmpeg's
// segment fetches (same IP) are accepted. Routing through the Worker instead
// gets a Cloudflare 1042 ("data-center to data-center") from vidmoly's CDN.
// So we do a local, direct extraction rather than reusing extractVidmoly.
async function extractVidmolyDirect(embedUrl) {
  for (const domain of VIDMOLY_DOMAINS) {
    const url = embedUrl.replace(/vidmoly\.(to|biz|net)/, domain);
    let html;
    try {
      const r = await fetch(url, {
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          Referer: BASE + "/",
        },
        redirect: "follow",
      });
      if (!r.ok) continue;
      html = await r.text();
    } catch { continue; }
    if (!html || html.length < 500) continue;
    const m =
      html.match(/file:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/) ||
      html.match(/['"](https?:\/\/[^'"\s]+\.m3u8[^'"\s]*)['"]/);
    if (m && m[1].startsWith("http")) {
      // ffmpeg needs the vidmoly Referer to fetch the master/segments.
      return { ok: true, url: m[1], isM3U8: true, referer: `https://${domain}/` };
    }
  }
  return { ok: false, error: "vidmoly: no source found on any domain" };
}

// Priority: hosts whose signed stream URL is NOT IP-bound to whatever
// extracted it, so a downstream ffmpeg pull from a different machine (this
// tool) can read it directly.
//   - sibnet: final CDN URL carries `noip=1` — confirmed no IP binding.
//   - sendvid: direct CDN URL, no hard IP binding for residential-style pulls.
//   - megaplay: m3u8 has NO token expiry and validates by Referer only (see
//     extractMegaplay in lib/extractors.js) — safe for a downstream reader.
//   - vidmoly (anime-sama source) & vidmoly-va (voir-anime source): the master
//     m3u8 token IS IP-bound to whoever extracted the embed. We extract it
//     LOCALLY (extractVidmolyDirect, not lib's Worker-based extractVidmoly) so
//     the token binds to THIS machine's IP — the same IP ffmpeg pulls segments
//     from, so they're accepted. (Going through the Worker gets a Cloudflare
//     1042 from vidmoly's CDN — data-center to data-center.)
// Deliberately excluded:
//   - embed4me/lpayer: SAME host (its URLs literally contain both substrings,
//     e.g. lpayer.embed4me.com) — including both in a hostPref list resolves
//     the identical stream twice under two different labels. Also IP-bound,
//     same caveat as vidmoly.
//   - uqload: NOW has a dedicated extractor (extractUqload — unpacks its
//     P.A.C.K.E.R block and reads the JWPlayer `file:` HLS src). Its master
//     m3u8 plays with/without a Referer and isn't hard IP-bound, so it's a
//     safe downstream pull. Added at LOW priority (after the proven hosts).
//     NOTE: uqload gates the embed on the anime-sama Referer — the extractor
//     sends it; a wrong Referer yields a 38-byte "restricted" stub.
const DEFAULT_PRIORITY = ["sibnet", "sendvid", "megaplay", "uqload"];

async function viaWorker(url) {
  const r = await fetch(`${WORKER}?url=${encodeURIComponent(url)}`);
  if (!r.ok) throw new Error(`worker fetch ${r.status} for ${url}`);
  return r.text();
}

// anime-sama.to is itself Cloudflare-proxied, so a request FROM a Cloudflare
// Worker's data-center IP TO it gets blocked with Cloudflare error 1042
// ("data-center to data-center" abuse protection) — this is independent of
// whether the worker code is correct, and isn't something the worker can route
// around. A plain fetch from this machine's own (non-Cloudflare-datacenter) IP
// isn't subject to that rule, so try direct first and only fall back to the
// worker proxy (kept for whatever it was originally added for — e.g. a
// geo/IP block on some networks) if the direct fetch fails.
async function fetchPage(url) {
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
          + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Referer": BASE + "/",
      },
    });
    if (!r.ok) throw new Error(`direct fetch ${r.status} for ${url}`);
    return await r.text();
  } catch (directErr) {
    try {
      return await viaWorker(url);
    } catch (workerErr) {
      throw new Error(`direct failed (${directErr.message}); `
        + `worker failed (${workerErr.message})`);
    }
  }
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
      // vidmoly is extracted locally (token binds to this IP) — see
      // extractVidmolyDirect. All other hosts go through the shared lib.
      if (/vidmoly/i.test(embed)) {
        const v = await extractVidmolyDirect(embed);
        if (v.ok) return v;
        lastErr = v.error;
        continue;
      }
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

// Megaplay isn't sourced from anime-sama's episodes.js at all — its embed URL
// is built directly from a MAL id + episode + sub/dub track, e.g.
//   https://megaplay.buzz/stream/mal/16498/3/sub
// It bypasses parseEpisodesJs/pickArray entirely, so it needs its own
// extraction loop rather than slotting into extractRange (which expects an
// `arr` of embed URLs already scraped from episodes.js).
//
// No IP-binding on its m3u8 (validates by Referer only — see extractMegaplay
// in lib/extractors.js), so unlike vidmoly/embed4me this one is safe for a
// downstream ffmpeg pull from a different machine than the one that
// extracted it.
async function extractMegaplayRange(malId, lang, start, end) {
  const episodes = [];
  const errors = [];
  const track = /vf/i.test(lang) ? "dub" : "sub";
  for (let ep = start; ep <= end; ep++) {
    const embedUrl = `https://megaplay.buzz/stream/mal/${malId}/${ep}/${track}`;
    const r = await extractMegaplay(embedUrl);
    const s = r?.streams?.[0];
    if (s?.url) {
      episodes.push({
        ep, url: s.url, isM3U8: !!s.isM3U8, host: "megaplay",
        referer: s.referer || "https://megaplay.buzz/",
      });
    } else {
      errors.push(`ep ${ep}: ${r?.error || "no stream"}`);
    }
  }
  return { episodes, errors };
}

// ── voir-anime (WordPress/Madara) — vidmoly-va source ────────────────────────
// voir-anime is a SEPARATE site from anime-sama with its own per-season slugs
// (shingeki-no-kyojin-vostfr, shingeki-no-kyojin-2-vostfr, …), so its episode
// embeds can't be derived from the anime-sama slug/season — the caller must
// pass the voir-anime slug (vaSlug). Flow mirrors getVoiranimeIframe in
// pages/api/v2/source/index.js: detail page → episode URL → thisChapterSources
// → the vidmoly iframe. Runs Redis/Turso-free (no player_map), all via Worker
// (voir-anime.to 403s data-center IPs the same way anime-sama does).
function buildVoirEpRegex(slug) {
  const slugEsc = slug.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const baseEsc = VOIRANIME_BASE.replace(/\./g, "\\.");
  // Episode URLs may sit under a short child-slug variant (…-a, …-2); the
  // episode number is the last -N before the trailing slash.
  return new RegExp(
    `href=["'](${baseEsc}/anime/${slugEsc}(?:-[a-z0-9]{1,3})?/[^"']+?-(\\d+)(?:-(?:vf|vostfr))?/)["']`,
    "gi",
  );
}

async function voirEpisodeUrl(slug, ep) {
  const html = await fetchPage(`${VOIRANIME_BASE}/anime/${slug}/`);
  const re = buildVoirEpRegex(slug);
  let m;
  while ((m = re.exec(html)) !== null) {
    if (parseInt(m[2], 10) === ep) return m[1];
  }
  return null;
}

async function voirVidmolyEmbed(episodeUrl) {
  const html = await fetchPage(episodeUrl);
  const sm = html.match(/thisChapterSources\s*=\s*({[\s\S]*?});/);
  if (!sm) return null;
  let sources;
  try { sources = JSON.parse(sm[1]); } catch { return null; }
  for (const iframeHtml of Object.values(sources)) {
    const src = String(iframeHtml).match(/<iframe\s+src=["']([^"']+)["']/i);
    if (src && /vidmoly/i.test(src[1])) return src[1];
  }
  return null;
}

async function resolveVoiranime(vaSlug, start, end) {
  const episodes = [];
  const errors = [];
  for (let ep = start; ep <= end; ep++) {
    try {
      const episodeUrl = await voirEpisodeUrl(vaSlug, ep);
      if (!episodeUrl) { errors.push(`ep ${ep}: not in voir-anime page`); continue; }
      const embed = await voirVidmolyEmbed(episodeUrl);
      if (!embed) { errors.push(`ep ${ep}: no vidmoly iframe`); continue; }
      const r = await extractVidmolyDirect(embed);
      if (!r.ok) { errors.push(`ep ${ep}: ${r.error}`); continue; }
      episodes.push({
        ep, url: r.url, isM3U8: true, host: "vidmoly-va", referer: r.referer,
      });
    } catch (e) {
      errors.push(`ep ${ep}: ${e.message}`);
    }
  }
  return { episodes, errors };
}

async function main() {
  const [slug, seasonDir, lang, startS, endS, hostPref, malId, vaSlug] = process.argv.slice(2);
  if (!slug || !seasonDir || !lang || !startS || !endS) {
    console.error("args: <slug> <seasonDir> <lang> <epStart> <epEnd> [hostPref] [malId]");
    process.exit(2);
  }
  const start = Number(startS), end = Number(endS);
  const priority = hostPref ? hostPref.split(",") : DEFAULT_PRIORITY;

  const out = { ok: false, host: null, episodes: [], errors: [] };

  // episodes.js is only needed for the anime-sama-sourced hosts. If megaplay
  // is the ONLY host requested, skip the fetch entirely rather than failing
  // the whole resolution over a page megaplay doesn't need.
  let arrays = [];
  // Only the anime-sama-sourced hosts need episodes.js. megaplay (MAL-built
  // URLs) and vidmoly-va (voir-anime-sourced) don't.
  const needsEpisodesJs = priority.some((h) => h !== "megaplay" && h !== "vidmoly-va");
  if (needsEpisodesJs) {
    try {
      const js = await fetchPage(`${BASE}/catalogue/${slug}/${seasonDir}/${lang}/episodes.js`);
      arrays = parseEpisodesJs(js);
    } catch (e) {
      out.errors.push(`episodes.js: ${e.message}`);
      // Only bail out here if nothing in the priority list can proceed
      // without episodes.js (i.e. no megaplay AND no vidmoly-va).
      if (!priority.includes("megaplay") && !priority.includes("vidmoly-va")) {
        console.log(JSON.stringify(out));
        return;
      }
    }
  }

  // Try each host in priority order; keep the first that resolves the WHOLE
  // requested range (so the series bank gets a consistent single-host cut).
  //
  // Diagnostics rule: `out.errors` ACCUMULATES across hosts and is never
  // overwritten. It used to be assigned only inside `episodes.length >
  // out.episodes.length`, so a host that resolved ZERO episodes (0 > 0 is
  // false) had its collected reasons silently dropped — total failure, the case
  // that most needs explaining, was the one case that explained nothing. That is
  // why every failing host reported `resolution failed: []` and nobody could
  // tell a blocked domain from a host the site simply doesn't offer.
  for (const hostKey of priority) {
    if (hostKey === "megaplay") {
      if (!malId) {
        out.errors.push("megaplay: no malId provided (7th arg)");
        continue;
      }
      const { episodes, errors } = await extractMegaplayRange(malId, lang, start, end);
      out.errors.push(...errors.map((e) => `${hostKey}: ${e}`));
      if (episodes.length === end - start + 1) {
        out.ok = true; out.host = hostKey; out.episodes = episodes;
        console.log(JSON.stringify(out));
        return;
      }
      if (episodes.length > out.episodes.length) {
        out.host = hostKey; out.episodes = episodes;
      }
      continue;
    }

    if (hostKey === "vidmoly-va") {
      if (!vaSlug) {
        out.errors.push("vidmoly-va: no vaSlug provided (8th arg)");
        continue;
      }
      const { episodes, errors } = await resolveVoiranime(vaSlug, start, end);
      out.errors.push(...errors.map((e) => `${hostKey}: ${e}`));
      if (episodes.length === end - start + 1) {
        out.ok = true; out.host = hostKey; out.episodes = episodes;
        console.log(JSON.stringify(out));
        return;
      }
      if (episodes.length > out.episodes.length) {
        out.host = hostKey; out.episodes = episodes;
      }
      continue;
    }

    const arr = pickArray(arrays, hostKey);
    if (!arr) {
      // NOT a failure: anime-sama simply doesn't list this player for this
      // season (SnK offers sibnet + uqload only, no sendvid/vidmoly). Saying so
      // distinguishes "nothing to resolve" from "resolution broke", which is the
      // difference between a data gap and a bug worth chasing.
      out.errors.push(`${hostKey}: not offered by anime-sama for this season`);
      continue;
    }
    const { episodes, errors } = await extractRange(arr, hostKey, start, end);
    out.errors.push(...errors.map((e) => `${hostKey}: ${e}`));
    if (episodes.length === end - start + 1) {
      out.ok = true; out.host = hostKey; out.episodes = episodes;
      console.log(JSON.stringify(out));
      return;
    }
    // Partial: remember the best attempt but keep trying other hosts.
    if (episodes.length > out.episodes.length) {
      out.host = hostKey; out.episodes = episodes;
    }
  }
  out.ok = out.episodes.length > 0;
  console.log(JSON.stringify(out));
}

main();
