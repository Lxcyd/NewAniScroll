/**
 * AniScroll HLS proxy — Cloudflare Worker edition.
 *
 * Same contract as /api/v2/proxy/m3u8 on the Next.js side:
 *   GET https://<worker>/?url=<encoded>&referer=<optional>&vcookie=<optional>
 *
 * Why a Worker:
 *   - Vercel Fast Origin Transfer is metered (10 GB free), and every .ts segment
 *     goes through the proxy. A single popular episode burns 200-700 MB.
 *   - Cloudflare Workers have unmetered bandwidth + global edge cache. We can
 *     keep the Vercel proxy as a fallback (NEXT_PUBLIC_PROXY_BASE unset) while
 *     production points everything at the Worker.
 *
 * VOE cookie handling:
 *   The Next.js side already captures VOE's DDoS-Guard cookies during extract.
 *   To make the cookie available to the Worker without a shared store, the
 *   extractor embeds it as `vcookie=` in the playback URL handed to the client.
 *   The Worker reads it back here and forwards it as the `Cookie` header.
 *
 * This Worker also serves a few endpoints offloaded from Vercel to cut Fluid
 * Active CPU — see ./edge-endpoints.js (/w/status, /w/broadcast, /w/track).
 */

import { handleEdgeEndpoint } from "./edge-endpoints.js";

// CDNs that genuinely need single-flight requests per IP. Keep this list short
// — every entry slows down playback for that host. Only VOE's
// cloudwindow-route.com is documented to 403 on parallel hits.
const SERIALIZED_HOST_PATTERNS = [/cloudwindow-route\.com$/];
const serialQueues = new Map(); // host -> promise tail

function shouldSerialize(host) {
  return SERIALIZED_HOST_PATTERNS.some((re) => re.test(host));
}

async function serializedFetch(targetUrl, init) {
  const host = new URL(targetUrl).hostname;
  if (!shouldSerialize(host)) return fetch(targetUrl, init);
  const prev = serialQueues.get(host) || Promise.resolve();
  let release;
  const ours = new Promise((r) => (release = r));
  serialQueues.set(host, ours);
  try {
    await prev;
    return await fetch(targetUrl, init);
  } finally {
    release();
    if (serialQueues.get(host) === ours) serialQueues.delete(host);
  }
}

// Mirrors the host → referer logic from pages/api/v2/proxy/m3u8.js so direct
// links built by the client (which don't carry a referer query param for
// historical reasons) still authenticate against the upstream CDN.
function detectReferer(targetUrl) {
  if (
    targetUrl.includes("kwik.") ||
    targetUrl.includes("uwucdn.") ||
    targetUrl.includes("owocdn.") ||
    targetUrl.includes("nextcdn.") ||
    targetUrl.includes("files.nextcdn.")
  ) {
    return { referer: "https://kwik.cx/", origin: "https://kwik.cx" };
  }
  if (targetUrl.includes("animepahe.")) {
    return { referer: "https://animepahe.ru/", origin: null };
  }
  let host;
  try {
    host = new URL(targetUrl).hostname;
  } catch {
    host = "";
  }
  if (
    targetUrl.includes("megaup.") ||
    targetUrl.includes("stormshade") ||
    targetUrl.includes("mgstatics.") ||
    /rrr\.[a-z0-9]+\.(site|com|xyz)/.test(targetUrl) ||
    /[a-z]+\d+\.(xyz|live|site)/.test(host)
  ) {
    return { referer: "https://megaup.cc/", origin: "https://megaup.cc" };
  }
  if (targetUrl.includes("sibnet.ru")) {
    return {
      referer: "https://video.sibnet.ru/",
      origin: "https://video.sibnet.ru",
    };
  }
  if (targetUrl.includes("sendvid.")) {
    return { referer: "https://sendvid.com/", origin: "https://sendvid.com" };
  }
  if (targetUrl.includes("vmwesa.") || targetUrl.includes("vidmoly.")) {
    return { referer: "https://vidmoly.net/", origin: "https://vidmoly.net" };
  }
  if (
    targetUrl.includes("mewstream.buzz") ||
    targetUrl.includes("lostproject.club") ||
    targetUrl.includes("megaplay.buzz")
  ) {
    return { referer: "https://megaplay.buzz/", origin: "https://megaplay.buzz" };
  }
  return { referer: null, origin: null };
}

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges, Content-Type, X-Aniscroll-Cache",
    ...extra,
  };
}

async function handle(request, env, ctx) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  const reqUrl = new URL(request.url);
  const url = reqUrl.searchParams.get("url");
  const referer = reqUrl.searchParams.get("referer");
  const vcookie = reqUrl.searchParams.get("vcookie");
  // Download mode. When set, the response is served as `Content-Disposition:
  // attachment` so the browser saves it. For binary content (.mp4 / .ts /
  // single segments) this works directly. For .m3u8 we rewrite the manifest
  // with ABSOLUTE proxy URLs (instead of relative-to-proxy ones) and serve
  // it as a downloadable playlist file — the user opens it in VLC / mpv /
  // yt-dlp / ffmpeg which then fetches the segments directly from Cloudflare
  // (zero Vercel transit). Free CF Workers cap subrequests at 50/req which
  // is below the ~240-segment count of a typical 24-min HLS episode, so we
  // intentionally don't concat server-side here.
  const isDownload = reqUrl.searchParams.get("dl") === "1";
  const downloadFilename = reqUrl.searchParams.get("filename") || null;
  // Pre-warm depth budget (see the m3u8 warm-up below). A normal player request
  // arrives with no `warm` param (depth 0); it warms its child PLAYLISTS at
  // depth 1, then stops. We deliberately warm ONLY the manifest tree (master →
  // variant playlists — small text files, a few KB each) and NOT the segments:
  // a segment is a multi-MB binary, and an earlier 2-level version that warmed
  // the opening segments re-downloaded ~12 × multi-MB in parallel, starving the
  // Worker's I/O budget and turning a 0.5 s cold segment into a 25-78 s stall on
  // less-popular titles. Warming just the playlists kills the manifest-resolution
  // spike (the part that visibly delayed Play/seek) at near-zero cost; the deep
  // hls.js buffer covers the segments themselves.
  const warmDepth = Math.max(0, parseInt(reqUrl.searchParams.get("warm") || "0", 10) || 0);
  // Depth 2 so a MASTER → VARIANT → SEGMENTS chain warms all the way to the
  // segments: master (depth 0) warms the variant (depth 1), which in turn warms
  // its sampled segments (depth 2). A media playlist served directly (no master)
  // warms its segments at depth 1. Kept from exploding by warming only ONE
  // variant (see below), so the worst case is 1 variant + 10 sampled segments.
  const WARM_MAX_DEPTH = 2;

  if (!url) {
    return new Response(JSON.stringify({ error: "Missing url parameter" }), {
      status: 400,
      headers: corsHeaders({ "Content-Type": "application/json" }),
    });
  }

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(url);
  } catch {
    targetUrl = url;
  }

  let targetOrigin;
  try {
    targetOrigin = new URL(targetUrl).origin;
  } catch {
    return new Response(JSON.stringify({ error: "Bad target URL" }), {
      status: 400,
      headers: corsHeaders({ "Content-Type": "application/json" }),
    });
  }

  const auto = detectReferer(targetUrl);
  const finalReferer = referer
    ? decodeURIComponent(referer)
    : auto.referer || targetOrigin + "/";
  const finalOrigin = auto.origin || targetOrigin;

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Referer: finalReferer,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Sec-Fetch-Dest": "video",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "cross-site",
  };
  // Origin is only set when actually needed (some CDNs reject when it's
  // present for same-origin asset fetches — sibnet's video pipeline being
  // the canonical case where Origin: video.sibnet.ru caused a 400).
  if (
    finalOrigin &&
    !targetUrl.includes("sibnet.ru") &&
    !targetUrl.includes("acek-cdn.com")
  ) {
    headers.Origin = finalOrigin;
  }
  // Range handling. Browsers open <video> MP4s with `Range: bytes=0-`; if we
  // forwarded that, upstream would answer 206 — and cache.put REJECTS 206
  // partials, so MP4s would never be cacheable. A 200 is a valid answer to
  // `bytes=0-`, so we upgrade that opening request to a full fetch (200 →
  // cacheable). Real mid-file ranges (seeks) are forwarded as-is and served
  // uncached on miss; once the full 200 is stored, cache.match slices 206s
  // out of it directly at the edge (see lookup below).
  const rangeHeader = request.headers.get("range");
  const isOpeningRange = !rangeHeader || /^bytes=0-$/i.test(rangeHeader.trim());
  if (rangeHeader && !isOpeningRange) headers.Range = rangeHeader;
  if (vcookie) {
    try {
      headers.Cookie = decodeURIComponent(vcookie);
    } catch {
      headers.Cookie = vcookie;
    }
  }

  // CF edge cache lookup — the same URL across viewers hits this and skips
  // the upstream fetch entirely. Critical for the proxy-routed hosts: most
  // segments after the first viewer are free.
  const cache = caches.default;
  // Normalise the cache key by stripping vcookie (per-user) and download
  // params — the upstream bytes are identical, only the wrapper differs.
  // `warm` is stripped too so a pre-warm subrequest stores under the SAME key
  // the player's plain request later looks up (otherwise the warm would be a
  // wasted miss).
  const cacheKeyUrl = new URL(reqUrl);
  cacheKeyUrl.searchParams.delete("vcookie");
  cacheKeyUrl.searchParams.delete("dl");
  cacheKeyUrl.searchParams.delete("filename");
  cacheKeyUrl.searchParams.delete("warm");
  cacheKeyUrl.searchParams.delete("nx");
  // Lecture anticipee (cf. la reecriture des playlists megaplay) : lancee des
  // l'arrivee de la requete, en parallele de sa propre reponse.
  const aAnticiper = reqUrl.searchParams.getAll("nx");
  if (aAnticiper.length && ctx && request.method === "GET" && !isDownload) {
    ctx.waitUntil(lireEnAvance(aAnticiper, referer, `${reqUrl.origin}${reqUrl.pathname}`));
  }
  const cacheKey = new Request(cacheKeyUrl.toString(), { method: "GET" });
  // The LOOKUP carries the client's Range header: cache.match slices a stored
  // full 200 into the requested 206 directly at the edge (documented Cache API
  // behaviour) — that's what makes MP4 seeks instant on a warm cache.
  const cacheLookup = rangeHeader && !isOpeningRange
    ? new Request(cacheKeyUrl.toString(), {
        method: "GET",
        headers: { Range: rangeHeader },
      })
    : cacheKey;
  // Only use cache for GET. (HEAD doesn't have a body to cache.)
  if (request.method === "GET" && !isDownload) {
    const cached = await cache.match(cacheLookup);
    if (cached) {
      // Rebuild so headers are mutable (cache.match responses are immutable).
      // Les segments mis en cache AVANT `corrigeTypeVideo` gardent 24 h leur
      // faux type image : on le corrige aussi a la lecture.
      const c = await corrigeTypeVideo(cached.body, cached.headers.get("content-type"));
      const hit = new Response(c.body, cached);
      if (c.type) hit.headers.set("Content-Type", c.type);
      if (c.retaille) hit.headers.delete("Content-Length");
      hit.headers.set("X-Aniscroll-Cache", "HIT");
      return hit;
    }
  }

  let response;
  // Manual redirect handling.
  //
  // Cloudflare's `fetch(..., { redirect: "follow" })` does NOT carry our
  // explicit headers across the redirect — it issues a fresh request without
  // Referer/Origin, which some CDNs (sibnet's dv97/cvnXX hop chain is the
  // canonical case) reject with 400. We follow manually so every hop keeps
  // the same User-Agent + Referer the original request had, AND so any
  // Set-Cookie a hop hands out is replayed on the next hop.
  let currentUrl = targetUrl;
  let currentHeaders = { ...headers };
  const MAX_REDIRECTS = 5;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    response = await serializedFetch(currentUrl, {
      headers: currentHeaders,
      redirect: "manual",
    });
    // Single retry on 403 (cold CDN hit) — applies only to the FINAL hop.
    if (response.status === 403 && i === 0) {
      await new Promise((r) => setTimeout(r, 300));
      response = await serializedFetch(currentUrl, {
        headers: currentHeaders,
        redirect: "manual",
      });
    }
    // Not a redirect → done. 3xx without Location is also "done" (treated
    // as terminal so we don't loop forever on a broken upstream).
    const status = response.status;
    const isRedirect = status >= 300 && status < 400 && status !== 304;
    const location = isRedirect ? response.headers.get("location") : null;
    if (!isRedirect || !location) break;
    // Resolve protocol-relative + relative URLs against the current URL.
    let next;
    try {
      next = new URL(location, currentUrl).toString();
    } catch {
      break;
    }
    // Carry any Set-Cookie the hop issued into the next hop's Cookie header.
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      // Keep only the `key=value` pair from each Set-Cookie (strip path /
      // expires / domain attributes).
      const pairs = setCookie
        .split(/,\s*(?=[^;]+=)/)
        .map((c) => c.split(";")[0].trim())
        .filter(Boolean)
        .join("; ");
      currentHeaders = {
        ...currentHeaders,
        Cookie: currentHeaders.Cookie
          ? `${currentHeaders.Cookie}; ${pairs}`
          : pairs,
      };
    }
    currentUrl = next;
  }

  /* Reprise megaplay, segment par segment. Leurs CDN meurent EN PLEINE
     LECTURE : la playlist a ete reecrite avec l'hote vivant d'il y a une
     minute, qui rend maintenant 403. Leur lecteur change d'hote a la volee ;
     hls.js reessaie, le lecteur natif d'iOS abandonne — d'ou megaplay
     « aleatoire » sur iPhone. On relit donc la liste des CDN (fraiche) et on
     redemande le MEME chemin au miroir du moment. Playlists exclues : c'est
     leur hote d'origine qui fait foi. */
  if (
    !response.ok &&
    response.status !== 206 &&
    /megaplay\.buzz/i.test(finalReferer || "") &&
    !/\.m3u8(\?|$)/i.test(targetUrl)
  ) {
    const miroir = await cdnMegaplay(true);
    try {
      const u = new URL(currentUrl);
      if (miroir && u.hostname !== miroir.fallback) {
        u.hostname = miroir.fallback;
        const r2 = await serializedFetch(u.toString(), {
          headers: currentHeaders,
          redirect: "follow",
        });
        if (r2.ok) response = r2;
      }
    } catch {
      /* on garde la premiere reponse */
    }
  }

  // Helper that stores the final response under the normalised cache key
  // before returning it. Skip caching for downloads (Content-Disposition
  // varies per filename), error responses (don't pin a 4xx upstream blip in
  // cache for 24h) and 206 partials (cache.put rejects them by design — the
  // full-200 path populates the cache instead). The put is fire-and-forget:
  // oversized bodies (Cache API caps objects at ~512 MB) just fail silently.
  const respondAndCache = (res) => {
    res.headers.set("X-Aniscroll-Cache", "MISS");
    const okToCache =
      !isDownload && request.method === "GET" && res.status === 200;
    if (okToCache && ctx) {
      ctx.waitUntil(cache.put(cacheKey, res.clone()).catch(() => {}));
    }
    return res;
  };

  if (!response.ok && response.status !== 206) {
    const fatal = [401, 403, 404, 410].includes(response.status)
      ? 410
      : response.status;
    return new Response(
      JSON.stringify({ error: "Upstream error", upstream: response.status }),
      {
        status: fatal,
        headers: corsHeaders({ "Content-Type": "application/json" }),
      },
    );
  }

  const contentType = response.headers.get("content-type") || "";
  const isM3u8 =
    contentType.includes("mpegurl") ||
    contentType.includes("m3u") ||
    targetUrl.includes(".m3u8");

  // Build the proxy URL the manifest will reference for nested resources. We
  // use the SAME origin the client hit so manifest rewrites stay relative to
  // the deployment that served them — works whether you're on the Worker, a
  // preview deploy, or the Vercel fallback.
  const proxyBase = `${reqUrl.origin}${reqUrl.pathname}`;

  if (isM3u8) {
    let body = await response.text();
    const trimmed = body.trim();
    if (trimmed.startsWith("<!") || trimmed.startsWith("<html")) {
      return new Response(
        JSON.stringify({ error: "Got HTML instead of m3u8 stream" }),
        {
          status: 502,
          headers: corsHeaders({ "Content-Type": "application/json" }),
        },
      );
    }

    // Propagate the referer + vcookie to nested requests so segments / keys
    // authenticate the same way the manifest did. In download mode we use
    // the same params (segments and keys still go through this Worker), the
    // only difference is the manifest gets sent as a downloadable file.
    const effectiveReferer = referer ? decodeURIComponent(referer) : auto.referer;
    const refParam = effectiveReferer
      ? `&referer=${encodeURIComponent(effectiveReferer)}`
      : "";
    const cookieParam = vcookie ? `&vcookie=${encodeURIComponent(decodeURIComponent(vcookie))}` : "";

    const toAbsolute = (u) => {
      if (u.startsWith("http")) return u;
      try {
        return new URL(u, targetUrl).toString();
      } catch {
        return u;
      }
    };
    const rewrite = (abs) =>
      `${proxyBase}?url=${encodeURIComponent(abs)}${refParam}${cookieParam}`;

    // Collect the first few resource URLs (in playlist order) as we rewrite, so
    // we can pre-warm them into the edge cache below. For a MASTER playlist these
    // are the variant sub-playlists; for a MEDIA playlist they're the opening
    // .ts/.m4s segments — both are exactly what the player fetches next, and both
    // are where the mewstream/lumiflow CDN's cold-hit latency spikes (measured up
    // to ~5 s on a cache miss). Warming them now, while the manifest is still in
    // flight to the player, means the player's request lands on a HIT instead of
    // paying that spike on the user's first Play / seek.
    const resourceUrls = [];
    const estMegaplay = /megaplay\.buzz/i.test(effectiveReferer || "");
    const miroir = estMegaplay ? await cdnMegaplay() : null;
    /* Qualite la plus BASSE en tete, pour megaplay. Leur CDN bride chaque
       connexion a ~1 Mb/s (100-200 Ko/s mesures le 29/09/2026, en direct
       comme par ce Worker) et leur master liste la 1080p (1,5 Mb/s) en
       premier. Le lecteur natif de Safari demarre sur la PREMIERE variante :
       un segment de 1-3 Mo, 10-25 s d'attente, et le lecteur abandonnait.
       En tete, la 480p (0,65 Mb/s) tient sous le bridage ; l'ABR remonte
       ensuite si le debit le permet. hls.js trie les niveaux lui-meme, il
       n'est pas affecte. */
    if (estMegaplay && /#EXT-X-STREAM-INF/.test(body)) body = variantesCroissantes(body);
    const absolu = (u) => remplaceCdnMort(toAbsolute(u), miroir);
    body = body.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${rewrite(absolu(uri))}"`);
    /* LECTURE ANTICIPEE (megaplay, playlist de segments seulement). Leur CDN
       bride chaque CONNEXION a ~100 Ko/s et hls.js demande les segments un par
       un : 3-4 s pour 4 s de video, premiere image vers 12 s (chrono du
       29/09/2026). Chaque segment porte donc l'adresse des suivants (`nx`) ;
       quand on le sert, on va chercher ceux-la EN PARALLELE vers le cache
       (cf. `lireEnAvance`), et le lecteur les trouve prets. */
    const lignesRessources = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => absolu(l));
    const anticipe = estMegaplay && !/#EXT-X-STREAM-INF/.test(body);
    let rang = 0;
    body = body.replace(/^(?!#)(.+)$/gm, (line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return line;
      const abs = absolu(t);
      resourceUrls.push(abs);
      const suivants = anticipe ? lignesRessources.slice(rang + 1, rang + 1 + LECTURE_AVANCE) : [];
      rang++;
      return rewrite(abs) + suivants.map((n) => `&nx=${encodeURIComponent(n)}`).join("");
    });

    // Pre-warm resources through this same Worker URL so they land under the
    // normal cache key (respondAndCache path) — the player's subsequent request
    // then matches the edge cache. Fire-and-forget via waitUntil so it never
    // delays the manifest response.
    if (ctx && warmDepth < WARM_MAX_DEPTH && resourceUrls.length > 0) {
      const childDepth = warmDepth + 1;
      // MASTER playlist → children are variant .m3u8s. Warm only ONE (a cheap
      // text fetch) — that variant then warms its own sampled segments one depth
      // down. Warming every variant would multiply the segment warm by 4 and
      // blow the subrequest budget; hls.js plays one variant at a time anyway.
      // Pick the LAST variant: HLS masters list variants low→high bitrate, and
      // the player defaults to forceMaxQuality (top level), so the last is the
      // one most likely actually played — warming it makes its segments the hot
      // ones. (If ABR is on and picks a lower rung, only the sparse segment warm
      // is "wasted"; the manifest warm still helps.)
      const allPlaylists = resourceUrls.filter((u) => /\.m3u8(\?|$)/i.test(u));
      // Megaplay : son master est trie par debit croissant et le lecteur part
      // du plus bas — c'est donc la PREMIERE variante qui sera jouee.
      const choisie = estMegaplay ? allPlaylists[0] : allPlaylists[allPlaylists.length - 1];
      const playlists = allPlaylists.length > 0 ? [choisie] : [];
      // MEDIA playlist → children are the actual .ts/.m4s segments. THIS is what
      // makes a far seek instant: without it, clicking anywhere past the opening
      // hls.js buffer hits a cold segment (~3 s origin fetch). We warm a SPARSE
      // sample spread across the whole timeline — one segment every Nth — so any
      // point on the scrubber lands on (or right next to) an already-cached
      // segment. Sparse + sequential + capped keeps this within the Worker's
      // subrequest budget and never bursts alongside the player's real fetches
      // (the mistake an earlier version made by warming the opening N segments in
      // parallel, which starved I/O). Skipped entirely for master playlists.
      // In a MEDIA playlist every non-#tag line IS a segment, whatever its
      // extension — MegaCloud disguises segments as .jpg/.html/.js/.png/.txt to
      // dodge filters, so matching a fixed extension list MISSED most of them
      // (only ~1/3 got warmed). "Everything that isn't a child .m3u8" is the
      // robust rule: resourceUrls here are already just the playlist's resource
      // lines, and if there were child playlists we'd be in the master branch.
      const segments = playlists.length === 0
        ? resourceUrls.filter((u) => !/\.m3u8(\?|$)/i.test(u))
        : [];
      // 20 samples across the timeline. For a ~340-segment (24-min) episode
      // that's a warm point every ~1 min of video, so a far seek lands within a
      // few seconds of a hot segment. Still cheap: 20 sequential background
      // fetches per media playlist, one variant deep.
      const WARM_SEGMENT_SAMPLES = 20;
      const sampledSegments = [];
      if (segments.length > 0) {
        // Even stride across the timeline; always include the first so playback
        // start is warm too. De-dupe when the list is shorter than the sample.
        const stride = Math.max(1, Math.ceil(segments.length / WARM_SEGMENT_SAMPLES));
        for (let i = 0; i < segments.length; i += stride) sampledSegments.push(segments[i]);
      }
      const toWarm = [...playlists, ...sampledSegments];
      if (toWarm.length > 0) {
        const warm = async () => {
          // Sequential, not parallel: a warm fetch must never burst alongside
          // the player's foreground requests. Carry warm=<childDepth> so the
          // cache key (which strips `warm`) matches the player's plain lookup.
          // Segments are leaves (warmDepth reaches WARM_MAX_DEPTH), so warming
          // them issues no further recursion.
          for (const abs of toWarm) {
            await fetch(`${rewrite(abs)}&warm=${childDepth}`).catch(() => {});
          }
        };
        ctx.waitUntil(warm());
      }
    }

    // Download mode → emit as attachment so the browser saves the .m3u8
    // playlist. VLC / mpv / yt-dlp / ffmpeg can open it directly and fetch
    // segments straight from the Worker — bytes never touch Vercel.
    if (isDownload) {
      const name = (downloadFilename || "episode.m3u8")
        .replace(/[^\w.-]/g, "_")
        .replace(/\.(ts|mp4)$/i, ".m3u8");
      return new Response(body, {
        status: 200,
        headers: corsHeaders({
          "Content-Type": "application/vnd.apple.mpegurl",
          "Content-Disposition": `attachment; filename="${name}"`,
          // Don't cache downloads — the file points at signed segment
          // URLs whose tokens rotate; serving stale would deliver a
          // playlist with expired links.
          "Cache-Control": "private, no-store",
        }),
      });
    }

    return respondAndCache(
      new Response(body, {
        status: 200,
        headers: corsHeaders({
          "Content-Type": "application/vnd.apple.mpegurl",
          // m3u8 manifests can rotate tokens — short edge cache only.
          "Cache-Control": "public, s-maxage=30, max-age=0",
        }),
      }),
    );
  }

  // Pick a cache policy by content type:
  //   - Binary (.ts / mp4 / keys): 24 h immutable. Token in URL is the cache
  //     key, so a rotation misses cache automatically. This is the bandwidth
  //     win.
  //   - HTML / JS / JSON (anime-sama catalog pages, embed shells, episodes.js,
  //     extractor responses): cap at 60 s. These pages embed short-lived
  //     tokens — caching them for 24 h would re-serve a dead token long after
  //     it expired upstream.
  // Le type CORRIGE decide : un segment deguise en .html est un segment, et
  // merite les 24 h d'un binaire, pas les 60 s d'une page.
  const corrige = await corrigeTypeVideo(response.body, contentType);
  const typeReel = corrige.type || "";
  const isTextContent =
    typeReel.includes("text/html") ||
    typeReel.includes("application/xhtml") ||
    typeReel.includes("application/javascript") ||
    typeReel.includes("text/javascript") ||
    typeReel.includes("application/json") ||
    typeReel.includes("text/plain");
  const cacheControl = isTextContent
    ? "public, s-maxage=60, max-age=0"
    : "public, s-maxage=86400, max-age=3600, immutable";
  const passthroughHeaders = corsHeaders({
    "Content-Type": corrige.type || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl,
  });
  const upstreamRange = response.headers.get("content-range");
  const upstreamLength = response.headers.get("content-length");
  if (upstreamRange) passthroughHeaders["Content-Range"] = upstreamRange;
  if (upstreamLength && !corrige.retaille) passthroughHeaders["Content-Length"] = upstreamLength;

  // Download mode for direct binary files (MP4 sources, single .ts blobs):
  // add Content-Disposition so the browser saves instead of inlining.
  // Cache stays public — the file's URL token is its cache key, so a fresh
  // download with the same token hits the edge, and a token rotation
  // automatically misses (just like normal segment serving).
  if (isDownload) {
    const ext = (contentType.includes("mp4") ? "mp4" : "ts");
    const fallbackName = downloadFilename || `episode.${ext}`;
    const safe = fallbackName.replace(/[^\w.-]/g, "_");
    passthroughHeaders["Content-Disposition"] = `attachment; filename="${safe}"`;
  }

  return respondAndCache(
    new Response(corrige.body, {
      status: response.status,
      headers: passthroughHeaders,
    }),
  );
}

/* CDN MORTS de megaplay. Leurs playlists pointent des hotes qui tournent et
   meurent (28/09/2026 : `ajr25.neonsummit.top` rendait 403 a tout le monde).
   Leur propre lecteur ne les lit pas tels quels : il consulte
   `megaplay.buzz/lib/check_domain.json` — `{ fallback, failed: [...] }`, mis a
   jour en continu — et remplace un hote de `failed` par `fallback`. On fait
   pareil en reecrivant la playlist. Liste gardee 5 min par isolat ; si elle ne
   repond pas, on garde la derniere connue, a defaut on ne touche a rien. */
let cdnMemo = null;
async function cdnMegaplay(frais = false) {
  // `frais` : un segment vient d'echouer, la liste a peut-etre bouge — mais pas
  // plus d'une relecture par 20 s et par isolat, pour ne pas la marteler.
  const age = cdnMemo ? Date.now() - cdnMemo.at : Infinity;
  if (age < (frais ? 20 * 1000 : 5 * 60 * 1000)) return cdnMemo;
  try {
    const r = await fetch("https://megaplay.buzz/lib/check_domain.json", {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Referer: "https://megaplay.buzz/",
      },
    });
    const j = r.ok ? await r.json() : null;
    if (j && typeof j.fallback === "string" && Array.isArray(j.failed)) {
      cdnMemo = { at: Date.now(), fallback: j.fallback, failed: new Set(j.failed) };
    }
  } catch {
    /* derniere liste connue */
  }
  return cdnMemo;
}

const LECTURE_AVANCE = 3;

/** Met en cache, en parallele, les segments qui suivent — en les tirant
 *  NOUS-MEMES de l'amont. (Un `fetch` vers notre propre domaine ne repasse pas
 *  par le Worker : Cloudflare coupe l'auto-appel, la premiere version ne
 *  mettait donc rien en cache.) La cle est celle que le lecteur demandera :
 *  `?url=…&referer=…`, sans `nx`. Deja en cache : rien a faire. */
async function lireEnAvance(cibles, referer, base) {
  const cache = caches.default;
  const ref = referer ? decodeURIComponent(referer) : "https://megaplay.buzz/";
  const entetes = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Referer: ref,
    Accept: "*/*",
  };
  await Promise.all(
    cibles.slice(0, LECTURE_AVANCE).map(async (cible) => {
      if (/\.m3u8(\?|$)/i.test(cible)) return;
      const q = new URLSearchParams({ url: cible });
      if (referer) q.set("referer", referer);
      const cle = new Request(`${base}?${q.toString()}`, { method: "GET" });
      if (await cache.match(cle)) return;
      try {
        let r = await fetch(cible, { headers: entetes });
        if (!r.ok) {
          // meme reprise que le chemin principal : CDN mort → miroir du moment
          const miroir = await cdnMegaplay(true);
          const u = new URL(cible);
          if (miroir && u.hostname !== miroir.fallback) {
            u.hostname = miroir.fallback;
            r = await fetch(u.toString(), { headers: entetes });
          }
        }
        if (!r.ok) return;
        const c = await corrigeTypeVideo(r.body, r.headers.get("content-type") || "");
        const h = corsHeaders({
          "Content-Type": c.type || "application/octet-stream",
          "Accept-Ranges": "bytes",
          "Cache-Control": "public, s-maxage=86400, max-age=3600, immutable",
          "X-Aniscroll-Cache": "WARM",
        });
        const octets = await new Response(c.body).arrayBuffer();
        h["Content-Length"] = String(octets.byteLength);
        await cache.put(cle, new Response(octets, { status: 200, headers: h }));
      } catch {
        /* une anticipation ratee ne coute rien : le lecteur la demandera */
      }
    }),
  );
}

/** Un master avec ses variantes triees par BANDWIDTH croissante (les
 *  `EXT-X-STREAM-INF` gardent chacune leur URI ; le reste de l'en-tete reste
 *  en tete, dans l'ordre). */
function variantesCroissantes(texte) {
  const lignes = texte.split(/\r?\n/);
  const tete = [];
  const variantes = [];
  let i = 0;
  while (i < lignes.length) {
    const l = lignes[i];
    if (/^#EXT-X-STREAM-INF/i.test(l)) {
      let j = i + 1;
      while (j < lignes.length && (!lignes[j].trim() || lignes[j].startsWith("#"))) j++;
      const bw = Number(/BANDWIDTH=(\d+)/i.exec(l)?.[1] || 0);
      variantes.push({ bw, bloc: lignes.slice(i, j + 1) });
      i = j + 1;
    } else {
      if (l.trim()) tete.push(l);
      i++;
    }
  }
  if (variantes.length < 2) return texte;
  variantes.sort((a, b) => a.bw - b.bw);
  return [...tete, ...variantes.flatMap((v) => v.bloc)].join("\n") + "\n";
}

function remplaceCdnMort(abs, miroir) {
  if (!miroir) return abs;
  try {
    const u = new URL(abs);
    if (!miroir.failed.has(u.hostname)) return abs;
    u.hostname = miroir.fallback;
    return u.toString();
  } catch {
    return abs;
  }
}

/* Segments DEGUISES. MegaCloud (megaplay) sert ses segments MPEG-TS sous des
   noms en .jpg, avec `Content-Type: image/jpeg`. hls.js ne regarde pas le type
   et joue ; le lecteur HLS NATIF d'iOS, lui, s'y fie et refuse le segment —
   megaplay jouait sur PC et restait noir sur iPhone (28/09/2026). On ne touche
   qu'aux reponses annoncees « image/* » : on lit le premier morceau, et s'il
   commence comme du TS (octet de synchro 0x47) ou du fMP4 (`ftyp`/`styp`/
   `moof` a l'octet 4), on corrige le type. Une vraie image passe intacte. */
async function corrigeTypeVideo(body, type) {
  /* Deguises en .jpg, .html, .js, .png, .txt : on regarde tout ce qui
     s'annonce image, texte ou script. Une vraie page commence par `<`, un
     script par du texte — jamais par 0x47 ni par une boite MP4. */
  const suspect = /^(image\/|text\/|application\/(javascript|x-javascript|json|octet-stream))/i;
  if (!body || !suspect.test(type || "application/octet-stream")) return { body, type };
  const lecteur = body.getReader();
  const premier = await lecteur.read();
  let octets = premier.value || new Uint8Array(0);
  /* LEURRE PNG (cf. tools/opening-detector/oped/megaplay.py, `depng`) : un PNG
     1x1 d'une soixantaine d'octets, puis le vrai MPEG-TS. hls.js retrouve la
     synchro plus loin ; un lecteur natif voit une image et abandonne. On
     saute le PNG et on se cale sur une vraie suite de synchros TS (0x47 tous
     les 188 octets), comme le detecteur. */
  if (octets[0] === 0x89 && octets[1] === 0x50 && octets[2] === 0x4e && octets[3] === 0x47) {
    let acc = octets;
    let fini = premier.done;
    while (acc.length < 16384 && !fini) {
      const r = await lecteur.read();
      if (r.done) fini = true;
      else {
        const n = new Uint8Array(acc.length + r.value.length);
        n.set(acc);
        n.set(r.value, acc.length);
        acc = n;
      }
    }
    let iend = -1;
    for (let i = 8; i < acc.length - 3; i++) {
      if (acc[i] === 0x49 && acc[i + 1] === 0x45 && acc[i + 2] === 0x4e && acc[i + 3] === 0x44) { iend = i; break; }
    }
    const depart = iend >= 0 ? iend + 8 : 0;
    let cale = -1;
    for (let o = depart; o + 564 < acc.length && o < depart + 8192; o++) {
      if (acc[o] === 0x47 && acc[o + 188] === 0x47 && acc[o + 376] === 0x47 && acc[o + 564] === 0x47) { cale = o; break; }
    }
    if (cale >= 0) {
      const tete = acc.subarray(cale);
      const flux = new ReadableStream({
        start(c) {
          c.enqueue(tete);
          if (fini) c.close();
        },
        async pull(c) {
          const { done, value } = await lecteur.read();
          if (done) c.close();
          else c.enqueue(value);
        },
        cancel(r) {
          return lecteur.cancel(r);
        },
      });
      return { body: flux, type: "video/mp2t", retaille: true };
    }
    octets = acc; // pas de TS derriere : on rend tel quel
    const flux = new ReadableStream({
      start(c) {
        c.enqueue(acc);
        if (fini) c.close();
      },
      async pull(c) {
        const { done, value } = await lecteur.read();
        if (done) c.close();
        else c.enqueue(value);
      },
      cancel(r) {
        return lecteur.cancel(r);
      },
    });
    return { body: flux, type };
  }
  const boite = octets.length >= 8
    ? String.fromCharCode(octets[4], octets[5], octets[6], octets[7])
    : "";
  let nouveau = type;
  if (octets[0] === 0x47) nouveau = "video/mp2t";
  else if (boite === "ftyp" || boite === "styp" || boite === "moof") nouveau = "video/mp4";
  const flux = new ReadableStream({
    start(c) {
      if (!premier.done && premier.value) c.enqueue(premier.value);
      if (premier.done) c.close();
    },
    async pull(c) {
      const { done, value } = await lecteur.read();
      if (done) c.close();
      else c.enqueue(value);
    },
    cancel(r) {
      return lecteur.cancel(r);
    },
  });
  return { body: flux, type: nouveau };
}

/* Un morceau demande = un morceau rendu. Le lecteur HLS natif d'iOS demande
   souvent `Range: bytes=0-1` sur un segment et exige un 206 ; le CDN de
   megaplay ignore `Range` et renvoie le fichier entier en 200 — Safari
   abandonne, Chrome s'en moque. D'ou « megaplay marche aleatoirement sur
   iPhone » (28/09/2026). Filet unique en sortie : un 200 complet a une demande
   de morceau est decoupe ici. Borne a 32 Mo (un segment pese 1-8 Mo) : un MP4
   entier ne tient pas en memoire d'isolat, il passe tel quel. `bytes=0-` reste
   servi en 200, reponse valide et que le cache sait garder. */
const DECOUPE_MAX = 32 * 1024 * 1024;
async function honoreRange(request, res) {
  const range = request.headers.get("range");
  const m = range && /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
  if (!m || res.status !== 200 || (m[1] === "0" && m[2] === "")) return res;
  const type = res.headers.get("content-type") || "";
  if (/mpegurl|json|html/i.test(type) && !/video|octet/i.test(type)) return res;
  const annonce = Number(res.headers.get("content-length"));
  if (annonce > DECOUPE_MAX || !res.body) return res;
  /* Taille souvent NON annoncee (reponse du cache, CDN en chunked) : on lit
     jusqu'a la borne. Depassee, on rend le flux intact — ce qui est deja lu
     d'abord, le reste ensuite. */
  const lecteur = res.body.getReader();
  const morceaux = [];
  let lu = 0;
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    morceaux.push(value);
    lu += value.length;
    if (lu > DECOUPE_MAX) {
      const flux = new ReadableStream({
        start(c) {
          for (const x of morceaux) c.enqueue(x);
        },
        async pull(c) {
          const r = await lecteur.read();
          if (r.done) c.close();
          else c.enqueue(r.value);
        },
        cancel(r) {
          return lecteur.cancel(r);
        },
      });
      return new Response(flux, { status: 200, headers: res.headers });
    }
  }
  const buf = new Uint8Array(lu);
  let o = 0;
  for (const x of morceaux) {
    buf.set(x, o);
    o += x.length;
  }
  const taille = buf.length;
  let debut, fin;
  if (m[1] === "") {
    debut = Math.max(0, taille - Number(m[2]));
    fin = taille - 1;
  } else {
    debut = Number(m[1]);
    fin = m[2] === "" ? taille - 1 : Math.min(Number(m[2]), taille - 1);
  }
  const headers = new Headers(res.headers);
  headers.set("Accept-Ranges", "bytes");
  if (debut >= taille || debut > fin) {
    headers.set("Content-Range", `bytes */${taille}`);
    headers.delete("Content-Length");
    return new Response(null, { status: 416, headers });
  }
  headers.set("Content-Range", `bytes ${debut}-${fin}/${taille}`);
  headers.set("Content-Length", String(fin - debut + 1));
  return new Response(buf.subarray(debut, fin + 1), { status: 206, headers });
}

export default {
  async fetch(request, env, ctx) {
    try {
      // Offloaded-from-Vercel endpoints (/w/status, /w/broadcast, /w/track) are
      // routed first; everything else is the HLS/scrape proxy.
      const edge = await handleEdgeEndpoint(request, env, ctx);
      if (edge) return edge;
      return await honoreRange(request, await handle(request, env, ctx));
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Proxy failed", detail: String(err) }),
        {
          status: 500,
          headers: corsHeaders({ "Content-Type": "application/json" }),
        },
      );
    }
  },
};
