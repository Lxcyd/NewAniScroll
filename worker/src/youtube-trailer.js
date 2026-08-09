/**
 * Trailer bytes, served as a plain MP4 — so the preview card can use a native
 * <video> instead of a YouTube iframe.
 *
 *   GET https://proxy.aniscroll.com/w/trailer/<videoId>.mp4
 *
 * WHY THIS EXISTS. A cross-origin YouTube embed paints its own chrome — a big
 * centre button on start-up, on pause, on cue — and nothing removes it:
 * `controls=0` doesn't, no CSS reaches into the frame, and no message announces
 * it. Every control the card wanted (pause, seek, a clean first frame) was
 * impossible for the same reason. A <video> element we feed ourselves has none
 * of those problems: there is no chrome because there is no player but ours.
 *
 * WHY THE BYTES MUST TRANSIT HERE, rather than handing the URL to the browser:
 *   - googlevideo signs the URL against the IP that requested it (`ip=` is
 *     inside `sparams`), so a URL minted by our server is not usable from the
 *     visitor's connection;
 *   - googlevideo sends NO CORS header, so the browser cannot fetch it either
 *     (which rules out MSE and any manual muxing).
 * Both objections disappear once we are the origin the browser talks to.
 *
 * WHY itag 18 and only itag 18. It is the last muxed progressive format
 * YouTube still hands out (640×360 H.264 + AAC in one file), and a muxed file
 * is what makes `<video src>` enough — the adaptive formats are video-only and
 * audio-only streams that would need MSE, i.e. the CORS problem again. 360p is
 * not a compromise here: the preview card's video box is 364 px wide.
 *
 * WHY THE ANDROID CLIENT. Measured against the alternatives on the same video:
 * IOS returns adaptive formats only (no muxed), WEB and MWEB return
 * UNPLAYABLE without a PO token, TVHTML5_SIMPLY_EMBEDDED_PLAYER errors,
 * ANDROID_VR wants a login. ANDROID is the one that still returns itag 18 with
 * a plain `url` and no `signatureCipher` to decipher.
 *
 * THE COST MODEL. Workers bandwidth is unmetered; the meter is requests. So the
 * edge cache is the whole design: the key is OUR url (the video id), never the
 * googlevideo one, which means a popular trailer is fetched from YouTube once
 * per colo per day and every later viewer is served from cache. The full file
 * is ~2-4 MB.
 */

/** The public InnerTube key. Not a secret — it ships in every YouTube page. */
const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

const ANDROID_VERSION = "20.10.38";
const ANDROID_UA = `com.google.android.youtube/${ANDROID_VERSION} (Linux; U; Android 15) gzip`;

/** YouTube ids are exactly 11 url-safe base64 characters. */
const ID_RE = /^\/w\/trailer\/([A-Za-z0-9_-]{11})\.mp4$/;

/**
 * A day, matching the binary policy of the main proxy.
 *
 * Safe despite the ~6 h expiry on the googlevideo URL: what expires is the
 * link, and the link is never cached — only the bytes it returned are, under a
 * key that is just the video id. A trailer's content doesn't change.
 */
const EDGE_TTL = 86400;

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges, Content-Type, X-Aniscroll-Cache",
    ...extra,
  };
}

function fail(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: cors({ "Content-Type": "application/json", "Cache-Control": "no-store" }),
  });
}

/**
 * Ask InnerTube for the video and pull the muxed progressive stream out of it.
 *
 * Returns null rather than throwing on any "this video won't play" answer —
 * age-gated, region-locked, deleted, embed-disabled all land here, and they all
 * mean the same thing to the caller: keep the artwork.
 */
async function resolveMuxedUrl(videoId, diag) {
  const res = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": ANDROID_UA,
        "X-Youtube-Client-Name": "3",
        "X-Youtube-Client-Version": ANDROID_VERSION,
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: ANDROID_VERSION,
            androidSdkVersion: 35,
            osName: "Android",
            osVersion: "15",
            hl: "en",
            gl: "US",
          },
        },
        videoId,
        // Both needed or a trailer carrying a content warning comes back as
        // unplayable — several anime trailers do.
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    },
  );
  if (!res.ok) {
    if (diag) diag.push(`http ${res.status}`);
    return null;
  }
  const json = await res.json();
  const status = json?.playabilityStatus?.status;
  if (status !== "OK") {
    // Carried back to the caller because the difference matters: UNPLAYABLE and
    // LOGIN_REQUIRED are YouTube refusing US (a retry may work, another client
    // may be needed), while ERROR is usually a video that no longer exists (a
    // retry never will).
    if (diag) diag.push(`${status}: ${json?.playabilityStatus?.reason || "no reason"}`);
    return null;
  }

  const formats = json?.streamingData?.formats || [];
  const muxed =
    formats.find((f) => f.itag === 18 && f.url) ||
    // Any other muxed mp4 with a plain url, should YouTube ever renumber.
    formats.find((f) => f.url && (f.mimeType || "").startsWith("video/mp4") && f.audioQuality);
  if (!muxed?.url && diag) diag.push(`OK but no muxed format (${formats.length} progressive)`);
  return muxed?.url || null;
}

export async function handleTrailer(request, env, ctx) {
  const reqUrl = new URL(request.url);
  const match = reqUrl.pathname.match(ID_RE);
  if (!match) return null;
  const videoId = match[1];

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors() });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return fail(405, "Method not allowed");
  }

  // Same reasoning as the main proxy: a browser opens an MP4 with
  // `Range: bytes=0-`, cache.put REJECTS a 206, and a 200 is a legal answer to
  // that range — so the opening request is upgraded to a full fetch, stored,
  // and every later seek is sliced out of the stored 200 by cache.match.
  const rangeHeader = request.headers.get("range");
  const isOpeningRange = !rangeHeader || /^bytes=0-$/i.test(rangeHeader.trim());

  const cache = caches.default;
  // The key carries nothing but the video id — no token, no expiry, no
  // googlevideo host. That is what lets one origin fetch serve every visitor.
  const cacheKeyUrl = `${reqUrl.origin}/w/trailer/${videoId}.mp4`;
  const cacheLookup =
    rangeHeader && !isOpeningRange
      ? new Request(cacheKeyUrl, { method: "GET", headers: { Range: rangeHeader } })
      : new Request(cacheKeyUrl, { method: "GET" });

  if (request.method === "GET") {
    const cached = await cache.match(cacheLookup);
    if (cached) {
      const hit = new Response(cached.body, cached);
      hit.headers.set("X-Aniscroll-Cache", "HIT");
      return hit;
    }
  }

  /**
   * Resolve, then fetch, and retry BOTH.
   *
   * Measured on the first deploy: the first request for a cold video answered
   * 404 after ~7 s and the very next one succeeded, on two different videos.
   * YouTube treats a datacentre IP with suspicion, and a Worker's egress is
   * about as datacentre as it gets — so a refusal here says nothing durable
   * about the video, and giving up after one attempt turned an intermittent
   * upstream mood into "this card has no trailer".
   *
   * The 403 case retries too, and re-resolves rather than reusing the URL: a
   * rejected link is either expired or was minted from a different egress
   * address than the one now fetching (Cloudflare promises no such stability),
   * and only a fresh link fixes either.
   */
  const diag = [];
  let upstream = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const url = await resolveMuxedUrl(videoId, diag);
    if (!url) continue;
    // Deliberately NOT forwarding the client's Range — see below. We always
    // pull the whole file so there is always something worth storing.
    upstream = await fetch(url, { headers: { "User-Agent": ANDROID_UA, Accept: "*/*" } });
    if (upstream.status !== 403) break;
    diag.push("upstream 403");
    upstream = null;
  }
  if (!upstream) return fail(404, `Unresolvable: ${diag.join(" | ") || "unknown"}`);
  if (!upstream.ok && upstream.status !== 206) {
    return fail(502, `Upstream ${upstream.status}`);
  }

  const headers = cors({
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": `public, s-maxage=${EDGE_TTL}, max-age=3600, immutable`,
    "X-Aniscroll-Cache": "MISS",
  });
  const contentRange = upstream.headers.get("content-range");
  const contentLength = upstream.headers.get("content-length");
  if (contentRange) headers["Content-Range"] = contentRange;
  if (contentLength) headers["Content-Length"] = contentLength;

  if (request.method === "HEAD") {
    return new Response(null, { status: upstream.status, headers });
  }

  /**
   * A mid-file range on a cold key is served by fetching the WHOLE file, storing
   * it, and slicing here.
   *
   * This is the difference between a preview that starts in half a second and
   * one that takes five. The Cache API refuses to store a 206, so an earlier
   * version forwarded the client's Range upstream, got a 206 back, and cached
   * nothing — which meant the crop probe's five seeks each missed cache and
   * each paid a fresh InnerTube resolve, five sequential round trips to YouTube
   * for one hover. Pulling the whole file once turns all of them but the first
   * into edge hits, and the file is 3-4 MB.
   */
  if (rangeHeader && !isOpeningRange) {
    const buffer = await upstream.arrayBuffer();
    if (ctx) {
      ctx.waitUntil(
        cache.put(
          new Request(cacheKeyUrl, { method: "GET" }),
          new Response(buffer, { status: 200, headers }),
        ),
      );
    }
    const match = /bytes=(\d*)-(\d*)/i.exec(rangeHeader);
    const total = buffer.byteLength;
    const start = match && match[1] ? Math.min(Number(match[1]), total - 1) : 0;
    const end = match && match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
      return fail(416, "Bad range");
    }
    const slice = buffer.slice(start, end + 1);
    return new Response(slice, {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Content-Length": String(slice.byteLength),
      },
    });
  }

  const response = new Response(upstream.body, { status: upstream.status, headers });
  if (ctx && upstream.status === 200) {
    ctx.waitUntil(cache.put(new Request(cacheKeyUrl, { method: "GET" }), response.clone()));
  }
  return response;
}
