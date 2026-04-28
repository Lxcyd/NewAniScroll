import { rateLimiterRedis, redis } from "@/lib/redis";
import * as cheerio from "cheerio";
import { ANIME } from "@consumet/extensions";
import { getExtractor } from "@/lib/extractors";
import { getMediaMeta, primeMediaCache } from "@/lib/anilist/getMediaMeta";

// Hosts where we can server-side extract a direct stream URL (bypasses
// X-Frame-Options, ads, JWT redirects). If extraction fails for any of these,
// caller falls back to the raw iframe.
// Hosts where server-side extraction returns a REAL playable stream.
//
// Smoothpre / movearnpre / dingtezuni / callistanise also "extract" but they
// detect non-browser requests and serve a FAKE ad playlist (TikTok image URLs
// in place of video segments). Including them here would give the universal
// player an unplayable source — better to fall back to their native iframe
// where they serve the real video to the user's browser session.
const EXTRACTABLE_HOSTS = [
  "sibnet.ru",
  "sendvid.com",
  "vidmoly",
  "embed4me",
  "lpayer",        // lpayer.embed4me.com
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

const MIRURO_BASE =
  process.env.MIRURO_API_URL || "https://miruro-api.vercel.app";

const COOREN_BASE = process.env.COOREN_API_URL || "";

// ── HiAnime (direct AJAX) ───────────────────────────────────
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

// ── Miruro ──────────────────────────────────────────────────
const MIRURO_PROVIDERS = {
  "miruro-kiwi": "kiwi",
  "miruro-arc": "arc",
  "miruro-zoro": "zoro",
  "miruro-jet": "jet",
};

async function getMiruroStream(provider, aniId, episode, sub) {
  try {
    // Step 1: fetch episode list
    const epRes = await fetch(`${MIRURO_BASE}/episodes/${aniId}`);
    if (!epRes.ok) return null;
    const epData = await epRes.json();

    // Navigate to provider episodes
    const providerData = epData?.providers?.[provider];
    if (!providerData?.episodes) return null;

    const category = sub === "dub" ? "dub" : "sub";
    const episodes =
      providerData.episodes[category] || providerData.episodes.sub || [];
    if (episodes.length === 0) return null;

    // Find the matching episode
    const ep = episodes.find((e) => e.number === Number(episode));
    if (!ep?.id) return null;

    // Step 2: fetch stream using the episode id (e.g. "watch/kiwi/21/sub/animepahe-1")
    const srcRes = await fetch(`${MIRURO_BASE}/${ep.id}`);
    if (!srcRes.ok) return null;
    return await srcRes.json();
  } catch (e) {
    console.error("Miruro source error:", e.message);
    return null;
  }
}

// ── CoorenLabs ──────────────────────────────────────────────
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

// ── Toonstream — series + episode → m3u8 sources ──
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

// ── Animesalt — same shape as Toonstream ──
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

  console.log(`[animekai] Episode ID: ${ep.id}`);

  // Get stream sources — returns { results: [{ sources, subtitles, name }] }
  const watchRes = await fetch(
    `${COOREN_BASE}/anime/animekai/watch/${encodeURIComponent(ep.id)}${
      sub === "dub" ? "?dub=true" : ""
    }`
  );
  if (!watchRes.ok) return null;
  const watchData = await watchRes.json();

  // Each result has its own sources/subtitles — merge all
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

// ── Anime-Sama (VF + VOSTFR) ─────────────────────────────────
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
  "animesama-smoothpre":    { name: "Smoothpre",   preferred: ["Smoothpre.com", "smoothpre.com"],         lang: "vf" },
  "animesama-callistanise": { name: "Player",      preferred: ["callistanise.com", "dingtezuni.com", "movearnpre.com"], lang: "vf" },
  // VOSTFR (Japanese + French subs)
  "animesama-sibnet-vo":       { name: "Sibnet",      preferred: ["sibnet.ru"],                              lang: "vostfr" },
  "animesama-sendvid-vo":      { name: "Sendvid",     preferred: ["sendvid.com"],                            lang: "vostfr" },
  "animesama-vidmoly-vo":      { name: "Vidmoly",     preferred: ["vidmoly.to", "vidmoly.biz", "vidmoly.net"], lang: "vostfr" },
  "animesama-embed4me-vo":     { name: "Embed4Me",    preferred: ["embed4me.com", "lpayer"],                 lang: "vostfr" },
  "animesama-smoothpre-vo":    { name: "Smoothpre",   preferred: ["Smoothpre.com", "smoothpre.com"],         lang: "vostfr" },
  "animesama-callistanise-vo": { name: "Player",      preferred: ["callistanise.com", "dingtezuni.com", "movearnpre.com"], lang: "vostfr" },
};

async function getAnimeSamaIframe(serverKey, title, episode, aniId) {
  try {
    const serverDef = ANIMESAMA_SERVERS[serverKey];
    if (!serverDef) return null;

    const langPath = serverDef.lang === "vostfr" ? "vostfr" : "vf";

    // 1. Detect which season this AniList ID represents
    const seasonNum = await detectSeasonNumber(aniId);
    console.log(`[anime-sama] AniList ${aniId} → detected season ${seasonNum}`);

    // 2. Search anime-sama — use romaji title first, then try french
    const slug = await findAnimeSamaSlug(title, aniId);
    if (!slug) return null;
    console.log(`[anime-sama] Found slug: ${slug} (${langPath})`);

    // 3. Try to find the right season/episode
    // Fetch the anime detail page to get season list
    const detailRes = await fetch(`${ANIMESAMA_BASE}/catalogue/${slug}/`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!detailRes.ok) return null;
    const detailHtml = await detailRes.text();

    // Extract panneauAnime() calls to find available seasons
    const seasonMatches = [...detailHtml.matchAll(/panneauAnime\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g)];
    console.log(`[anime-sama] Found ${seasonMatches.length} seasons`);

    // Build season list from panneauAnime calls — use sequential ordinals (1,2,3,4...)
    // NOT the season number from the path (since "saison3-2" is a separate entry from "saison3").
    // Also extract any 4-digit year from the label (e.g. "Version 2011" → 2011) so we can
    // match against AniList's seasonYear/startDate when multiple versions exist.
    const seasons = seasonMatches
      .map((m) => {
        const path = m[2]; // e.g. "saison1/vostfr" or "saison3-2/vostfr"
        const dirMatch = path.match(/^(saison[^/]+)\//);
        if (!dirMatch) return null;
        const yearMatch = m[1].match(/\b(19|20)\d{2}\b/);
        return {
          label: m[1],
          dir: dirMatch[1],
          path: m[2],
          year: yearMatch ? parseInt(yearMatch[0], 10) : null,
        };
      })
      .filter(Boolean)
      .map((s, i) => ({ ...s, ordinal: i + 1 }));

    if (seasons.length === 0) {
      seasons.push({ label: "Saison 1", ordinal: 1, dir: "saison1", path: `saison1/${langPath}` });
    }

    console.log(`[anime-sama] Seasons: ${seasons.map((s) => `${s.ordinal}=${s.dir}${s.year ? `(${s.year})` : ""}`).join(", ")}`);

    // 3.5. YEAR MATCHING — if multiple seasons have explicit years and AniList
    // gave us a year, prefer the season whose year matches. Solves the HxH
    // 1999-vs-2011 case where they share the same slug.
    const meta = await getMediaMeta(aniId);
    const aniYear = meta?.seasonYear || meta?.startDate?.year || null;
    let yearMatchedSeason = null;
    if (aniYear) {
      yearMatchedSeason = seasons.find((s) => s.year === aniYear);
      if (yearMatchedSeason) {
        console.log(`[anime-sama] Year match: AniList ${aniYear} → ${yearMatchedSeason.dir}`);
      }
    }

    // 4. If we detected a specific season from AniList, go directly to it
    const episodeIndex = Number(episode) - 1;
    let iframeUrl = null;

    // Year match takes priority over PREQUEL-chain detection
    const directTarget = yearMatchedSeason ||
      (seasonNum > 1 ? seasons.find((s) => s.ordinal === seasonNum) : null);

    if (directTarget) {
      const targetSeason = directTarget;
      const epPath = `${ANIMESAMA_BASE}/catalogue/${slug}/${targetSeason.dir}/${langPath}/episodes.js`;
      console.log(`[anime-sama] Direct season ${targetSeason.dir} (${yearMatchedSeason ? `year ${aniYear}` : `ordinal ${seasonNum}`}): ${epPath}`);

      const epRes = await fetch(epPath, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (epRes.ok) {
        const jsContent = await epRes.text();
        const episodeArrays = parseEpisodesJs(jsContent);
        if (episodeArrays.length > 0) {
          const bestArray = findPreferredArray(episodeArrays, serverDef.preferred);
          if (bestArray && episodeIndex >= 0 && episodeIndex < bestArray.length) {
            iframeUrl = bestArray[episodeIndex];
            console.log(`[anime-sama] Found ep ${episode} in ${targetSeason.dir}: ${iframeUrl}`);
          }
        }
      }
    }

    // 5. Fallback: cumulative season iteration (only if year/PREQUEL didn't match)
    // KEY: episode count comes from the canonical (first) array, not the host-specific one.
    // Otherwise, when the requested host isn't in season N, we'd skip ahead and incorrectly
    // return episode 1 of a later season (e.g. One Piece OneUpload → saison9 ep 1).
    if (!iframeUrl) {
      let cumulativeEps = 0;
      for (const season of seasons) {
        const epPath = `${ANIMESAMA_BASE}/catalogue/${slug}/${season.dir}/${langPath}/episodes.js`;
        console.log(`[anime-sama] Trying: ${epPath}`);

        const epRes = await fetch(epPath, {
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        if (!epRes.ok) {
          console.log(`[anime-sama] No ${langPath.toUpperCase()} for ${season.dir}`);
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
            console.log(`[anime-sama] Found ep ${episode} in ${season.dir}: ${iframeUrl}`);
          } else {
            console.log(`[anime-sama] ${season.dir} has ep ${episode} but not on ${serverDef.preferred[0] || serverDef.preferred}`);
          }
          break; // Right season found; don't keep looking
        }
        cumulativeEps += canonicalCount;
      }
    }

    if (!iframeUrl) return null;

    // Try server-side extraction for hosts we know how to unpack.
    // Sibnet / Sendvid MUST be extracted (iframes are blocked by X-Frame);
    // Vidmoly benefits from extraction when possible, but iframe is a valid
    // fallback (user's browser can load it directly).
    const lower = iframeUrl.toLowerCase();
    const STRICT_EXTRACT = ["sibnet.ru", "sendvid.com"];
    const isStrict = STRICT_EXTRACT.some((h) => lower.includes(h));

    if (EXTRACTABLE_HOSTS.some((h) => lower.includes(h))) {
      const extractor = getExtractor(iframeUrl);
      const result = await extractor(iframeUrl);
      if (result.streams?.length) {
        console.log(`[anime-sama] Extracted stream for ${serverKey}: ${result.streams[0].url}`);
        return result;
      }
      console.log(`[anime-sama] Extraction failed for ${serverKey}: ${result.error}`);
      // For strict hosts (iframe blocked), fail. For vidmoly and others, fall
      // back to the raw iframe — the user's browser may still play it.
      if (isStrict) return null;
    }

    return { iframe: iframeUrl };
  } catch (e) {
    console.error(`anime-sama ${serverKey} error:`, e.message);
    return null;
  }
}

/**
 * Detect which season number an AniList ID represents by walking the PREQUEL chain.
 * Uses the shared Media cache — a single AniList fetch covers title, synonyms,
 * AND relations, so we don't need separate calls for each scraper helper.
 */
async function detectSeasonNumber(aniId) {
  const cacheKey = String(aniId);
  if (seasonCache.has(cacheKey)) return seasonCache.get(cacheKey);

  let season = 1;
  let currentId = Number(aniId);
  const visited = new Set();

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const media = await getMediaMeta(currentId);
    if (!media) break;
    const edges = media.relations?.edges || [];
    const prequel = edges.find(
      (e) => e.relationType === "PREQUEL" && e.node?.format === "TV"
    );
    if (prequel) {
      season++;
      currentId = prequel.node.id;
    } else {
      break;
    }
  }

  seasonCache.set(cacheKey, season);
  return season;
}

async function findAnimeSamaSlug(title, aniId) {
  const cacheKey = `${aniId}-${title}`;
  if (slugCache.has(cacheKey)) return slugCache.get(cacheKey);

  // Strip season suffixes to find the base anime on anime-sama
  const stripSeason = (t) =>
    t?.replace(/\s*(Season\s*\d+|\d+(st|nd|rd|th)\s*Season|Part\s*\d+|\d+期)\s*/gi, "").trim();

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

  for (const q of queries) {
    const searchRes = await fetch(
      `${ANIMESAMA_BASE}/catalogue/?search=${encodeURIComponent(q)}`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!searchRes.ok) continue;
    const html = await searchRes.text();
    const $ = cheerio.load(html);

    // Find first anime card with VF language
    let slug = null;
    $("a[href*='/catalogue/']").each((_, el) => {
      const href = $(el).attr("href") || "";
      const text = $(el).text();
      // Check if this result has VF
      if (text.includes("VF") && href.includes("/catalogue/") && !slug) {
        const match = href.match(/\/catalogue\/([^/]+)/);
        if (match) slug = match[1];
      }
    });

    // If no VF-specific match, just take the first catalogue result
    if (!slug) {
      $("a[href*='/catalogue/']").each((_, el) => {
        const href = $(el).attr("href") || "";
        if (!slug) {
          const match = href.match(/\/catalogue\/([^/]+)\/?$/);
          if (match) slug = match[1];
        }
      });
    }

    if (slug) {
      slugCache.set(cacheKey, slug);
      return slug;
    }
  }

  return null;
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

// ── voir-anime.to (VF + VOSTFR via WordPress / Madara theme) ──
const VOIRANIME_BASE = "https://voir-anime.to";
const voirSlugCache = new Map();
const VOIRANIME_SERVERS = {
  // VF
  "voiranime-voe":    { name: "VOE", host: ["voe.sx", "voe."], lang: "vf" },
  "voiranime-voe-vo": { name: "VOE", host: ["voe.sx", "voe."], lang: "vostfr" },
};

async function getVoiranimeIframe(serverKey, title, episode, aniId) {
  try {
    const serverDef = VOIRANIME_SERVERS[serverKey];
    if (!serverDef) return null;
    const isVF = serverDef.lang === "vf";

    const seasonNum = await detectSeasonNumber(aniId);
    const slug = await findVoiranimeSlug(title, aniId, isVF, seasonNum);
    if (!slug) {
      console.log(`[voiranime] No slug found for ${title} (${isVF ? "vf" : "vostfr"}, S${seasonNum})`);
      return null;
    }
    console.log(`[voiranime] Slug: ${slug} (${isVF ? "vf" : "vostfr"}, S${seasonNum})`);

    // Fetch the anime detail page to get the full episode list.
    // Some Madara installs require the episode list via admin-ajax (chapters).
    let episodeUrl = null;

    // Episode URL pattern: /anime/{parent_slug}/{any-stub}-(N|0N)(-vf|-vostfr)?/
    // The "any-stub" doesn't have to start with parent_slug exactly — sometimes
    // typography differs (e.g. "fish-man" vs "fishman"). So we just match any
    // episode-looking URL within the parent's anime path.
    const slugEsc = slug.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    const baseEsc = VOIRANIME_BASE.replace(/\./g, "\\.");
    const epRegex = new RegExp(
      `href=["'](${baseEsc}/anime/${slugEsc}/[^"']+?-(\\d+)(?:-(?:vf|vostfr))?/)["']`,
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
      return map;
    };

    // Try detail page scrape first
    const detailRes = await fetch(`${VOIRANIME_BASE}/anime/${slug}/`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (detailRes.ok) {
      const html = await detailRes.text();
      const epMap = collectEpisodes(html);
      if (epMap.has(Number(episode))) {
        episodeUrl = epMap.get(Number(episode));
      }
    }

    // Fallback: try Madara AJAX chapters endpoint
    if (!episodeUrl) {
      try {
        const ajaxRes = await fetch(`${VOIRANIME_BASE}/wp-admin/admin-ajax.php`, {
          method: "POST",
          headers: {
            "User-Agent": "Mozilla/5.0",
            "X-Requested-With": "XMLHttpRequest",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: `action=manga_get_chapters&manga=${slug}`,
        });
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
      console.log(`[voiranime] Episode ${episode} not found in ${slug}`);
      return null;
    }

    // Fetch episode page and extract thisChapterSources
    const epRes = await fetch(episodeUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!epRes.ok) return null;
    const epHtml = await epRes.text();

    const sourcesMatch = epHtml.match(/thisChapterSources\s*=\s*({[\s\S]*?});/);
    if (!sourcesMatch) {
      console.log(`[voiranime] No thisChapterSources in ${episodeUrl}`);
      return null;
    }

    let sources;
    try {
      sources = JSON.parse(sourcesMatch[1]);
    } catch {
      console.log(`[voiranime] Failed to parse thisChapterSources JSON`);
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
      console.log(`[voiranime] Host ${serverDef.host[0]} not available for ${episodeUrl}`);
      return null;
    }

    console.log(`[voiranime] Found ep ${episode} on ${serverDef.name}: ${iframeUrl}`);

    // Try server-side extraction for known hosts
    const lower = iframeUrl.toLowerCase();
    if (EXTRACTABLE_HOSTS.some((h) => lower.includes(h))) {
      const extractor = getExtractor(iframeUrl);
      const result = await extractor(iframeUrl);
      if (result.streams?.length) return result;
    }

    // Content validation for iframe hosts that return a "404 - Not found" HTML
    // page when the specific video doesn't exist (VOE, streamtape, etc). The
    // iframe would otherwise load the error page silently.
    if (lower.includes("voe.sx") || lower.includes("voe.")) {
      try {
        const probe = await fetch(iframeUrl, {
          headers: { "User-Agent": "Mozilla/5.0" },
          redirect: "follow",
        });
        if (!probe.ok) {
          console.log(`[voiranime] VOE probe HTTP ${probe.status} — hiding server`);
          return null;
        }
        const html = await probe.text();
        if (
          html.includes("404 - Not found") ||
          html.includes("404 Not Found") ||
          /The server can ?not find the requested resource/i.test(html)
        ) {
          console.log(`[voiranime] VOE returned 404 page — hiding server`);
          return null;
        }
      } catch (e) {
        // Network error — fall through and let the client try
      }
    }

    return { iframe: iframeUrl };
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

// Quickly check if /anime/{slug}/ exists by looking for the standard <link rel="canonical"> tag.
async function voiranimeSlugExists(slug) {
  try {
    const r = await fetch(`${VOIRANIME_BASE}/anime/${slug}/`, {
      method: "GET",
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "manual",
    });
    return r.status === 200;
  } catch {
    return false;
  }
}

// Words that indicate a movie / special / film entry — never the main TV series.
const MOVIE_WORDS = ["film", "movie", "stampede", "special", "ova", "fan-letter", "kai", "log-", "log:", "episode-of", "adventure-of", "heart-of-gold", "glorious-island"];

async function findVoiranimeSlug(title, aniId, isVF, seasonNum) {
  const cacheKey = `${aniId}-${isVF ? "vf" : "vostfr"}-${seasonNum}`;
  if (voirSlugCache.has(cacheKey)) return voirSlugCache.get(cacheKey);

  // Strip season suffixes for base title
  const stripSeason = (t) =>
    t?.replace(/\s*(Season\s*\d+|\d+(st|nd|rd|th)\s*Season|Part\s*\d+|\d+期|2nd|3rd)\s*/gi, "").trim();

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

  // ── Strategy 1: direct slug guessing (much faster than search) ──
  // For S2+ try {base}-{N}, S1 try {base}. Always try with/without -vf.
  const slugCandidates = new Set();
  for (const t of titles) {
    const base = titleToSlug(t);
    if (!base) continue;
    if (seasonNum > 1) {
      slugCandidates.add(isVF ? `${base}-${seasonNum}-vf` : `${base}-${seasonNum}`);
    }
    slugCandidates.add(isVF ? `${base}-vf` : base);
    // NOTE: do NOT fall back to the un-suffixed slug for VF requests — that
    // slug is the VOSTFR variant and would silently serve the wrong language.
  }

  for (const cand of slugCandidates) {
    if (await voiranimeSlugExists(cand)) {
      voirSlugCache.set(cacheKey, cand);
      return cand;
    }
  }

  // ── Strategy 2: search fallback with stricter scoring ──
  for (const q of titles) {
    try {
      const res = await fetch(`${VOIRANIME_BASE}/wp-admin/admin-ajax.php`, {
        method: "POST",
        headers: {
          "User-Agent": "Mozilla/5.0",
          "X-Requested-With": "XMLHttpRequest",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `action=wp-manga-search-manga&title=${encodeURIComponent(q)}`,
      });
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
          const seasonMatch = cleanSlug.match(/-(\d+)$/);
          const slugSeason = seasonMatch ? Number(seasonMatch[1]) : 1;
          const seasonStripped = cleanSlug.replace(/-\d+$/, "");

          let score = 0;
          // HARD reject if language mismatches — VF request must yield -vf slug, etc.
          if (isVfSlug !== isVF) return { slug, score: -1 };
          // Reject movies/specials hard — never used for TV episode lookup
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

  // Cache the failure too — avoid hammering search on every probe
  voirSlugCache.set(cacheKey, null);
  return null;
}

// ── Consumet providers (AnimeSaturn, AnimeUnity) ─────────────
const CONSUMET_PROVIDERS = {
  animesaturn: { cls: ANIME.AnimeSaturn, lang: "sub" },
};

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

// ── Handler ─────────────────────────────────────────────────
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

  // If the client passed pre-fetched AniList metadata (from watch page SSR),
  // prime the cache so no helper has to call AniList itself.
  if (mediaMeta && aniId) primeMediaCache(aniId, mediaMeta);

  // Miruro HLS
  if (MIRURO_PROVIDERS[server]) {
    const provider = MIRURO_PROVIDERS[server];
    const data = await getMiruroStream(provider, aniId, episode, sub);
    if (!data) {
      return res.status(404).json({ error: "Source not found" });
    }
    return res.status(200).json(data);
  }

  // Helper to resolve anime title — uses shared cache, only hits AniList if missing
  async function resolveTitle() {
    if (title) return title;
    const m = await getMediaMeta(aniId);
    return m?.title?.english || m?.title?.romaji || null;
  }

  // HiAnime — returns iframe embed URL
  if (HIANIME_SERVERS[server]) {
    const searchTitle = await resolveTitle();
    if (!searchTitle) {
      return res.status(404).json({ error: "Could not resolve anime title" });
    }
    const data = await getHiAnimeIframe(server, searchTitle, episode, sub);
    if (!data) {
      return res.status(404).json({ error: "Source not found" });
    }
    return res.status(200).json(data);
  }

  // Anime-Sama (VF + VOSTFR) — returns iframe embed URL
  if (ANIMESAMA_SERVERS[server]) {
    const searchTitle = await resolveTitle();
    if (!searchTitle) {
      return res.status(404).json({ error: "Could not resolve anime title" });
    }
    const data = await getAnimeSamaIframe(server, searchTitle, episode, aniId);
    if (!data) {
      return res.status(404).json({ error: "Source not found" });
    }
    return res.status(200).json(data);
  }

  // voir-anime.to (VF + VOSTFR) — Madara/WordPress source
  if (VOIRANIME_SERVERS[server]) {
    const searchTitle = await resolveTitle();
    if (!searchTitle) {
      return res.status(404).json({ error: "Could not resolve anime title" });
    }
    const data = await getVoiranimeIframe(server, searchTitle, episode, aniId);
    if (!data) {
      return res.status(404).json({ error: "Source not found" });
    }
    return res.status(200).json(data);
  }

  // CoorenLabs — needs anime title for search
  if (COOREN_PROVIDERS[server]) {
    const searchTitle = await resolveTitle();
    if (!searchTitle) {
      return res.status(404).json({ error: "Could not resolve anime title" });
    }

    const data = await getCoorenStream(server, searchTitle, episode, sub);
    if (!data) {
      return res.status(404).json({ error: "Source not found" });
    }
    return res.status(200).json(data);
  }

  // Consumet providers (AnimeSaturn, AnimeUnity)
  if (CONSUMET_PROVIDERS[server]) {
    const searchTitle = await resolveTitle();
    if (!searchTitle) {
      return res.status(404).json({ error: "Could not resolve anime title" });
    }
    const data = await getConsumetStream(server, searchTitle, episode, sub);
    if (!data) {
      return res.status(404).json({ error: "Source not found" });
    }
    return res.status(200).json(data);
  }

  return res.status(400).json({ error: "Unknown server" });
}
