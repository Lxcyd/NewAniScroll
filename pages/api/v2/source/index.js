import { rateLimiterRedis, redis } from "@/lib/redis";
import * as cheerio from "cheerio";
import { getExtractor, extractMegaplay } from "@/lib/extractors";
import { getMediaMeta, primeMediaCache } from "@/lib/anilist/getMediaMeta";

/* Per-provider trace logger. Off by default â€” set DEBUG_SOURCE=1 in
   .env.local to see the chatty `[anime-sama]` / `[voiranime]` /
   `[animekai]` lines that used to spam the dev terminal every time the
   watch page resolved a stream. console.error stays unconditional. */
const DEBUG_SOURCE = process.env.DEBUG_SOURCE === "1";
const dlog = DEBUG_SOURCE ? console.log.bind(console) : () => {};

// Full Chrome desktop UA — anime-sama / voiranime reject the minimal "Mozilla/5.0"
// string on some endpoints (returns 403 or empty body) and we have no signal
// in the failure case. Using the same UA the m3u8 proxy already sends avoids
// that whole class of failure.
const SCRAPER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Bounded fetch: the Vercel function has a 10 s wall clock budget. A single
// hung upstream (anime-sama's catalogue page, a frozen episodes.js, voiranime's
// admin-ajax) would otherwise burn the entire budget and crash the whole probe
// chain. 5 s per request lets the slowest reasonable upstream finish while
// still leaving time for the extractor to run.
async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: options.signal || ctrl.signal,
      headers: {
        "User-Agent": SCRAPER_UA,
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(t);
  }
}

// anime-sama.to sits behind Cloudflare "I'm Under Attack" — every direct
// fetch from a Vercel AWS IP returns 403, so server-side scraping is dead
// in the water. The Cloudflare Worker that already proxies HLS segments
// runs on Cloudflare's own network, where anime-sama allows the request
// through. We route every anime-sama HTML fetch through the Worker so the
// scrape still works in production.
//
// PROXY_BASE defaults to the Cloudflare Worker (env var still overrides).
// anime-sama.to 403s direct Vercel fetches, so routing the scrape through the
// Worker's Cloudflare IPs is what makes server-side scraping work in prod.
// Hardcoded default (not "") because the env var proved unreliable — see
// UniversalPlayer for the full story.
const PROXY_BASE =
  process.env.NEXT_PUBLIC_PROXY_BASE ||
  "https://aniscroll-proxy.luc-deldem.workers.dev";

async function fetchViaWorker(targetUrl, options = {}, timeoutMs = 5000) {
  // No worker configured → fall back to a direct fetch. Useful for local
  // dev where the developer's IP isn't on Cloudflare's blocklist.
  if (!PROXY_BASE) return fetchWithTimeout(targetUrl, options, timeoutMs);
  const proxied = `${PROXY_BASE}?url=${encodeURIComponent(targetUrl)}`;
  return fetchWithTimeout(proxied, options, timeoutMs);
}

// Vidmoly-specific aliveness check. Anime-sama / voir-anime scrapes often
// return slugs vidmoly has since removed (file deleted, dmca, expired). Both
// my browser-side extractor AND the iframe fallback then show vidmoly's own
// "This video not found" page — useless for the user. A HEAD on vidmoly.biz
// distinguishes a dead slug (404) from a live one (200): vidmoly returns
// 404 to every requester for missing slugs, verified against curl from
// multiple network perspectives and the browser fetch in the failing case.
// Returns true when the slug is reachable, false when it's gone.
async function isVidmolyEmbedAlive(embedUrl) {
  const url = embedUrl.replace(/vidmoly\.(to|biz|net)/i, "vidmoly.biz");
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "HEAD",
        headers: { "User-Agent": SCRAPER_UA },
        redirect: "follow",
      },
      3000,
    );
    return res.status !== 404;
  } catch {
    // Network error → don't punish the chip; let the client try.
    return true;
  }
}

// Quick reachability probe for iframe-fallback URLs. Returns true if the URL
// (after following redirects) responds with 2xx/3xx that the browser would
// actually render — false if the embed slug 404s or the host is otherwise
// dead. We use this so a "degraded" chip never points at a black 404 page.
// For Vidmoly specifically we also try .biz/.net/.to in turn since anime-sama
// sometimes lists a slug under whichever variant they scraped from.
async function isIframeReachable(iframeUrl) {
  const candidates = /vidmoly\.(to|net|biz)/i.test(iframeUrl)
    ? ["vidmoly.biz", "vidmoly.net", "vidmoly.to"].map((d) =>
        iframeUrl.replace(/vidmoly\.(to|net|biz)/i, d),
      )
    : [iframeUrl];
  for (const url of candidates) {
    try {
      const res = await fetchWithTimeout(
        url,
        {
          method: "GET",
          headers: {
            "User-Agent": SCRAPER_UA,
            Accept: "text/html,application/xhtml+xml",
          },
          redirect: "follow",
        },
        4000,
      );
      // 4xx (excl 405) means the embed slug is gone from this host. 5xx is
      // transient — accept it. Off-host HTTP redirect (vidmoly.to → scam) is
      // also a reject.
      const finalUrl = new URL(res.url);
      if (finalUrl.protocol !== "https:") continue;
      if (res.status >= 400 && res.status < 500 && res.status !== 405) continue;
      return true;
    } catch {
      // network error — try next candidate
    }
  }
  return false;
}

// Hosts where server-side extraction returns a REAL playable stream â€” we pull
// the m3u8 / mp4 directly so the universal Vidstack player can play it (with
// our subtitle / cast / download chrome) instead of dropping back to an iframe.
//
// History note: smoothpre / movearnpre used to also serve a relative
// `/stream/.../master.m3u8` path which was a TIKTOK IMAGE TRAP (anti-bot
// detection â€” segments were JPEG URLs from tiktokcdn). The current extractor
// (extractMovearnpre) prefers the absolute hls2 source from their CDN
// (dramiyos-cdn / acek-cdn / mindbodywellness.space) which serves real .ts
// segments in 1080p/720p. Tokens last ~1.5h.
//
// Dingtezuni / callistanise share the same packed-JS embed format. They're
// included optimistically â€” extractor will return { error: ... } if they're
// not actually playable, and the caller falls back to the raw iframe.
const EXTRACTABLE_HOSTS = [
  "sibnet.ru",
  "sendvid.com",
  // vidmoly: extraction + playback both route through the CF Worker. As
  // long as the extracted-from IP and the segment-fetched-from IP match
  // (both = Worker), the IP-bound master token stays valid end-to-end and
  // the user plays in the Universal Player without an iframe.
  "vidmoly",
  "embed4me",
  "lpayer",        // lpayer.embed4me.com
  "smoothpre",     // hls2 CDN bypass (was TikTok-trapped via /stream/ path)
  "movearnpre",
  "dingtezuni",
  "callistanise",
  // VOE serves voe.sx → JS-redirect → mirror domain → obfuscated JSON payload.
  // The extractor follows the redirect chain and decodes the payload to a
  // signed master.m3u8. See lib/extractors.js → extractVoe.
  "voe.sx",
  "voe.",          // catches voe-network.net, voe-unblock.com, etc.
];

/**
 * POST /api/v2/source
 *
 * Body: { server, aniId, episode, sub }
 *   - server   : server id from lib/servers.js
 *   - aniId    : AniList anime id
 *   - episode  : episode number
 *   - sub      : "sub" | "dub"
 *
 * Returns: { streams, subtitles } OR { iframe } for embed-based servers
 */

const COOREN_BASE = process.env.COOREN_API_URL || "";

// â”€â”€ HiAnime (direct AJAX) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const HIANIME_BASE = "https://aniwatchtv.to";
const HIANIME_SERVERS = {
  "hianime-vidsrc": { name: "VidSrc", serverId: 4 },
  "hianime-megacloud": { name: "MegaCloud", serverId: 1 },
  "hianime-tcloud": { name: "T-Cloud", serverId: 6 },
};

async function getHiAnimeIframe(serverKey, title, episode, sub) {
  try {
    const serverDef = HIANIME_SERVERS[serverKey];
    if (!serverDef) return null;
    const category = sub === "dub" ? "dub" : "sub";

    // 1. Search for the anime
    const searchRes = await fetch(
      `${HIANIME_BASE}/search?keyword=${encodeURIComponent(title)}`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!searchRes.ok) return null;
    const searchHtml = await searchRes.text();
    const $s = cheerio.load(searchHtml);

    let animeUrl = $s(".film_list-wrap .flw-item .film-detail .film-name a").first().attr("href");
    if (!animeUrl) return null;
    animeUrl = animeUrl.split("?")[0]; // strip ?ref=search

    // 2. Get anime page to find the data-id
    const pageRes = await fetch(`${HIANIME_BASE}${animeUrl}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!pageRes.ok) return null;
    const pageHtml = await pageRes.text();
    const $p = cheerio.load(pageHtml);
    const animeDataId = $p("[data-id]").first().attr("data-id");
    if (!animeDataId) return null;

    // 3. Get episode list via AJAX
    const epRes = await fetch(
      `${HIANIME_BASE}/ajax/v2/episode/list/${animeDataId}`,
      { headers: { "X-Requested-With": "XMLHttpRequest", "Referer": `${HIANIME_BASE}${animeUrl}` } }
    );
    if (!epRes.ok) return null;
    const epData = await epRes.json();
    const $e = cheerio.load(epData.html);

    // Find the episode link matching the episode number
    let episodeDataId = null;
    $e(".ep-item").each((_, el) => {
      const num = $e(el).attr("data-number");
      if (String(num) === String(episode)) {
        episodeDataId = $e(el).attr("data-id");
      }
    });
    if (!episodeDataId) return null;

    // 3. Get server list for this episode
    const srvRes = await fetch(
      `${HIANIME_BASE}/ajax/v2/episode/servers?episodeId=${episodeDataId}`,
      { headers: { "X-Requested-With": "XMLHttpRequest", "Referer": HIANIME_BASE } }
    );
    if (!srvRes.ok) return null;
    const srvData = await srvRes.json();
    const $srv = cheerio.load(srvData.html);

    // Find the matching server data-id
    let sourceDataId = null;
    $srv(".server-item").each((_, el) => {
      const sid = $srv(el).attr("data-server-id");
      const type = $srv(el).attr("data-type");
      if (String(sid) === String(serverDef.serverId) && type === category) {
        sourceDataId = $srv(el).attr("data-id");
      }
    });
    if (!sourceDataId) return null;

    // 4. Get the iframe source link
    const srcRes = await fetch(
      `${HIANIME_BASE}/ajax/v2/episode/sources?id=${sourceDataId}`,
      { headers: { "X-Requested-With": "XMLHttpRequest", "Referer": HIANIME_BASE } }
    );
    if (!srcRes.ok) return null;
    const srcData = await srcRes.json();

    if (!srcData?.link) return null;

    return { iframe: srcData.link };
  } catch (e) {
    console.error(`HiAnime ${serverKey} error:`, e.message);
    return null;
  }
}

// â”€â”€ CoorenLabs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const COOREN_PROVIDERS = {
  "cooren-animepahe":  "animepahe",
  "cooren-animekai":   "animekai",
  "cooren-toonstream": "toonstream",
  "cooren-animesalt":  "animesalt",
};

async function getCoorenStream(providerKey, title, episode, sub) {
  if (!COOREN_BASE) return null;

  try {
    const provider = COOREN_PROVIDERS[providerKey];
    if (!provider) return null;

    if (provider === "animepahe")  return await getCoorenAnimePahe(title, episode, sub);
    if (provider === "animekai")   return await getCoorenAnimekai(title, episode, sub);
    if (provider === "toonstream") return await getCoorenToonstream(title, episode);
    if (provider === "animesalt")  return await getCoorenAnimesalt(title, episode);

    return null;
  } catch (e) {
    console.error(`Cooren ${providerKey} error:`, e.message);
    return null;
  }
}

// â”€â”€ Toonstream â€” series + episode â†’ m3u8 sources â”€â”€
async function getCoorenToonstream(title, episode) {
  const searchRes = await fetch(
    `${COOREN_BASE}/anime/toonstream/search/${encodeURIComponent(title)}`
  );
  if (!searchRes.ok) return null;
  const searchData = await searchRes.json();
  const series = searchData?.results?.[0] || searchData?.[0] || null;
  if (!series?.slug && !series?.id) return null;

  const slug = series.slug || series.id;
  const infoRes = await fetch(
    `${COOREN_BASE}/anime/toonstream/series/info/${encodeURIComponent(slug)}`
  );
  if (!infoRes.ok) return null;
  const infoData = await infoRes.json();
  const episodes = infoData?.episodes || infoData?.results || [];
  const ep = episodes.find(
    (e) => Number(e.number ?? e.episode) === Number(episode)
  ) || episodes[Number(episode) - 1];
  if (!ep?.slug && !ep?.id) return null;

  const epSlug = ep.slug || ep.id;
  const srcRes = await fetch(
    `${COOREN_BASE}/anime/toonstream/episode/sources/${encodeURIComponent(epSlug)}`
  );
  if (!srcRes.ok) return null;
  const srcData = await srcRes.json();
  const sources = srcData?.sources || srcData?.results || [];
  if (!sources.length) return null;

  return {
    streams: sources
      .filter((s) => s.url || s.file)
      .map((s) => ({
        url: s.url || s.file,
        quality: s.quality || s.label || "default",
        isM3U8: (s.url || s.file || "").includes(".m3u8"),
      })),
    subtitles: (srcData?.subtitles || []).map((s) => ({
      file: s.url || s.file,
      label: s.lang || s.label || "Subtitle",
      kind: s.kind || "captions",
    })),
    referer: srcData?.headers?.Referer || null,
  };
}

// â”€â”€ Animesalt â€” same shape as Toonstream â”€â”€
async function getCoorenAnimesalt(title, episode) {
  const searchRes = await fetch(
    `${COOREN_BASE}/anime/animesalt/search/${encodeURIComponent(title)}`
  );
  if (!searchRes.ok) return null;
  const searchData = await searchRes.json();
  const series = searchData?.results?.[0] || searchData?.[0] || null;
  if (!series?.slug && !series?.id) return null;

  const slug = series.slug || series.id;
  const infoRes = await fetch(
    `${COOREN_BASE}/anime/animesalt/series/info/${encodeURIComponent(slug)}`
  );
  if (!infoRes.ok) return null;
  const infoData = await infoRes.json();
  const episodes = infoData?.episodes || infoData?.results || [];
  const ep = episodes.find(
    (e) => Number(e.number ?? e.episode) === Number(episode)
  ) || episodes[Number(episode) - 1];
  if (!ep?.slug && !ep?.id) return null;

  const epSlug = ep.slug || ep.id;
  const srcRes = await fetch(
    `${COOREN_BASE}/anime/animesalt/episode/sources/${encodeURIComponent(epSlug)}`
  );
  if (!srcRes.ok) return null;
  const srcData = await srcRes.json();
  const sources = srcData?.sources || srcData?.results || [];
  if (!sources.length) return null;

  return {
    streams: sources
      .filter((s) => s.url || s.file)
      .map((s) => ({
        url: s.url || s.file,
        quality: s.quality || s.label || "default",
        isM3U8: (s.url || s.file || "").includes(".m3u8"),
      })),
    subtitles: (srcData?.subtitles || []).map((s) => ({
      file: s.url || s.file,
      label: s.lang || s.label || "Subtitle",
      kind: s.kind || "captions",
    })),
    referer: srcData?.headers?.Referer || null,
  };
}

async function getCoorenAnimePahe(title, episode, sub) {
  const searchRes = await fetch(
    `${COOREN_BASE}/anime/animepahe/search/${encodeURIComponent(title)}`
  );
  if (!searchRes.ok) return null;
  const searchData = await searchRes.json();

  const anime =
    searchData?.results?.[0] || searchData?.data?.results?.[0] || null;
  if (!anime?.session && !anime?.id) return null;

  const animeId = anime.session || anime.id;

  // Get episodes
  const epRes = await fetch(
    `${COOREN_BASE}/anime/animepahe/episodes/${animeId}`
  );
  if (!epRes.ok) return null;
  const epData = await epRes.json();

  const episodes = epData?.data || epData?.results || epData || [];
  const ep = Array.isArray(episodes)
    ? episodes.find((e) => e.episode === Number(episode) || e.number === Number(episode))
    : null;
  if (!ep?.session) return null;

  // Get stream - returns NDJSON
  const streamRes = await fetch(
    `${COOREN_BASE}/anime/animepahe/episode/${animeId}/${ep.session}`
  );
  if (!streamRes.ok) return null;
  const text = await streamRes.text();

  // Parse NDJSON lines
  const sources = text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);

  // Filter by sub/dub preference
  const filtered = sources.filter((s) =>
    sub === "dub" ? s.isDub === true : s.isDub !== true
  );
  const best = filtered.length > 0 ? filtered : sources;

  return {
    streams: best.map((s) => ({
      url: s.directUrl || s.url,
      quality: s.quality || s.resolution || "default",
    })),
    // Pass corsHeaders so the client proxy can use them
    referer: best[0]?.corsHeaders?.Referer || null,
  };
}

async function getCoorenAnimekai(title, episode, sub) {
  const searchRes = await fetch(
    `${COOREN_BASE}/anime/animekai/search/${encodeURIComponent(title)}`
  );
  if (!searchRes.ok) return null;
  const searchData = await searchRes.json();

  const anime = searchData?.results?.[0] || null;
  if (!anime?.id) return null;

  // Get info + episodes (path param, not query string)
  const infoRes = await fetch(
    `${COOREN_BASE}/anime/animekai/info/${encodeURIComponent(anime.id)}`
  );
  if (!infoRes.ok) return null;
  const infoData = await infoRes.json();

  const episodes = infoData?.episodes || [];
  const ep = episodes.find(
    (e) => e.number === Number(episode)
  );
  if (!ep?.id) return null;

  dlog(`[animekai] Episode ID: ${ep.id}`);

  // Get stream sources â€” returns { results: [{ sources, subtitles, name }] }
  const watchRes = await fetch(
    `${COOREN_BASE}/anime/animekai/watch/${encodeURIComponent(ep.id)}${
      sub === "dub" ? "?dub=true" : ""
    }`
  );
  if (!watchRes.ok) return null;
  const watchData = await watchRes.json();

  // Each result has its own sources/subtitles â€” merge all
  const results = watchData?.results || [];
  if (results.length === 0) return null;

  const allStreams = [];
  const allSubtitles = [];
  for (const r of results) {
    const sources = r.sources || [];
    const subs = r.subtitles || [];
    for (const s of sources) {
      allStreams.push({ url: s.url, quality: r.name || "default" });
    }
    for (const s of subs) {
      if (!allSubtitles.find((x) => x.label === (s.lang || s.label))) {
        allSubtitles.push({
          file: s.url || s.file,
          label: s.lang || s.label,
          kind: s.kind || "captions",
        });
      }
    }
  }

  return {
    streams: allStreams,
    subtitles: allSubtitles,
    referer: "https://megaup.cc/",
  };
}

// â”€â”€ Anime-Sama (VF + VOSTFR) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const ANIMESAMA_BASE = "https://anime-sama.to";
// In-memory caches to avoid AniList rate limits from parallel pre-check probes
const seasonCache = new Map();
const slugCache = new Map();
const ANIMESAMA_SERVERS = {
  // VF (French dub)
  "animesama-sibnet":       { name: "Sibnet",      preferred: ["sibnet.ru"],                              lang: "vf" },
  "animesama-sendvid":      { name: "Sendvid",     preferred: ["sendvid.com"],                            lang: "vf" },
  "animesama-vidmoly":      { name: "Vidmoly",     preferred: ["vidmoly.to", "vidmoly.biz", "vidmoly.net"], lang: "vf" },
  "animesama-embed4me":     { name: "Embed4Me",    preferred: ["embed4me.com", "lpayer"],                 lang: "vf" },
  "animesama-callistanise": { name: "Player",      preferred: ["callistanise.com", "dingtezuni.com", "movearnpre.com"], lang: "vf" },
  // VOSTFR (Japanese + French subs)
  "animesama-sibnet-vo":       { name: "Sibnet",      preferred: ["sibnet.ru"],                              lang: "vostfr" },
  "animesama-sendvid-vo":      { name: "Sendvid",     preferred: ["sendvid.com"],                            lang: "vostfr" },
  "animesama-vidmoly-vo":      { name: "Vidmoly",     preferred: ["vidmoly.to", "vidmoly.biz", "vidmoly.net"], lang: "vostfr" },
  "animesama-embed4me-vo":     { name: "Embed4Me",    preferred: ["embed4me.com", "lpayer"],                 lang: "vostfr" },
  "animesama-callistanise-vo": { name: "Player",      preferred: ["callistanise.com", "dingtezuni.com", "movearnpre.com"], lang: "vostfr" },
};

async function getAnimeSamaIframe(serverKey, title, episode, aniId) {
  try {
    const serverDef = ANIMESAMA_SERVERS[serverKey];
    if (!serverDef) return null;

    const langPath = serverDef.lang === "vostfr" ? "vostfr" : "vf";

    // 1. Detect which season this AniList ID represents
    const seasonNum = await detectSeasonNumber(aniId);
    dlog(`[anime-sama] AniList ${aniId} â†’ detected season ${seasonNum}`);

    // 2. Search anime-sama â€” use romaji title first, then try french
    const slug = await findAnimeSamaSlug(title, aniId);
    if (!slug) {
      console.error(`[anime-sama] ${serverKey} aniId=${aniId} title="${title}" slug NOT FOUND`);
      return null;
    }
    dlog(`[anime-sama] Found slug: ${slug} (${langPath})`);

    // 3. Try to find the right season/episode
    // Fetch the anime detail page to get season list (routed via worker —
    // anime-sama.to 403s direct Vercel fetches).
    const detailRes = await fetchViaWorker(`${ANIMESAMA_BASE}/catalogue/${slug}/`);
    if (!detailRes.ok) {
      console.error(`[anime-sama] ${serverKey} detail page ${detailRes.status} for slug=${slug}`);
      return null;
    }
    const detailHtml = await detailRes.text();

    // Extract panneauAnime() calls to find available seasons
    const seasonMatches = [...detailHtml.matchAll(/panneauAnime\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g)];
    dlog(`[anime-sama] Found ${seasonMatches.length} seasons`);

    // Build season list from panneauAnime calls â€” use sequential ordinals (1,2,3,4...)
    // NOT the season number from the path (since "saison3-2" is a separate entry from "saison3").
    // Also extract any 4-digit year from the label (e.g. "Version 2011" â†’ 2011) so we can
    // match against AniList's seasonYear/startDate when multiple versions exist.
    const seasons = seasonMatches
      .map((m) => {
        const path = m[2]; // e.g. "saison1/vostfr", "saison3-2/vostfr", "film/vostfr"
        // Accept saisonN dirs AND non-season content dirs (film/oav/special/
        // scan). Films are stored as panneauAnime("Film","film/vostfr") with
        // NO "saison" prefix — the old saison-only regex dropped them, so movie
        // entries never resolved a player. We keep them as season-like slots
        // (ordinal-numbered) so a MOVIE AniList id maps onto the film panel.
        const dirMatch = path.match(/^(saison[^/]+|film[^/]*|oav[^/]*|special[^/]*|scan[^/]*)\//i);
        if (!dirMatch) return null;
        const yearMatch = m[1].match(/\b(19|20)\d{2}\b/);
        return {
          label: m[1],
          dir: dirMatch[1],
          path: m[2],
          year: yearMatch ? parseInt(yearMatch[0], 10) : null,
          isFilm: /^film/i.test(dirMatch[1]),
        };
      })
      .filter(Boolean)
      .map((s, i) => ({ ...s, ordinal: i + 1 }));

    if (seasons.length === 0) {
      seasons.push({ label: "Saison 1", ordinal: 1, dir: "saison1", path: `saison1/${langPath}` });
    }

    // Shared AniList metadata (cached) — reused for movie detection, year and
    // title matching below.
    const meta = await getMediaMeta(aniId);

    // Movies: when AniList says this is a MOVIE and a film panel exists, target
    // it directly — season ordinals don't apply (a film isn't "season N").
    const isMovie = meta?.format === "MOVIE";
    const filmSeason = seasons.find((s) => s.isFilm);

    dlog(`[anime-sama] Seasons: ${seasons.map((s) => `${s.ordinal}=${s.dir}${s.year ? `(${s.year})` : ""}`).join(", ")}`);

    // 3.5. YEAR MATCHING â€” if multiple seasons have explicit years and AniList
    // gave us a year, prefer the season whose year matches. Solves the HxH
    // 1999-vs-2011 case where they share the same slug.
    const aniYear = meta?.seasonYear || meta?.startDate?.year || null;
    let yearMatchedSeason = null;
    if (aniYear) {
      yearMatchedSeason = seasons.find((s) => s.year === aniYear);
      if (yearMatchedSeason) {
        dlog(`[anime-sama] Year match: AniList ${aniYear} â†’ ${yearMatchedSeason.dir}`);
      }
    }

    // 3.6. TITLE MATCHING â€” prefer the panneau whose label is most similar to
    // the AniList title. Solves the "Baki Hanma saison 1" vs "Baki Hanma saison 2"
    // case where the PREQUEL chain over-counts because AniList's chain
    // includes ONAs that anime-sama merges into a single panneau slot.
    //
    // Score = token-overlap between panneau label and AniList titles, with a
    // small bonus for matching the season suffix ("saison 1" â†’ bonus when
    // AniList title doesn't have a "Season N" hint, "saison 2" â†’ bonus when
    // AniList title has "Season 2" / "2nd Season" / "Part 2").
    const aniTitles = [
      meta?.title?.romaji,
      meta?.title?.english,
      ...(meta?.synonyms || []),
    ].filter(Boolean);
    const aniSeasonHint = (() => {
      const t = `${meta?.title?.romaji || ""} ${meta?.title?.english || ""}`;
      const m = t.match(/\b(?:season|part|saison)\s*(\d+)\b|(\d+)(?:st|nd|rd|th)\s*season/i);
      if (!m) return null;
      return parseInt(m[1] || m[2], 10);
    })();
    let titleMatchedSeason = null;
    if (aniTitles.length > 0 && seasons.length > 1) {
      let best = { season: null, score: 0 };
      for (const s of seasons) {
        let bestForSeason = 0;
        for (const t of aniTitles) {
          const sc = scoreSlugAgainstTitle(s.label, t);
          if (sc > bestForSeason) bestForSeason = sc;
        }
        // Tie-breaker on the panneau's own "saison N" suffix vs AniList hint.
        const labelSeasonMatch = s.label.match(/saison\s*(\d+)/i);
        const labelSeasonNum = labelSeasonMatch ? parseInt(labelSeasonMatch[1], 10) : null;
        if (aniSeasonHint != null && labelSeasonNum === aniSeasonHint) {
          bestForSeason += 5; // strong signal
        } else if (aniSeasonHint == null && labelSeasonNum === 1) {
          bestForSeason += 1; // mild bias toward "saison 1" when no hint
        }
        if (bestForSeason > best.score) best = { season: s, score: bestForSeason };
      }
      if (best.season && best.score > 0) {
        titleMatchedSeason = best.season;
        dlog(`[anime-sama] Title match: "${best.season.label}" (score ${best.score})`);
      }
    }

    // 4. If we detected a specific season from AniList, go directly to it
    const episodeIndex = Number(episode) - 1;
    let iframeUrl = null;

    // Priority: MOVIE → film panel > explicit year match > title match >
    // PREQUEL ordinal. A MOVIE AniList id has no meaningful season ordinal, so
    // when the catalogue carries a "film" panel we go straight to it; this is
    // what was missing for films like Le Château ambulant (the panel existed
    // but the saison-only parser dropped it and ordinal logic never reached it).
    const directTarget = (isMovie && filmSeason) ||
      yearMatchedSeason ||
      titleMatchedSeason ||
      (seasonNum > 1 ? seasons.find((s) => s.ordinal === seasonNum) : null);

    if (directTarget) {
      const targetSeason = directTarget;
      // Films are often single-language (e.g. only "film/vostfr"). For a film
      // panel use the language baked into its own panneau path rather than the
      // requested langPath, so a VF request for a VOSTFR-only film still
      // resolves instead of 404ing on a non-existent "film/vf".
      const targetLang = targetSeason.isFilm
        ? (targetSeason.path.split("/")[1] || langPath)
        : langPath;
      const epPath = `${ANIMESAMA_BASE}/catalogue/${slug}/${targetSeason.dir}/${targetLang}/episodes.js`;
      dlog(`[anime-sama] Direct season ${targetSeason.dir} (${yearMatchedSeason ? `year ${aniYear}` : `ordinal ${seasonNum}`}): ${epPath}`);

      const epRes = await fetchViaWorker(epPath);
      if (epRes.ok) {
        const jsContent = await epRes.text();
        const episodeArrays = parseEpisodesJs(jsContent);
        if (episodeArrays.length > 0) {
          const bestArray = findPreferredArray(episodeArrays, serverDef.preferred);
          if (bestArray && episodeIndex >= 0 && episodeIndex < bestArray.length) {
            iframeUrl = bestArray[episodeIndex];
            dlog(`[anime-sama] Found ep ${episode} in ${targetSeason.dir}: ${iframeUrl}`);
          }
        }
      } else {
        console.error(`[anime-sama] ${serverKey} episodes.js ${epRes.status} for ${epPath}`);
      }
    }

    // 5. Fallback: cumulative season iteration (only if year/PREQUEL didn't match)
    // KEY: episode count comes from the canonical (first) array, not the host-specific one.
    // Otherwise, when the requested host isn't in season N, we'd skip ahead and incorrectly
    // return episode 1 of a later season (e.g. One Piece OneUpload â†’ saison9 ep 1).
    //
    // SAFETY: if we already had an explicit year/title match for the season
    // but the requested host wasn't available there, do NOT fall through to
    // the cumulative search â€” iterating other seasons of the SAME slug can
    // accidentally jump into a different era's panneau (e.g. Hunter x Hunter:
    // the 2011 slug has its own saisons, and if Sibnet is missing on saison1
    // the old code would happily walk into a "Films" or "OAV" panneau of the
    // 1999 series under the same slug). Better to return null and let the UI
    // mark this server as unavailable than to serve the wrong content.
    if (!iframeUrl && !directTarget) {
      let cumulativeEps = 0;
      for (const season of seasons) {
        const epPath = `${ANIMESAMA_BASE}/catalogue/${slug}/${season.dir}/${langPath}/episodes.js`;
        dlog(`[anime-sama] Trying: ${epPath}`);

        const epRes = await fetchViaWorker(epPath);
        if (!epRes.ok) {
          dlog(`[anime-sama] No ${langPath.toUpperCase()} for ${season.dir}`);
          continue;
        }

        const jsContent = await epRes.text();
        const episodeArrays = parseEpisodesJs(jsContent);
        if (episodeArrays.length === 0) continue;

        // Canonical episode count = max length across all host arrays in this season.
        // This keeps cumulative numbering correct regardless of host availability.
        const canonicalCount = Math.max(...episodeArrays.map((a) => a.length));
        const localIndex = episodeIndex - cumulativeEps;

        if (localIndex >= 0 && localIndex < canonicalCount) {
          // This is the right season for the requested episode.
          // Now check if the requested host is available in THIS season.
          const bestArray = findPreferredArray(episodeArrays, serverDef.preferred);
          if (bestArray && localIndex < bestArray.length) {
            iframeUrl = bestArray[localIndex];
            dlog(`[anime-sama] Found ep ${episode} in ${season.dir}: ${iframeUrl}`);
          } else {
            dlog(`[anime-sama] ${season.dir} has ep ${episode} but not on ${serverDef.preferred[0] || serverDef.preferred}`);
          }
          break; // Right season found; don't keep looking
        }
        cumulativeEps += canonicalCount;
      }
    }

    if (!iframeUrl) {
      console.error(`[anime-sama] ${serverKey} no iframe for ep=${episode} slug=${slug} (seasons=${seasons.length})`);
      return null;
    }

    // Per-host iframe rewriting before extraction.
    // - vidmoly.to currently 302s to a HTTP survey scam. extractVidmoly
    //   iterates the .net/.to/.biz triple itself, so we just pick a safe
    //   variant here for the extraction entry point.
    if (/vidmoly\.to/i.test(iframeUrl)) {
      iframeUrl = iframeUrl.replace(/vidmoly\.to/i, "vidmoly.net");
    }

    // Server-side extraction. Preferred path → Universal Player (custom
    // chrome, subs, skip overlay, ambient lights). When the extractor fails
    // OR the host isn't extractable, hand back the raw iframe with
    // `degraded: true`. The chip stays visible (red in the selector) so
    // the user can still click to try the host's own player — better than
    // hiding it on a guess, even when the embed slug might be dead.
    // EXCEPTION: Sibnet sends X-Frame-Options DENY on the embed page, so a
    // sibnet iframe just produces "refused to connect". Keep hiding those.
    const lower = iframeUrl.toLowerCase();

    // Vidmoly bypasses server-side extraction entirely: the master.m3u8 token
    // is IP-bound, and routing it through any proxy (CF Worker, Fly, Vercel
    // FOT) costs bandwidth and a guaranteed IP-mismatch the moment one tier
    // 410s. Instead we hand the client the embed URL and let it fetch the
    // page itself — token then binds to the user's IP and segments stream
    // directly from the vidmoly CDN with no proxy. vidmoly.biz reflects any
    // Origin in Access-Control-Allow-Origin (verified), so the browser fetch
    // succeeds. If client extraction fails (CORS on the CDN, no source in
    // HTML, etc.), UniversalPlayer falls back to the iframe.
    if (lower.includes("vidmoly")) {
      // Aniwsama tends to keep dead vidmoly slugs in its catalogue for weeks
      // after the file is deleted. Probe before serving the chip so a dead
      // slug yields "server unavailable" instead of vidmoly's own 404 page.
      if (!(await isVidmolyEmbedAlive(iframeUrl))) {
        dlog(`[anime-sama] vidmoly slug 404 — hiding chip: ${iframeUrl}`);
        return null;
      }
      return {
        clientExtract: { type: "vidmoly", embedUrl: iframeUrl },
        iframe: iframeUrl,
      };
    }

    if (EXTRACTABLE_HOSTS.some((h) => lower.includes(h))) {
      // TEMP diagnostic — remove once Sibnet behaviour stops surprising us.
      if (lower.includes("sibnet")) {
        console.error(
          `[sibnet-trace] ${serverKey} aniId=${aniId} ep=${episode} slug=${slug} iframeUrl=${iframeUrl}`,
        );
      }
      const extractor = getExtractor(iframeUrl);
      const result = await extractor(iframeUrl);
      if (lower.includes("sibnet")) {
        const out = result.streams?.[0]?.url || `ERROR:${result.error}`;
        console.error(`[sibnet-trace] ${serverKey} resolved → ${out}`);
      }
      if (result.streams?.length) {
        dlog(`[anime-sama] Extracted stream for ${serverKey}: ${result.streams[0].url}`);
        return result;
      }
      dlog(`[anime-sama] Extraction failed for ${serverKey}: ${result.error}`);
      if (lower.includes("sibnet")) return null;
    }
    return { iframe: iframeUrl, degraded: true, reason: "extraction failed" };
  } catch (e) {
    console.error(`anime-sama ${serverKey} error:`, e.message);
    return null;
  }
}

/**
 * Detect which season number an AniList ID represents by walking the PREQUEL chain.
 * Uses the shared Media cache â€” a single AniList fetch covers title, synonyms,
 * AND relations, so we don't need separate calls for each scraper helper.
 *
 * We accept TV, ONA, OVA and TV_SHORT prequels because anime-sama / voir-anime
 * list those alongside main TV seasons (e.g. Baki Hanma is `format=ONA` on
 * AniList â€” filtering to TV-only would walk the chain wrong and return season=1
 * for a 4th-entry anime, dropping the user on the wrong show entirely).
 *
 * MOVIE / SPECIAL / MUSIC are still excluded â€” those don't increment the
 * "season" counter on either site (films get their own slug or `film/` path).
 */
const PREQUEL_FORMATS = new Set(["TV", "ONA", "OVA", "TV_SHORT"]);

/**
 * Does `prequel` look like an actual PREVIOUS SEASON of `current`, rather than
 * an unrelated spin-off AniList happens to tag as a prequel?
 *
 * AniList's PREQUEL edges aren't all "season N-1": One Piece (id 21) lists the
 * 1-episode ONA "MONSTERS: Ippaku Sanjou Hiryuu Jigoku" (an Oda one-shot) as a
 * prequel, so a blind walk returns season=2 and we'd serve every One Piece
 * episode from the wrong saga. A genuine previous season shares the franchise
 * title; a spin-off doesn't. We require a meaningful shared title token before
 * counting the edge.
 */
function looksLikePreviousSeason(currentTitles, prequelTitles) {
  for (const cur of currentTitles) {
    for (const prev of prequelTitles) {
      if (scoreSlugAgainstTitle(prev, cur) > 0) return true;
    }
  }
  return false;
}

async function detectSeasonNumber(aniId) {
  const cacheKey = String(aniId);
  if (seasonCache.has(cacheKey)) return seasonCache.get(cacheKey);

  let season = 1;
  let currentId = Number(aniId);
  const visited = new Set();

  const titlesOf = (m) =>
    [m?.title?.romaji, m?.title?.english, m?.title?.native].filter(Boolean);

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const media = await getMediaMeta(currentId);
    if (!media) break;
    const edges = media.relations?.edges || [];
    const prequel = edges.find(
      (e) => e.relationType === "PREQUEL" && PREQUEL_FORMATS.has(e.node?.format)
    );
    // Only follow the prequel when it actually reads as a previous season of
    // the SAME franchise (shared title token). This stops spin-off ONAs/OVAs
    // (One Piece's "MONSTERS", recap shorts, side-stories) from inflating the
    // season count and routing episodes to the wrong saga.
    if (prequel && looksLikePreviousSeason(titlesOf(media), titlesOf(prequel.node))) {
      season++;
      currentId = prequel.node.id;
    } else {
      break;
    }
  }

  seasonCache.set(cacheKey, season);
  return season;
}

// Normalize a title for similarity scoring: lowercase, strip diacritics +
// punctuation, collapse whitespace. Yields a comparable token bag.
function normalizeForMatch(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// How well does a candidate slug (e.g. "baki", "baccano") match a target
// title? Measured as token overlap weighted by token length.
//   "baki" vs target "baki hanma"  â†’ 1 token match (baki, len 4) â†’ score 4
//   "baccano" vs target "baki hanma" â†’ 0 token match â†’ score 0
function scoreSlugAgainstTitle(slug, target) {
  const a = new Set(normalizeForMatch(slug.replace(/-/g, " ")).split(" ").filter(Boolean));
  const b = normalizeForMatch(target).split(" ").filter(Boolean);
  let score = 0;
  for (const tok of b) {
    if (a.has(tok)) score += tok.length;
  }
  return score;
}

async function findAnimeSamaSlug(title, aniId) {
  const cacheKey = `${aniId}-${title}`;
  if (slugCache.has(cacheKey)) return slugCache.get(cacheKey);

  // Strip season suffixes to find the base anime on anime-sama
  const stripSeason = (t) =>
    t?.replace(/\s*(Season\s*\d+|\d+(st|nd|rd|th)\s*Season|Part\s*\d+|\d+æœŸ)\s*/gi, "").trim();

  // Try searching with the title directly, plus a stripped version
  const queries = [title];
  const stripped = stripSeason(title);
  if (stripped && stripped !== title) queries.push(stripped);

  // Reuse the shared AniList cache (no extra request when SSR already populated it)
  const media = await getMediaMeta(aniId);
  if (media) {
    if (media.synonyms) queries.push(...media.synonyms);
    if (media.title?.english && !queries.includes(media.title.english))
      queries.push(media.title.english);
    if (media.title?.romaji && !queries.includes(media.title.romaji))
      queries.push(media.title.romaji);
    for (const t of [media.title?.english, media.title?.romaji]) {
      const s = stripSeason(t);
      if (s && !queries.includes(s)) queries.push(s);
    }
  }

  // Build the set of titles we'll score candidates against. We don't strip
  // here â€” we want "Hanma Baki" to match "baki" via token overlap, not via
  // string equality.
  const targets = [
    title,
    media?.title?.english,
    media?.title?.romaji,
    stripped,
    ...((media?.synonyms) || []),
  ].filter(Boolean);

  // Year hint from AniList (e.g. 2011 for Hunter x Hunter remake). Used
  // below as a *strong* tie-break so the "hunter-x-hunter-2011" slug wins
  // over the canonical "hunter-x-hunter" slug (1999) when both come back
  // from the search. Without this, the shorter-slug tie-breaker silently
  // picks the wrong era and we end up serving 1999 episodes for an
  // AniList ID that represents the 2011 remake.
  const aniYear =
    media?.seasonYear || media?.startDate?.year || null;

  // Score every candidate seen across all queries; return the best.
  // Anime-Sama no longer reliably tags "VF" in search results, so we ignore
  // language and rely on token-overlap scoring against the AniList titles.
  // Reject scores of 0 â€” those are unrelated catalogue entries (Baccano vs
  // Baki Hanma) that the search returned because of a fuzzy match on letters.
  const candidates = new Map(); // slug â†’ best score
  for (const q of queries) {
    let searchRes;
    try {
      searchRes = await fetchViaWorker(
        `${ANIMESAMA_BASE}/catalogue/?search=${encodeURIComponent(q)}`,
      );
    } catch (e) {
      console.error(`[anime-sama] search "${q}" failed:`, e.message);
      continue;
    }
    if (!searchRes.ok) {
      console.error(`[anime-sama] search "${q}" HTTP ${searchRes.status}`);
      continue;
    }
    const html = await searchRes.text();
    const $ = cheerio.load(html);

    $("a[href*='/catalogue/']").each((_, el) => {
      const href = $(el).attr("href") || "";
      const m = href.match(/\/catalogue\/([a-z0-9-]+)\/?$/);
      if (!m) return;
      const slug = m[1];
      // Best score for this slug against any of the AniList titles.
      let best = 0;
      for (const t of targets) {
        const s = scoreSlugAgainstTitle(slug, t);
        if (s > best) best = s;
      }
      if (best > (candidates.get(slug) || 0)) candidates.set(slug, best);
    });
  }

  // Pick the highest-scoring slug.
  //
  // Tie-break order (most specific â†’ least specific):
  //   1. Slug contains the AniList year (handles remakes like
  //      hunter-x-hunter vs hunter-x-hunter-2011 where the year-suffixed
  //      slug is a SEPARATE catalogue entry, not a panneau of the base).
  //   2. Slug contains any other 4-digit year that does NOT match â€”
  //      penalise it so we don't pick "-2011" when AniList year is 1999.
  //   3. Shortest slug wins (canonical entry: "baki" over
  //      "baki-hanma-special-fan-edit").
  const yearStr = aniYear ? String(aniYear) : null;
  const slugYearMatch = (slug) => {
    const m = slug.match(/-(\d{4})(?:-|$)/);
    if (!m) return null;
    return parseInt(m[1], 10);
  };

  let chosen = null;
  let chosenScore = -Infinity;
  for (const [slug, score] of candidates) {
    if (score === 0) continue;
    const slugYear = slugYearMatch(slug);
    // Composite score: token-overlap is the base, year alignment is a
    // strong boost / penalty so it dominates the tie-breaker.
    let composite = score;
    if (yearStr && slugYear === aniYear) composite += 100;
    else if (yearStr && slugYear && slugYear !== aniYear) composite -= 100;
    // Tie-break on slug length when composites are equal.
    if (
      composite > chosenScore ||
      (composite === chosenScore && chosen && slug.length < chosen.length)
    ) {
      chosen = slug;
      chosenScore = composite;
    }
  }

  slugCache.set(cacheKey, chosen);
  return chosen;
}

/** Match an episodes.js array to a preferred host list. Returns null if no match. */
function findPreferredArray(episodeArrays, preferred) {
  const prefs = Array.isArray(preferred) ? preferred : [preferred];
  for (const arr of episodeArrays) {
    if (arr.length === 0) continue;
    // Check any URL in the array (not just [0]) since some arrays have mixed hosts
    if (prefs.some((p) => arr[0].toLowerCase().includes(p.toLowerCase()))) {
      return arr;
    }
  }
  return null;
}

function parseEpisodesJs(jsContent) {
  // Parse var eps1 = ['url1', 'url2', ...]; var eps2 = [...]; etc.
  const arrays = [];
  const regex = /var\s+eps\d+\s*=\s*\[([^\]]*)\]/g;
  let match;
  while ((match = regex.exec(jsContent)) !== null) {
    const urls = [];
    // Extract all quoted strings from the array content
    const urlRegex = /['"]([^'"]+)['"]/g;
    let urlMatch;
    while ((urlMatch = urlRegex.exec(match[1])) !== null) {
      urls.push(urlMatch[1]);
    }
    if (urls.length > 0) arrays.push(urls);
  }
  return arrays;
}

// â”€â”€ voir-anime.to (VF + VOSTFR via WordPress / Madara theme) â”€â”€
const VOIRANIME_BASE = "https://voir-anime.to";
const voirSlugCache = new Map();
const VOIRANIME_SERVERS = {
  // VF
  "voiranime-voe":    { name: "VOE", host: ["voe.sx", "voe."], lang: "vf" },
  "voiranime-voe-vo": { name: "VOE", host: ["voe.sx", "voe."], lang: "vostfr" },
  // Vidmoly — voir-anime tends to carry fresher slugs than anime-sama (their
  // scrape rotates more often), so adding it gives us a separate uploader to
  // try when anime-sama's vidmoly URL is dead.
  "voiranime-vidmoly":    { name: "Vidmoly", host: ["vidmoly.to", "vidmoly.biz", "vidmoly.net"], lang: "vf" },
  "voiranime-vidmoly-vo": { name: "Vidmoly", host: ["vidmoly.to", "vidmoly.biz", "vidmoly.net"], lang: "vostfr" },
};

async function getVoiranimeIframe(serverKey, title, episode, aniId) {
  try {
    const serverDef = VOIRANIME_SERVERS[serverKey];
    if (!serverDef) return null;
    const isVF = serverDef.lang === "vf";

    const seasonNum = await detectSeasonNumber(aniId);
    const slug = await findVoiranimeSlug(title, aniId, isVF, seasonNum);
    if (!slug) {
      dlog(`[voiranime] No slug found for ${title} (${isVF ? "vf" : "vostfr"}, S${seasonNum})`);
      return null;
    }
    dlog(`[voiranime] Slug: ${slug} (${isVF ? "vf" : "vostfr"}, S${seasonNum})`);

    // Fetch the anime detail page to get the full episode list.
    // Some Madara installs require the episode list via admin-ajax (chapters).
    let episodeUrl = null;

    // Episode URL pattern: /anime/{parent_slug}/{any-stub}-(N|0N)(-vf|-vostfr)?/
    // The "any-stub" doesn't have to start with parent_slug exactly â€” sometimes
    // typography differs (e.g. "fish-man" vs "fishman"). So we just match any
    // episode-looking URL within the parent's anime path.
    const slugEsc = slug.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    const baseEsc = VOIRANIME_BASE.replace(/\./g, "\\.");
    const epRegex = new RegExp(
      `href=["'](${baseEsc}/anime/${slugEsc}/[^"']+?-(\\d+)(?:-(?:vf|vostfr))?/)["']`,
      "gi"
    );
    // Film / movie pattern: a child URL with NO episode number, e.g.
    // /anime/howl-no-ugoku-shiro-vf/film-vf-howl-no-ugoku-shiro/. Madara stores
    // single-entry films as one "chapter" whose slug starts with "film"/"movie"
    // instead of carrying a digit, so the episode regex above never sees them —
    // that's why films had no playable server. We match any non-feed child of
    // the anime path that looks like a film/movie/ova/oav stub and treat it as
    // "episode 1".
    const filmRegex = new RegExp(
      `href=["'](${baseEsc}/anime/${slugEsc}/(?:film|movie|ova|oav|special)[^"']*/)["']`,
      "gi"
    );

    const collectEpisodes = (html) => {
      const map = new Map();
      let m;
      epRegex.lastIndex = 0;
      while ((m = epRegex.exec(html)) !== null) {
        const epNum = parseInt(m[2], 10);
        if (!map.has(epNum)) map.set(epNum, m[1]);
      }
      // If the page exposes no numbered episodes but does carry a film/movie
      // entry, register it as episode 1 so single-entry films resolve. We only
      // do this when there are no numbered episodes to avoid mis-mapping a
      // "film" bonus that sits alongside a real numbered season.
      if (map.size === 0) {
        filmRegex.lastIndex = 0;
        const fm = filmRegex.exec(html);
        if (fm) map.set(1, fm[1]);
      }
      return map;
    };

    // Try detail page scrape first. Routed via the CF Worker — voir-anime.to
    // 403s direct Vercel fetches (Cloudflare), same as anime-sama.
    try {
      const detailRes = await fetchViaWorker(`${VOIRANIME_BASE}/anime/${slug}/`);
      if (detailRes.ok) {
        const html = await detailRes.text();
        const epMap = collectEpisodes(html);
        if (epMap.has(Number(episode))) {
          episodeUrl = epMap.get(Number(episode));
        }
      }
    } catch (e) {
      console.error(`[voiranime] detail fetch failed for ${slug}:`, e.message);
    }

    // Fallback: try Madara AJAX chapters endpoint. This stays a DIRECT fetch:
    // the CF Worker only proxies GETs (it drops the method/body), so routing a
    // POST through it would silently become a GET and fail. Best-effort only —
    // the detail-page scrape above (via Worker) is the primary path.
    if (!episodeUrl) {
      try {
        const ajaxRes = await fetchWithTimeout(
          `${VOIRANIME_BASE}/wp-admin/admin-ajax.php`,
          {
            method: "POST",
            headers: {
              "X-Requested-With": "XMLHttpRequest",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: `action=manga_get_chapters&manga=${slug}`,
          },
        );
        if (ajaxRes.ok) {
          const html = await ajaxRes.text();
          const epMap = collectEpisodes(html);
          if (epMap.has(Number(episode))) {
            episodeUrl = epMap.get(Number(episode));
          }
        }
      } catch {}
    }

    if (!episodeUrl) {
      dlog(`[voiranime] Episode ${episode} not found in ${slug}`);
      return null;
    }

    // Fetch episode page and extract thisChapterSources. Via the Worker —
    // voir-anime.to 403s direct Vercel fetches (Cloudflare).
    const epRes = await fetchViaWorker(episodeUrl);
    if (!epRes.ok) {
      console.error(`[voiranime] ${serverKey} episode page ${epRes.status} for ${episodeUrl}`);
      return null;
    }
    const epHtml = await epRes.text();

    const sourcesMatch = epHtml.match(/thisChapterSources\s*=\s*({[\s\S]*?});/);
    if (!sourcesMatch) {
      dlog(`[voiranime] No thisChapterSources in ${episodeUrl}`);
      return null;
    }

    let sources;
    try {
      sources = JSON.parse(sourcesMatch[1]);
    } catch {
      dlog(`[voiranime] Failed to parse thisChapterSources JSON`);
      return null;
    }

    // Find the player whose iframe URL matches one of the host patterns
    let iframeUrl = null;
    for (const [_, iframeHtml] of Object.entries(sources)) {
      const srcMatch = iframeHtml.match(/<iframe\s+src=["']([^"']+)["']/i);
      if (!srcMatch) continue;
      const url = srcMatch[1];
      if (serverDef.host.some((h) => url.toLowerCase().includes(h.toLowerCase()))) {
        iframeUrl = url;
        break;
      }
    }

    if (!iframeUrl) {
      dlog(`[voiranime] Host ${serverDef.host[0]} not available for ${episodeUrl}`);
      return null;
    }

    dlog(`[voiranime] Found ep ${episode} on ${serverDef.name}: ${iframeUrl}`);

    // Content validation BEFORE attempting extraction â€” saves ~1-2s of
    // pointless work when the video is already gone, and prevents the player
    // from getting stuck in a 403 retry loop on segments that will never come.
    const lower = iframeUrl.toLowerCase();
    if (lower.includes("voe.sx") || lower.includes("voe.")) {
      try {
        const probe = await fetchWithTimeout(iframeUrl, { redirect: "follow" });
        if (!probe.ok) {
          dlog(`[voiranime] VOE probe HTTP ${probe.status} â€” hiding server`);
          return null;
        }
        const html = await probe.text();
        // Follow the JS redirect to the actual mirror (maryspecialwatch.com,
        // weneverbeenfree.com, etc) and validate THAT response. Without this
        // every removed VOE video returns 200 here and only fails later
        // during stream extraction, leaving the player stuck in a load loop.
        const mirrorMatch = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
        if (mirrorMatch) {
          const mirror = await fetchWithTimeout(mirrorMatch[1], { redirect: "follow" });
          if (!mirror.ok) {
            dlog(`[voiranime] VOE mirror HTTP ${mirror.status} â€” video removed, hiding server`);
            return null;
          }
          const mirrorHtml = await mirror.text();
          if (
            mirrorHtml.includes("404 - Not found") ||
            mirrorHtml.includes("404 Not Found") ||
            /The server can ?not find the requested resource/i.test(mirrorHtml) ||
            // No JSON payload â†’ no video data on the page
            !/<script[^>]*type=["']application\/json["']/i.test(mirrorHtml)
          ) {
            dlog(`[voiranime] VOE mirror returned error/empty page â€” hiding server`);
            return null;
          }
        } else if (
          html.includes("404 - Not found") ||
          html.includes("404 Not Found") ||
          /The server can ?not find the requested resource/i.test(html)
        ) {
          dlog(`[voiranime] VOE returned 404 page â€” hiding server`);
          return null;
        }
      } catch (e) {
        // Network error â€” fall through and let the client try
      }
    }

    // Vidmoly: same bypass as anime-sama — hand the embed URL to the browser
    // so the m3u8 token IP-binds to the user instead of any proxy. See the
    // commentary in getAnimeSamaIframe for the full rationale.
    if (lower.includes("vidmoly")) {
      if (!(await isVidmolyEmbedAlive(iframeUrl))) {
        dlog(`[voiranime] vidmoly slug 404 — hiding chip: ${iframeUrl}`);
        return null;
      }
      return {
        clientExtract: { type: "vidmoly", embedUrl: iframeUrl },
        iframe: iframeUrl,
      };
    }

    // Server-side extraction preferred; falls back to a degraded iframe
    // chip when the extractor can't unpack the host.
    if (EXTRACTABLE_HOSTS.some((h) => lower.includes(h))) {
      const extractor = getExtractor(iframeUrl);
      const result = await extractor(iframeUrl);
      if (result.streams?.length) return result;
      console.error(
        `[voiranime] ${serverKey} extractor failed for ep=${episode} slug=${slug}: ${result.error}`,
      );
      // VOE iframes are X-Frame-blocked on every non-VOE origin → "refused
      // to connect". Sibnet does the same. Both: hide rather than serve a
      // chip that can never load.
      if (lower.includes("voe.sx") || lower.includes("voe.") || lower.includes("sibnet")) {
        return null;
      }
    }
    return { iframe: iframeUrl, degraded: true, reason: "extraction failed" };
  } catch (e) {
    console.error(`voiranime ${serverKey} error:`, e.message);
    return null;
  }
}

// Convert a title to a URL slug (lowercase, hyphens, no diacritics).
function titleToSlug(title) {
  return (title || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Quickly check if /anime/{slug}/ exists. Routed through the CF Worker because
// voir-anime.to (Cloudflare) 403s direct fetches from Vercel's AWS IPs — the
// same reason anime-sama scraping goes via the Worker. The Worker returns 200
// for a live anime page and 410/4xx for a dead slug, so a 200 is a reliable
// "exists" signal. We follow redirects (a missing-language slug 301s to the
// catalogue, which would NOT be a 200) so a redirect doesn't count as a hit.
async function voiranimeSlugExists(slug) {
  try {
    const r = await fetchViaWorker(
      `${VOIRANIME_BASE}/anime/${slug}/`,
      { method: "GET", redirect: "follow" },
      3500, // tight budget — we probe up to ~10 slug candidates sequentially
    );
    return r.status === 200;
  } catch {
    return false;
  }
}

// Words that indicate a movie / special / film entry â€” never the main TV series.
const MOVIE_WORDS = ["film", "movie", "stampede", "special", "ova", "fan-letter", "kai", "log-", "log:", "episode-of", "adventure-of", "heart-of-gold", "glorious-island"];

async function findVoiranimeSlug(title, aniId, isVF, seasonNum) {
  const cacheKey = `${aniId}-${isVF ? "vf" : "vostfr"}-${seasonNum}`;
  if (voirSlugCache.has(cacheKey)) return voirSlugCache.get(cacheKey);

  // Strip season suffixes for base title
  const stripSeason = (t) =>
    t?.replace(/\s*(Season\s*\d+|\d+(st|nd|rd|th)\s*Season|Part\s*\d+|\d+æœŸ|2nd|3rd)\s*/gi, "").trim();

  // Collect title candidates from the shared Media cache (zero AniList hits if primed)
  const titleSet = new Set([title]);
  const stripped = stripSeason(title);
  if (stripped) titleSet.add(stripped);

  const m = await getMediaMeta(aniId);
  if (m) {
    for (const t of [m.title?.english, m.title?.romaji, ...(m.synonyms || [])]) {
      if (t) {
        titleSet.add(t);
        const s = stripSeason(t);
        if (s) titleSet.add(s);
      }
    }
  }

  const titles = [...titleSet];

  // â”€â”€ Strategy 1: direct slug guessing (much faster than search) â”€â”€
  // For S2+ try several season-suffix conventions voir-anime actually uses:
  //   {base}-s{N}-vf  (e.g. kaiju-no-8-s2-vf  â† the real one)
  //   {base}-{N}-vf   (e.g. kaiju-no-8-2-vf)
  //   {base}-saison-{N}-vf
  // S1 just tries {base}. Always honour the -vf vs un-suffixed (VOSTFR) split.
  const slugCandidates = new Set();
  for (const t of titles) {
    const base = titleToSlug(t);
    if (!base) continue;
    if (seasonNum > 1) {
      // Order matters — most-common voir-anime convention first.
      const seasonForms = [
        `${base}-s${seasonNum}`,
        `${base}-${seasonNum}`,
        `${base}-saison-${seasonNum}`,
        `${base}-season-${seasonNum}`,
      ];
      for (const form of seasonForms) {
        slugCandidates.add(isVF ? `${form}-vf` : form);
      }
    }
    slugCandidates.add(isVF ? `${base}-vf` : base);
    // NOTE: do NOT fall back to the un-suffixed slug for VF requests â€” that
    // slug is the VOSTFR variant and would silently serve the wrong language.
  }

  for (const cand of slugCandidates) {
    if (await voiranimeSlugExists(cand)) {
      voirSlugCache.set(cacheKey, cand);
      return cand;
    }
  }

  // â”€â”€ Strategy 2: search fallback with stricter scoring â”€â”€
  for (const q of titles) {
    try {
      const res = await fetchWithTimeout(
        `${VOIRANIME_BASE}/wp-admin/admin-ajax.php`,
        {
          method: "POST",
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: `action=wp-manga-search-manga&title=${encodeURIComponent(q)}`,
        },
      );
      if (!res.ok) continue;
      const data = await res.json();
      if (!data?.success || !data?.data?.length) continue;

      // Build candidates and score them. STRICT: language mismatch is rejected outright.
      const baseSlug = titleToSlug(stripped || title);
      const candidates = data.data
        .filter((r) => r.url && r.url.includes("/anime/"))
        .map((r) => {
          const slug = r.url.replace(/^.*\/anime\//, "").replace(/\/$/, "");
          const isVfSlug = /-vf$/i.test(slug);
          const cleanSlug = slug.replace(/-vf$/i, "");
          // Season suffix conventions voir-anime mixes: "-s2", "-2",
          // "-saison-2", "-season-2". Parse any of them so the right season
          // entry scores highest instead of defaulting to S1.
          const seasonMatch = cleanSlug.match(/-(?:s|saison-|season-)?(\d+)$/);
          const slugSeason = seasonMatch ? Number(seasonMatch[1]) : 1;
          const seasonStripped = cleanSlug.replace(/-(?:s|saison-|season-)?\d+$/, "");

          let score = 0;
          // HARD reject if language mismatches â€” VF request must yield -vf slug, etc.
          if (isVfSlug !== isVF) return { slug, score: -1 };
          // Reject movies/specials hard â€” never used for TV episode lookup
          if (MOVIE_WORDS.some((w) => slug.toLowerCase().includes(w))) score -= 100;
          // Exact base slug match (best signal)
          if (seasonStripped === baseSlug) score += 50;
          else if (seasonStripped.startsWith(baseSlug)) score += 20;
          // Season number matches
          if (slugSeason === seasonNum) score += 30;
          else if (seasonNum === 1 && slugSeason === 1) score += 15;
          else score -= Math.abs(slugSeason - seasonNum) * 5;
          // Penalize very long slugs (specials with descriptive names)
          if (slug.length > baseSlug.length + 15) score -= 10;

          return { slug, title: r.title, isVfSlug, slugSeason, score };
        })
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score);

      if (candidates.length > 0 && candidates[0].score >= 20) {
        const chosen = candidates[0];
        voirSlugCache.set(cacheKey, chosen.slug);
        return chosen.slug;
      }
    } catch {}
  }

  // Cache the failure too â€” avoid hammering search on every probe
  voirSlugCache.set(cacheKey, null);
  return null;
}

// ── Audit / inspection helpers ───────────────────────────────────────────
// These reuse the SAME resolution path the player uses (detectSeasonNumber +
// findSlug + the season/episode listing), but stop BEFORE stream extraction
// and return the matching metadata instead. The audit script
// (scripts/audit-players.mjs) calls these (via /api/v2/source/inspect) to
// compare what each source resolves to against the AniList episode count, so
// we can find anime that map to the wrong season / slug (e.g. a Season 2 that
// falls back to the Season 1 panel) or that are missing entirely.
//
// They are READ-ONLY and never throw: on any failure they return
// { found: false, ... } so a batch audit can't be derailed by one bad anime.

/** Inspect what anime-sama resolves to for an AniList id + language. */
export async function inspectAnimeSama(aniId, lang = "vostfr") {
  const langPath = lang === "vf" ? "vf" : "vostfr";
  const out = {
    source: "animesama",
    lang: langPath,
    found: false,
    slug: null,
    seasonNum: null,
    chosenSeasonDir: null,
    chosenSeasonLabel: null,
    episodeCount: 0,
    firstEpUrl: null,
    lastEpUrl: null,
    seasonsAvailable: [],
  };
  try {
    const meta = await getMediaMeta(aniId);
    const title = meta?.title?.english || meta?.title?.romaji || null;
    if (!title) return out;

    out.seasonNum = await detectSeasonNumber(aniId);
    const slug = await findAnimeSamaSlug(title, aniId);
    if (!slug) return out;
    out.slug = slug;

    const detailRes = await fetchViaWorker(`${ANIMESAMA_BASE}/catalogue/${slug}/`);
    if (!detailRes.ok) return out;
    const detailHtml = await detailRes.text();

    const seasonMatches = [
      ...detailHtml.matchAll(/panneauAnime\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g),
    ];
    const seasons = seasonMatches
      .map((m) => {
        const path = m[2];
        const dirMatch = path.match(
          /^(saison[^/]+|film[^/]*|oav[^/]*|special[^/]*|scan[^/]*)\//i,
        );
        if (!dirMatch) return null;
        const yearMatch = m[1].match(/\b(19|20)\d{2}\b/);
        return {
          label: m[1],
          dir: dirMatch[1],
          path: m[2],
          year: yearMatch ? parseInt(yearMatch[0], 10) : null,
          isFilm: /^film/i.test(dirMatch[1]),
        };
      })
      .filter(Boolean)
      .map((s, i) => ({ ...s, ordinal: i + 1 }));
    if (seasons.length === 0) {
      seasons.push({ label: "Saison 1", ordinal: 1, dir: "saison1", path: `saison1/${langPath}`, year: null, isFilm: false });
    }
    out.seasonsAvailable = seasons.map((s) => ({ dir: s.dir, label: s.label, ordinal: s.ordinal, year: s.year }));

    // Mirror the player's season-selection logic so the audit sees the SAME
    // target the player would pick (year match → title match → ordinal).
    const isMovie = meta?.format === "MOVIE";
    const filmSeason = seasons.find((s) => s.isFilm);
    const aniYear = meta?.seasonYear || meta?.startDate?.year || null;
    let yearMatchedSeason = aniYear ? seasons.find((s) => s.year === aniYear) : null;

    const aniTitles = [meta?.title?.romaji, meta?.title?.english, ...(meta?.synonyms || [])].filter(Boolean);
    const aniSeasonHint = (() => {
      const t = `${meta?.title?.romaji || ""} ${meta?.title?.english || ""}`;
      const m = t.match(/\b(?:season|part|saison)\s*(\d+)\b|(\d+)(?:st|nd|rd|th)\s*season/i);
      return m ? parseInt(m[1] || m[2], 10) : null;
    })();
    let titleMatchedSeason = null;
    if (aniTitles.length > 0 && seasons.length > 1) {
      let best = { season: null, score: 0 };
      for (const s of seasons) {
        let bestForSeason = 0;
        for (const t of aniTitles) {
          const sc = scoreSlugAgainstTitle(s.label, t);
          if (sc > bestForSeason) bestForSeason = sc;
        }
        const labelSeasonMatch = s.label.match(/saison\s*(\d+)/i);
        const labelSeasonNum = labelSeasonMatch ? parseInt(labelSeasonMatch[1], 10) : null;
        if (aniSeasonHint != null && labelSeasonNum === aniSeasonHint) bestForSeason += 5;
        else if (aniSeasonHint == null && labelSeasonNum === 1) bestForSeason += 1;
        if (bestForSeason > best.score) best = { season: s, score: bestForSeason };
      }
      if (best.season && best.score > 0) titleMatchedSeason = best.season;
    }

    const directTarget =
      (isMovie && filmSeason) ||
      yearMatchedSeason ||
      titleMatchedSeason ||
      (out.seasonNum > 1 ? seasons.find((s) => s.ordinal === out.seasonNum) : null) ||
      seasons[0];

    if (!directTarget) return out;
    out.chosenSeasonDir = directTarget.dir;
    out.chosenSeasonLabel = directTarget.label;

    const targetLang = directTarget.isFilm
      ? (directTarget.path.split("/")[1] || langPath)
      : langPath;
    const epPath = `${ANIMESAMA_BASE}/catalogue/${slug}/${directTarget.dir}/${targetLang}/episodes.js`;
    const epRes = await fetchViaWorker(epPath);
    if (!epRes.ok) {
      // The chosen season has no episodes.js in this language — still report
      // the resolution; episodeCount stays 0 so the audit flags it.
      return out;
    }
    const jsContent = await epRes.text();
    const episodeArrays = parseEpisodesJs(jsContent);
    if (episodeArrays.length === 0) return out;
    // Canonical count = the longest host array (host availability varies).
    const canonical = episodeArrays.reduce((a, b) => (b.length > a.length ? b : a), []);
    out.found = true;
    out.episodeCount = canonical.length;
    out.firstEpUrl = canonical[0] || null;
    out.lastEpUrl = canonical[canonical.length - 1] || null;
    return out;
  } catch (e) {
    return { ...out, error: e?.message || String(e) };
  }
}

/** Inspect what voir-anime resolves to for an AniList id + language. */
export async function inspectVoiranime(aniId, lang = "vostfr") {
  const isVF = lang === "vf";
  const out = {
    source: "voiranime",
    lang: isVF ? "vf" : "vostfr",
    found: false,
    slug: null,
    seasonNum: null,
    episodeCount: 0,
    episodeNumbers: [],
    firstEpUrl: null,
    lastEpUrl: null,
  };
  try {
    const meta = await getMediaMeta(aniId);
    const title = meta?.title?.english || meta?.title?.romaji || null;
    if (!title) return out;

    out.seasonNum = await detectSeasonNumber(aniId);
    const slug = await findVoiranimeSlug(title, aniId, isVF, out.seasonNum);
    if (!slug) return out;
    out.slug = slug;

    // Reproduce getVoiranimeIframe's episode collection (detail page → AJAX).
    const slugEsc = slug.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    const baseEsc = VOIRANIME_BASE.replace(/\./g, "\\.");
    const epRegex = new RegExp(
      `href=["'](${baseEsc}/anime/${slugEsc}/[^"']+?-(\\d+)(?:-(?:vf|vostfr))?/)["']`,
      "gi",
    );
    const collect = (html) => {
      const map = new Map();
      let m;
      epRegex.lastIndex = 0;
      while ((m = epRegex.exec(html)) !== null) {
        const n = parseInt(m[2], 10);
        if (!map.has(n)) map.set(n, m[1]);
      }
      return map;
    };

    let epMap = new Map();
    try {
      const detailRes = await fetchViaWorker(`${VOIRANIME_BASE}/anime/${slug}/`);
      if (detailRes.ok) epMap = collect(await detailRes.text());
    } catch { /* ignore */ }
    if (epMap.size === 0) {
      try {
        const ajaxRes = await fetchWithTimeout(`${VOIRANIME_BASE}/wp-admin/admin-ajax.php`, {
          method: "POST",
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: `action=manga_get_chapters&manga=${slug}`,
        });
        if (ajaxRes.ok) epMap = collect(await ajaxRes.text());
      } catch { /* ignore */ }
    }

    if (epMap.size === 0) return out;
    const nums = [...epMap.keys()].sort((a, b) => a - b);
    out.found = true;
    out.episodeCount = nums.length;
    out.episodeNumbers = nums;
    out.firstEpUrl = epMap.get(nums[0]) || null;
    out.lastEpUrl = epMap.get(nums[nums.length - 1]) || null;
    return out;
  } catch (e) {
    return { ...out, error: e?.message || String(e) };
  }
}

// â”€â”€ Consumet providers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// AnimeSaturn was removed at user request; no consumet-backed servers remain.
// The dispatch below is kept (guarded on an empty map) so re-adding a provider
// is a one-line change.
const CONSUMET_PROVIDERS = {};

async function getConsumetStream(providerKey, title, episode, sub) {
  try {
    const def = CONSUMET_PROVIDERS[providerKey];
    if (!def) return null;

    const provider = new def.cls();

    // 1. Search
    const searchRes = await provider.search(title);
    if (!searchRes?.results?.length) return null;

    // Prefer sub/dub variant if available
    const isDub = sub === "dub";
    const anime =
      searchRes.results.find(
        (r) =>
          isDub
            ? r.subOrDub === "dub" || r.title?.toLowerCase().includes("ita")
            : r.subOrDub === "sub" || !r.title?.toLowerCase().includes("ita")
      ) || searchRes.results[0];

    // 2. Get episodes
    const info = await provider.fetchAnimeInfo(anime.id);
    if (!info?.episodes?.length) return null;

    const ep = info.episodes.find((e) => e.number === Number(episode));
    if (!ep?.id) return null;

    // 3. Get sources
    const sources = await provider.fetchEpisodeSources(ep.id);
    if (!sources?.sources?.length) return null;

    return {
      streams: sources.sources
        .filter((s) => s.url)
        .map((s) => ({
          url: s.url,
          quality: s.quality || "default",
          isM3U8: s.isM3U8 !== false,
        })),
      subtitles: sources.subtitles?.map((s) => ({
        file: s.url,
        label: s.lang || "Default",
        kind: "captions",
      })),
      referer: sources.headers?.Referer || null,
    };
  } catch (e) {
    console.error(`Consumet ${providerKey} error:`, e.message);
    return null;
  }
}

// ── Cross-visitor source cache ─────────────────────────────────────────
// Source extraction is by far the most CPU-expensive endpoint in the API.
// Every watch-page mount fan-outs 15-20 probes; in practice ~half of those
// 404 (server doesn't have this anime / episode). Without negative caching,
// every visitor of a popular episode repeats the same expensive scrape for
// the same dead servers.
//
// Two TTLs:
//   - OK_TTL  (5 min): tokens we proxy last 60-240 min, so 5 min is safe.
//   - 404_TTL (2 min): shorter, because some 404s are transient (upstream
//     rate-limit, brief CDN outage). 2 min collapses the probe burst from
//     concurrent viewers without locking in a transient failure for long.
//
// Negative entries store a sentinel ({__nf: true}) under the same key as
// positive entries — a hit is either parsed JSON we serve as 200, or the
// sentinel we turn into 404.
const SOURCE_CACHE_TTL_S = 300;
// Negative cache: keep dead probes out of the scrape rotation for 2 min.
// Going shorter quadruples the upstream rate to anti-bot hosts (sibnet
// throttles harder when hit more often) without giving the user a better
// experience — the watch page no longer persists failed probes to
// sessionStorage, so a reload re-probes immediately on the client side
// regardless of this TTL.
const SOURCE_NOTFOUND_TTL_S = 120;
const NOT_FOUND_SENTINEL = '{"__nf":1}';
function sourceCacheKey({ server, aniId, episode, sub }) {
  // v10: Vidmoly now has a Fly-proxy tier 2 fallback. Worker-blocked
  // embeds (vidmoly.biz 410 from CF IPs) get extracted via Fly and the
  // m3u8 wrapped through Fly too, so playback lands in the Universal
  // Player instead of the iframe fallback. Bump so the v9 degraded
  // iframe entries flush and the next probe re-runs the tier chain.
  return `src:v10:${server}:${aniId}:${episode}:${sub || "sub"}`;
}

// ── Handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  if (redis) {
    try {
      const ipAddress = req.socket.remoteAddress;
      await rateLimiterRedis.consume(ipAddress);
    } catch (error) {
      return res.status(429).json({
        error: `Too Many Requests, retry after ${error.msBeforeNext / 1000}`,
      });
    }
  }

  const { server, aniId, episode, sub = "sub", title, mediaMeta } = req.body;

  // Redis lookup — short-circuit identical (server, aniId, episode, sub)
  // requests served within the last SOURCE_CACHE_TTL_S. The probe fan-out
  // on the watch page sends 15-20 of these at once, every page load.
  const cacheKey = sourceCacheKey({ server, aniId, episode, sub });
  const canCache = redis && server && aniId && episode != null;
  if (canCache) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        if (cached === NOT_FOUND_SENTINEL) {
          // Negative cache hit — skip the expensive scrape entirely. This is
          // the main CPU win: ~half of probe fan-outs naturally 404, and a
          // popular episode would re-extract the same dead servers for every
          // visitor without this.
          res.setHeader("Cache-Control", "public, max-age=30");
          return res.status(404).json({ error: "Source not found" });
        }
        res.setHeader(
          "Cache-Control",
          "public, s-maxage=60, stale-while-revalidate=120",
        );
        return res.status(200).json(JSON.parse(cached));
      }
    } catch {
      /* non-fatal */
    }
  }

  const sendOk = (payload) => {
    if (canCache) {
      // Fire-and-forget — never let cache writes block the response.
      redis
        .set(cacheKey, JSON.stringify(payload), "EX", SOURCE_CACHE_TTL_S)
        .catch(() => {});
    }
    // Edge cache matches the 5 min Redis TTL — most CDN tokens we proxy
    // last 60-240 min, so 5 min between refresh is well within the safe
    // window. Browser cache stays short (60 s) so a manual refresh in
    // the player picks up a new token if the user's current one fails.
    res.setHeader("Cache-Control", "public, max-age=60");
    res.setHeader(
      "CDN-Cache-Control",
      "public, s-maxage=300, stale-while-revalidate=600",
    );
    return res.status(200).json(payload);
  };

  const sendNotFound = (msg) => {
    if (canCache) {
      redis
        .set(cacheKey, NOT_FOUND_SENTINEL, "EX", SOURCE_NOTFOUND_TTL_S)
        .catch(() => {});
    }
    res.setHeader("Cache-Control", "public, max-age=30");
    return res.status(404).json({ error: msg || "Source not found" });
  };

  // If the client passed pre-fetched AniList metadata (from watch page SSR),
  // prime the cache so no helper has to call AniList itself.
  if (mediaMeta && aniId) primeMediaCache(aniId, mediaMeta);

  // Megaplay â€” extract m3u8 + subtitles directly (no iframe).
  // Megaplay migrated its stream routes: the old /stream/ani/<aniListId>/...
  // path now times out. The current scheme is keyed by MAL id:
  //   /stream/mal/<malId>/<episode>/<sub|dub>
  // So we resolve the MAL id from the shared media cache (idMal is in
  // FULL_MEDIA_FIELDS) before building the URL.
  if (server === "megaplay") {
    let malId = mediaMeta?.idMal || null;
    if (!malId) {
      const meta = await getMediaMeta(aniId);
      malId = meta?.idMal || null;
    }
    if (!malId) {
      return sendNotFound("megaplay: no MAL id for this anime");
    }
    const url = `https://megaplay.buzz/stream/mal/${malId}/${episode}/${sub === "dub" ? "dub" : "sub"}`;
    const result = await extractMegaplay(url);
    if (result.error || !result.streams?.length) {
      return sendNotFound(result.error || "Source not found");
    }
    return sendOk(result);
  }


  // Helper to resolve anime title â€” uses shared cache, only hits AniList if missing
  async function resolveTitle() {
    if (title) return title;
    const m = await getMediaMeta(aniId);
    return m?.title?.english || m?.title?.romaji || null;
  }

  // Anime-Sama (VF + VOSTFR) â€” returns iframe embed URL
  if (ANIMESAMA_SERVERS[server]) {
    const searchTitle = await resolveTitle();
    if (!searchTitle) return sendNotFound("Could not resolve anime title");
    const data = await getAnimeSamaIframe(server, searchTitle, episode, aniId);
    if (!data) return sendNotFound("Source not found");
    return sendOk(data);
  }

  // voir-anime.to (VF + VOSTFR) â€” Madara/WordPress source
  if (VOIRANIME_SERVERS[server]) {
    const searchTitle = await resolveTitle();
    if (!searchTitle) return sendNotFound("Could not resolve anime title");
    const data = await getVoiranimeIframe(server, searchTitle, episode, aniId);
    if (!data) return sendNotFound("Source not found");
    return sendOk(data);
  }

  // Consumet providers (AnimeSaturn, AnimeUnity)
  if (CONSUMET_PROVIDERS[server]) {
    const searchTitle = await resolveTitle();
    if (!searchTitle) return sendNotFound("Could not resolve anime title");
    const data = await getConsumetStream(server, searchTitle, episode, sub);
    if (!data) return sendNotFound("Source not found");
    return sendOk(data);
  }

  return res.status(400).json({ error: "Unknown server" });
}
