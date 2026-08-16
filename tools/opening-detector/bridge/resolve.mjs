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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { getExtractor, extractMegaplay } from "../../../lib/extractors.js";
import { getPartsBySlug } from "../../../lib/multipartEpisodes.js";
import { playlistDurations } from "../../../lib/hlsMerge.js";

// proxy.aniscroll.com, NOT aniscroll-proxy.luc-deldem.workers.dev. The
// workers.dev route was retired when the proxy moved to the custom domain (the
// domain is required for edge caching), and Cloudflare answers a subdomain with
// no worker behind it with its own 404 "There is nothing here yet" page — a
// 19,984-byte HTML body, HTTP 404, for EVERY url. So `viaWorker` didn't degrade,
// it returned a hard failure on every call, and had been doing so silently for
// the whole top50 batch. Measured 2026-08-08: this URL 404s example.com.
const WORKER = "https://proxy.aniscroll.com";
const BASE = "https://anime-sama.to";
const VOIRANIME_BASE = "https://voir-anime.to";
// `ansembed.net` is Vidmoly white-labelled: the same embed page (its own
// <title>, cdn.staticmoly.me assets) serving the same …/hls2/…/master.m3u8.
// anime-sama lists it as a SEPARATE player, so it is an extra encode per title.
// It is also reachable where the vidmoly.* domains are DNS-blocked, which makes
// it the most dependable member of the family — hence first.
// `voembed.net` is the same story for voir-anime: since ~2026-08 its "LECTEUR
// myTV" panel serves voembed.net on newly published titles, vidmoly.biz on the
// back catalogue.
const VIDMOLY_DOMAINS = [
  "ansembed.net",
  "voembed.net",
  "vidmoly.net",
  "vidmoly.to",
  "vidmoly.biz",
];
// Every domain this family answers on: used to swap domains on retry, and to
// route an embed to the local Vidmoly extraction instead of the shared lib.
const VIDMOLY_HOST_RE = /(vidmoly\.(?:to|biz|net)|ansembed\.net|voembed\.net)/i;
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
    // Swap whichever domain of the family the embed arrived on — matching only
    // `vidmoly.*` meant an ansembed embed was never retried elsewhere (the URL
    // went out unchanged, so every "retry" hit the same host).
    const url = embedUrl.replace(VIDMOLY_HOST_RE, domain);
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

/* Sibnet's rate limit has to be remembered ACROSS processes, and that is not a
   detail — it is the whole difference between the memo working and not.
   The batch spawns one `node resolve.mjs` per (title, season, lang, host,
   episode-range), so a per-process memo is forgotten every few episodes and the
   run keeps knocking on a door it was just told to stop knocking on. Measured
   2026-08-08: the throttle answers 429 on every page and had not lifted after
   40 minutes, so the cost of ignoring it is the rest of the batch.

   A file with an expiry, not a lock: it never blocks anything permanently, and a
   crashed run leaves at worst a marker that expires on its own. */
const THROTTLE_FILE = new URL("../cache/sibnet-throttle", import.meta.url);
const THROTTLE_MS = 10 * 60 * 1000;

function sibnetThrottledUntil() {
  try {
    return Number(readFileSync(THROTTLE_FILE, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}
function markSibnetThrottled() {
  try {
    mkdirSync(new URL("../cache/", import.meta.url), { recursive: true });
    writeFileSync(THROTTLE_FILE, String(Date.now() + THROTTLE_MS));
  } catch {
    /* Best effort: losing the marker costs requests, never correctness. */
  }
}

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
      if (VIDMOLY_HOST_RE.test(embed)) {
        const v = await extractVidmolyDirect(embed);
        if (v.ok) return v;
        lastErr = v.error;
        continue;
      }
      const res = await getExtractor(embed)(embed);
      /* A rate limit is the ONE failure where retrying makes things worse: each
         attempt extends the window. Bail out immediately and tell the caller
         why, instead of spending the loop's four attempts on it. */
      if (res?.throttled) {
        markSibnetThrottled();
        return { ok: false, error: res.error || "rate limited", throttled: true };
      }
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
  const throttledUntil = hostKey === "sibnet" ? sibnetThrottledUntil() : 0;
  if (throttledUntil > Date.now()) {
    const left = Math.ceil((throttledUntil - Date.now()) / 1000);
    errors.push(`${hostKey}: debit limite (429), reprise dans ${left}s — aucune requete emise`);
    return { episodes, errors };
  }

  for (let ep = start; ep <= end; ep++) {
    const embed = arr[ep - 1];
    if (!embed) { errors.push(`ep ${ep}: no embed`); continue; }
    const r = await extractWithRetry(embed);
    if (r.throttled) {
      errors.push(`ep ${ep}: ${r.error}`);
      break; // le reste de la plage est condamne, ne pas le payer
    }
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

/**
 * The lettered URLs of a split episode (…-01a-vf/, …-01b-vf/), in the order
 * lib/multipartEpisodes.js declares — or null if any part is missing.
 *
 * Mirrors buildVoiranimeEpPartRegex in pages/api/v2/source/index.js. The
 * ordinary episode regex above cannot match these (it anchors on `-<digits>`
 * right before the trailing slash), which is exactly why a split episode
 * resolved to nothing here until now.
 */
async function voirEpisodePartUrls(slug, ep, parts) {
  const slugEsc = slug.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const baseEsc = VOIRANIME_BASE.replace(/\./g, "\\.");
  const re = new RegExp(
    `href=["'](${baseEsc}/anime/${slugEsc}(?:-[a-z0-9]{1,3})?/[^"']+?-(\\d+)([a-z])(?:-(?:vf|vostfr))?/)["']`,
    "gi",
  );
  const html = await fetchPage(`${VOIRANIME_BASE}/anime/${slug}/`);
  const found = new Map();
  let m;
  while ((m = re.exec(html)) !== null) {
    if (parseInt(m[2], 10) !== ep) continue;
    const letter = m[3].toLowerCase();
    if (!found.has(letter)) found.set(letter, m[1]);
  }
  const urls = parts.map((p) => found.get(p));
  return urls.every(Boolean) ? urls : null;
}

async function voirVidmolyEmbed(episodeUrl) {
  const html = await fetchPage(episodeUrl);
  const sm = html.match(/thisChapterSources\s*=\s*({[\s\S]*?});/);
  if (!sm) return null;
  let sources;
  try { sources = JSON.parse(sm[1]); } catch { return null; }
  for (const iframeHtml of Object.values(sources)) {
    const src = String(iframeHtml).match(/<iframe\s+src=["']([^"']+)["']/i);
    // voembed.net is the same myTV panel on a white-label domain — see
    // VIDMOLY_HOST_RE. Matching only "vidmoly" made every migrated title look
    // like it had no vidmoly-va source at all.
    if (src && VIDMOLY_HOST_RE.test(src[1])) return src[1];
  }
  return null;
}

// Where merged split-episode playlists are written. Kept under the tool's own
// cache/ (alongside cache/urls and cache/audio) so a wipe of that directory
// clears them too — they hold signed segment URLs and go stale on the same
// clock as the resolved URLs the adapter caches.
const MERGE_DIR = resolvePath(fileURLToPath(new URL("../cache/merged", import.meta.url)));

/**
 * Present a split episode to ffmpeg as ONE continuous 49-minute input, so the
 * detector measures the same timeline the player shows. Without it the OP/ED
 * timings found here would be relative to a 25-minute part and land nowhere
 * near the stream users actually watch.
 *
 * Uses the `concat` demuxer, NOT the merged HLS playlist the browser gets
 * (lib/hlsMerge.js). Both were measured on the real Re:Zero streams:
 *
 *   merged .m3u8 + #EXT-X-DISCONTINUITY   -ss 1600/2000/2900 → 0 bytes
 *   .ffconcat + per-entry `duration`      -ss 1600/2000/2900 → full window
 *
 * ffmpeg's HLS demuxer does not rebase part B's timestamps across the
 * discontinuity, so everything past the junction decodes empty; the concat
 * demuxer shifts each entry onto the previous one's end, which is exactly the
 * semantics we want. hls.js does handle the discontinuity, hence the split.
 *
 * The `duration` directives are load-bearing twice over: they give the input a
 * total length, without which `-sseof` (how the ED window is anchored) returns
 * nothing at all.
 *
 * Returns the absolute path of the .ffconcat.
 */
async function concatVoirParts(vaSlug, ep, masterUrls, referer) {
  mkdirSync(MERGE_DIR, { recursive: true });
  const durations = await playlistDurations(masterUrls, {
    fetchText: async (url) => {
      const r = await fetch(url, {
        headers: { "User-Agent": BROWSER_UA, Referer: referer || `${VOIRANIME_BASE}/` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
      return r.text();
    },
  });
  const body = ["ffconcat version 1.0"];
  masterUrls.forEach((url, i) => {
    body.push(`file ${url}`, `duration ${durations[i].toFixed(3)}`);
  });
  const path = join(MERGE_DIR, `${vaSlug}-ep${String(ep).padStart(2, "0")}.ffconcat`);
  writeFileSync(path, body.join("\n") + "\n", "utf-8");
  const total = durations.reduce((a, b) => a + b, 0);
  console.log(
    `[vidmoly-va] ep ${ep}: ${masterUrls.length} parts → ${Math.round(total)}s ` +
      `(${durations.map((d) => Math.round(d)).join(" + ")})`,
  );
  return path;
}

async function resolveVoiranime(vaSlug, start, end) {
  const episodes = [];
  const errors = [];
  for (let ep = start; ep <= end; ep++) {
    try {
      // Split episode (lib/multipartEpisodes.js): the parts ARE the episode —
      // there is no un-lettered URL for voirEpisodeUrl to find.
      const parts = getPartsBySlug(vaSlug, ep);
      if (parts) {
        const partUrls = await voirEpisodePartUrls(vaSlug, ep, parts);
        if (!partUrls) {
          errors.push(`ep ${ep}: split episode, parts ${parts.join("+")} not all on page`);
          continue;
        }
        const masters = [];
        let referer = null;
        let failed = null;
        for (const url of partUrls) {
          const embed = await voirVidmolyEmbed(url);
          if (!embed) { failed = `no vidmoly iframe on ${url}`; break; }
          const r = await extractVidmolyDirect(embed);
          if (!r.ok) { failed = r.error; break; }
          masters.push(r.url);
          referer = r.referer;
        }
        // All or nothing: half an episode would put every timing it produces
        // ~25 minutes out on the stream the player actually serves.
        if (failed) { errors.push(`ep ${ep}: ${failed}`); continue; }
        const list = await concatVoirParts(vaSlug, ep, masters, referer);
        episodes.push({
          // `isM3U8: false` — the input is an .ffconcat, not a playlist. The
          // consumers key their ffmpeg flags off the extension (oped/audio.py),
          // and passing HLS demuxer options to the concat demuxer is fatal
          // ("Option allowed_extensions not found"), so this must not lie.
          ep, url: list, isM3U8: false, host: "vidmoly-va", referer,
          parts: masters.length,
        });
        continue;
      }

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
