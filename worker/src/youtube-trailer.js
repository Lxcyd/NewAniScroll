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
 * WHY THE ANDROID CLIENTS. Measured against the alternatives on the same video:
 * IOS returns adaptive formats only (no muxed), WEB and MWEB return
 * UNPLAYABLE without a PO token, TVHTML5_SIMPLY_EMBEDDED_PLAYER errors. The two
 * android clients are the ones that still return itag 18 with a plain `url` and
 * no `signatureCipher` to decipher — see CLIENTS for why there are two.
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

const VR_VERSION = "1.65.10";
const VR_UA = `com.google.android.apps.youtube.vr.oculus/${VR_VERSION} (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip`;

/**
 * TWO clients — as insurance, NOT as a fix. Be clear about which, because the
 * measurement was not what the reasoning predicted.
 *
 * The reasoning: from a home connection the block is drawn per client (same four
 * trailers, same minute — ANDROID served all four, ANDROID_VR was refused all
 * four; on another video the reverse), so racing two clients should buy two
 * verdicts where racing one twice buys one verdict sampled twice. The
 * measurement from the EDGE says otherwise: 16 cold ids, two clients and three
 * rounds failed 9, one client and two rounds failed 8, and the same ids failed
 * in both runs. Out here the refusal is aimed at the address, not the client,
 * and it lifts on its own schedule — which is what warmLater is for.
 *
 * What keeps the second client is provenance rather than yield: yt-dlp's PO
 * Token Guide lists ANDROID as now requiring a GVS PO token and ANDROID_VR as
 * requiring none, and the single format VR still hands out untokened is itag 18
 * — precisely and only what this worker wants. It costs nothing (the race was
 * always two calls) and it is the client left standing if ANDROID goes. Should
 * that change, the diag says `OK but no muxed format` rather than going quiet.
 *
 * The device fields are not decoration: ANDROID_VR without the Oculus/Quest 3
 * pair is a different, less trusted caller.
 */
const CLIENTS = [
  {
    name: "android",
    ua: ANDROID_UA,
    header: "3",
    context: {
      clientName: "ANDROID",
      clientVersion: ANDROID_VERSION,
      androidSdkVersion: 35,
      osName: "Android",
      osVersion: "15",
      hl: "en",
      gl: "US",
    },
  },
  {
    name: "android_vr",
    ua: VR_UA,
    header: "28",
    context: {
      clientName: "ANDROID_VR",
      clientVersion: VR_VERSION,
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      androidSdkVersion: 32,
      osName: "Android",
      osVersion: "12L",
      hl: "en",
      gl: "US",
    },
  },
];

/**
 * YouTube ids are exactly 11 url-safe base64 characters.
 *
 * `.mp4` serves the bytes. `.json` answers the cheaper question the info page
 * asks — "is this video watchable from here at all?" — without moving any.
 */
const ID_RE = /^\/w\/trailer\/([A-Za-z0-9_-]{11})\.(mp4|json)$/;

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
 * How long a "this video is unavailable" answer is trusted.
 *
 * Shorter than the day a trailer's BYTES are held, because this verdict can
 * expire on its own: an uploader lifts a regional block or a video comes back
 * from private. Six hours is long enough that nobody pays for the same dead
 * video twice in a session, short enough that a fixed one returns the same day.
 */
const GONE_TTL = 21600;

/** A refusal worth remembering. 410 rather than 404: it names the difference. */
function gone(error) {
  return new Response(JSON.stringify({ error, durable: true }), {
    status: 410,
    headers: cors({
      "Content-Type": "application/json",
      "Cache-Control": `public, s-maxage=${GONE_TTL}`,
    }),
  });
}

/**
 * Put a verdict in the edge cache under the same key the bytes would have used,
 * so the next request for this video is answered without touching YouTube.
 *
 * Defensive on purpose: the Cache API refuses some responses, and a refusal to
 * remember a refusal must not turn into a 500 on the visitor's card.
 */
function storeVerdict(cacheKeyUrl, cache, ctx, response) {
  if (ctx) {
    try {
      ctx.waitUntil(
        cache
          .put(new Request(cacheKeyUrl, { method: "GET" }), response.clone())
          .catch(() => {}),
      );
    } catch {
      /* not cached — the only cost is asking YouTube again next time */
    }
  }
  return response;
}

/**
 * A refusal that no retry can lift: the video is gone, geo-fenced, or behind a
 * sign-in we will never have. Distinguished from the bot block because the two
 * deserve opposite treatment — see handleTrailer.
 */
class DurableRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "DurableRefusal";
  }
}

/**
 * Is this refusal about the VIDEO, or about US?
 *
 * `LOGIN_REQUIRED: Sign in to confirm you're not a bot` is about us — YouTube
 * declining a datacentre caller, measured at four failures out of eight
 * trailers, and a different colo or a different minute answers differently. It
 * must stay retryable.
 *
 * Everything else in this list is about the video and is the same answer from
 * anywhere, for as long as the uploader leaves it that way: deleted, private,
 * geo-fenced (`0c4IoCA5fY0`, an anime trailer on our own home page: "The
 * uploader has not made this video available in your country"), or age-gated
 * behind an account we do not have.
 */
const DURABLE_STATUSES = new Set(["UNPLAYABLE", "ERROR", "AGE_VERIFICATION_REQUIRED"]);

function isDurableRefusal(status, reason) {
  if (DURABLE_STATUSES.has(status)) return true;
  // LOGIN_REQUIRED covers both "prove you're human" (ours, retryable) and
  // "prove your age" (the video's, permanent). The reason string is what tells
  // them apart, so only the bot flavour keeps its retries.
  if (status === "LOGIN_REQUIRED") return !/\bbot\b/i.test(reason || "");
  return false;
}

/**
 * Ask InnerTube for the video and pull the muxed progressive stream out of it.
 *
 * Returns null on a refusal a retry might survive, and THROWS DurableRefusal on
 * one it cannot — embed-disabled, deleted, region-locked, age-gated.
 */
async function resolveMuxedUrl(videoId, client, diag, signal) {
  const note = (text) => {
    // Which client paid for what: with two of them in the race, an undecorated
    // `LOGIN_REQUIRED` no longer says whether one was refused or both were.
    if (diag) diag.push(`${client.name}: ${text}`);
  };
  const res = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`,
    {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": client.ua,
        "X-Youtube-Client-Name": client.header,
        "X-Youtube-Client-Version": client.context.clientVersion,
      },
      body: JSON.stringify({
        context: { client: client.context },
        videoId,
        // Both needed or a trailer carrying a content warning comes back as
        // unplayable — several anime trailers do.
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    },
  );
  if (!res.ok) {
    note(`http ${res.status}`);
    return null;
  }
  const json = await res.json();
  const status = json?.playabilityStatus?.status;
  if (status !== "OK") {
    const reason = json?.playabilityStatus?.reason || "no reason";
    note(`${status}: ${reason}`);
    if (isDurableRefusal(status, reason)) throw new DurableRefusal(`${status}: ${reason}`);
    return null;
  }

  const formats = json?.streamingData?.formats || [];
  const muxed =
    formats.find((f) => f.itag === 18 && f.url) ||
    // Any other muxed mp4 with a plain url, should YouTube ever renumber.
    formats.find((f) => f.url && (f.mimeType || "").startsWith("video/mp4") && f.audioQuality);
  if (!muxed?.url) note(`OK but no muxed format (${formats.length} progressive)`);
  return muxed?.url || null;
}

/**
 * Two resolves at once — one per client — first usable answer wins.
 *
 * Measured over 14 cold trailers: most answered in 300-600 ms, but one took
 * 5.6 s, another 7 s, and one spent 22 s failing — three sequential attempts of
 * seven seconds each. The slowness is not the video and not the colo: the same
 * id fetched again straight after is fast. It is a per-REQUEST mood, YouTube
 * stalling a datacentre caller, so the useful move is not to wait longer but to
 * ask twice and take whichever answers.
 *
 * Cheap on the only meter that counts: this happens on a cache miss, and the
 * miss is once per colo per day. Both calls are capped so a stalled one cannot
 * hold the whole request hostage — a hover that gets nothing for eight seconds
 * has already failed, however good the answer eventually is.
 */
const RESOLVE_TIMEOUT_MS = 4000;

async function resolveRacing(videoId, diag) {
  const one = async (client) => {
    const url = await resolveMuxedUrl(
      videoId,
      client,
      diag,
      AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    );
    // Promise.any settles on the first FULFILLED promise, so "no url" has to
    // reject or an early refusal would win the race against a good answer.
    if (!url) throw new Error("no url");
    // The winner's UA travels with its url: googlevideo minted that link for a
    // Quest or for a phone, and the fetch that redeems it should say the same.
    return { url, ua: client.ua };
  };
  try {
    return await Promise.any(CLIENTS.map(one));
  } catch (err) {
    // Promise.any rejects with an AggregateError, so testing `err.name` against
    // TimeoutError never matched and a resolve that simply timed out was
    // reported as `Unresolvable: unknown` — the one failure mode the message
    // could not name, and half of what the 404s actually were.
    const causes = err?.errors || [err];
    /*
     * "Unavailable" is only believed UNANIMOUSLY.
     *
     * When both racers were the same client, one of them saying the video is
     * gone settled it — its twin could not come back with more. Two different
     * clients can: they do not see the same catalogue (ANDROID_VR declines
     * material ANDROID serves), so a lone durable refusal beside a bot block
     * is not proof about the video, and believing it would hide a good trailer
     * for six hours. Requiring agreement costs a retry round in the rare split
     * case and keeps the 410 exactly where it was earned — a deleted or
     * region-locked video answers the same way to every client, which is what
     * the measurements showed.
     */
    const durable = causes.filter((e) => e instanceof DurableRefusal);
    if (durable.length === causes.length) throw durable[0];
    if (diag && causes.some((e) => e?.name === "TimeoutError")) {
      diag.push(`resolve timed out (${RESOLVE_TIMEOUT_MS} ms)`);
    }
    return null;
  }
}

/**
 * `GET /w/trailer/<id>.json` — is this video watchable from here, and if not,
 * is that about the video or about us?
 *
 *   { verdict: "ok" }                      → play it
 *   { verdict: "gone", reason: "…" }       → the video is unavailable HERE, and
 *                                            will stay so: deleted, private,
 *                                            age-gated, or not released in this
 *                                            region. Worth hiding the trailer.
 *   { verdict: "unknown" }                 → YouTube refused US (the bot block)
 *                                            or timed out. Says NOTHING about
 *                                            the video: never hide on this.
 *
 * The three-way answer is the whole point. A binary available/unavailable would
 * hide a perfectly good trailer every time our egress got refused — which is
 * about half of cold lookups (measured: 4 failures out of 8 trailers), and it
 * is exactly what "Death Note worked yesterday and not today" was.
 *
 * "Here" is the colo answering, which sits in the visitor's region — so a
 * regional block reads the same way for them as for us. That is as close to
 * "the user's own country" as this can get without asking their browser, which
 * cannot call InnerTube (no CORS).
 *
 * Costs nothing for anything already known: a trailer whose bytes are in the
 * edge cache, or whose refusal was already recorded, is answered from that
 * without touching YouTube.
 */
async function trailerVerdict(videoId, reqUrl, bytesKeyUrl, cache, ctx) {
  const reply = (body, ttl) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: cors({
        "Content-Type": "application/json",
        "Cache-Control": ttl ? `public, s-maxage=${ttl}` : "no-store",
      }),
    });

  // Already answered once, in either currency: the bytes themselves, or a
  // refusal recorded by the .mp4 route.
  const known = await cache.match(new Request(bytesKeyUrl, { method: "GET" }));
  if (known) {
    if (known.status === 410) {
      const body = await known.json().catch(() => ({}));
      return reply({ verdict: "gone", reason: body?.error || "unavailable" }, GONE_TTL);
    }
    if (known.ok) return reply({ verdict: "ok" }, EDGE_TTL);
  }

  const verdictKeyUrl = `${reqUrl.origin}/w/trailer/${videoId}.json`;
  const cachedVerdict = await cache.match(new Request(verdictKeyUrl, { method: "GET" }));
  if (cachedVerdict) return cachedVerdict;

  const diag = [];
  let answer;
  let ttl;
  try {
    const won = await resolveRacing(videoId, diag);
    // A resolve that came back with a URL proves the video plays from this
    // region. The bytes are left alone — the card will ask for them when it
    // actually wants to play, and that request caches them properly.
    answer = won ? { verdict: "ok" } : { verdict: "unknown", diag: diag.join(" | ") };
    ttl = won ? EDGE_TTL : 0;
  } catch (err) {
    if (!(err instanceof DurableRefusal)) throw err;
    answer = { verdict: "gone", reason: err.message };
    ttl = GONE_TTL;
  }

  const response = reply(answer, ttl);
  // `unknown` is never remembered: it is a statement about one moment of our
  // own reputation, and caching it would freeze a working trailer out for
  // hours over a refusal that had nothing to do with it.
  if (ttl) {
    return storeVerdict(verdictKeyUrl, cache, ctx, response);
  }
  return response;
}

/** The headers the stored bytes carry, wherever they were fetched from. */
function mp4Headers() {
  return cors({
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": `public, s-maxage=${EDGE_TTL}, max-age=3600, immutable`,
    "X-Aniscroll-Cache": "MISS",
  });
}

/**
 * How long to wait before trying a refused video again, out of band.
 *
 * The refusal comes in WAVES, and the wave is what has to pass. Measured on the
 * live worker: four ids refused four-for-four in one pass, three of the same
 * four served seconds later, everything cached from then on. Two more attempts
 * crowded into the same second are two samples of one moment — which is exactly
 * why adding rounds to the foreground loop changed nothing measurable (9 of 16
 * cold ids failed with three rounds and two clients, 8 of 16 with two rounds and
 * one; the same ids failed in both, so the variable was the minute, not us).
 */
const WARM_DELAY_MS = 4000;

/** One warm-up per video per isolate: the browser's own retries must not each start one. */
const warming = new Set();

/**
 * Fetch a refused trailer AFTER answering, and leave the bytes in the cache.
 *
 * The visitor who met the refusal is not the one this helps, and that is the
 * point: nothing here is on their clock, so it can afford the one thing the
 * request path cannot — waiting for the wave to pass. What it buys is that a
 * card which failed is ready the next time ANY visitor in this colo hovers it,
 * instead of staying broken until someone happens to catch a good minute.
 *
 * Deliberately silent on failure. A refusal here is the same refusal the
 * foreground already reported, and a durable one is recorded by the next real
 * request through the path that knows how to cache it.
 */
function warmLater(videoId, cacheKeyUrl, cache, ctx) {
  if (!ctx || warming.has(videoId)) return;
  warming.add(videoId);
  ctx.waitUntil(
    (async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, WARM_DELAY_MS));
        const won = await resolveRacing(videoId, null);
        if (!won) return;
        const res = await fetch(won.url, { headers: { "User-Agent": won.ua, Accept: "*/*" } });
        if (!res.ok) return;
        await cache.put(
          new Request(cacheKeyUrl, { method: "GET" }),
          new Response(res.body, { status: 200, headers: mp4Headers() }),
        );
      } catch {
        /* including a DurableRefusal: not ours to record from out here */
      } finally {
        warming.delete(videoId);
      }
    })(),
  );
}

export async function handleTrailer(request, env, ctx) {
  const reqUrl = new URL(request.url);
  const match = reqUrl.pathname.match(ID_RE);
  if (!match) return null;
  const videoId = match[1];
  const wantsVerdict = match[2] === "json";

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

  if (wantsVerdict) return trailerVerdict(videoId, reqUrl, cacheKeyUrl, cache, ctx);

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
  // Two ROUNDS of a two-way race, so at worst this spends ~8 s on resolving
  // rather than the 22 s that three sequential slow attempts could reach.
  // Adding rounds here was tried and measured worthless — see warmLater, which
  // does the waiting where nobody is watching the clock.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let won;
    try {
      won = await resolveRacing(videoId, diag);
    } catch (err) {
      if (!(err instanceof DurableRefusal)) throw err;
      /*
       * The video is unavailable, and will be from every later attempt too.
       *
       * Retrying it is not merely useless, it is expensive in the one currency
       * that counts here: the browser gives a failed trailer three goes, and
       * each of those spent four InnerTube calls inside this worker — twelve
       * round trips to YouTube, and several seconds of the card sitting on a
       * black box, for a video that was never going to play. Answering with a
       * CACHEABLE refusal ends all of it: the browser's own retries become edge
       * hits that fail in milliseconds, and the card falls back to its artwork
       * at once, which is the right picture anyway.
       */
      return storeVerdict(cacheKeyUrl, cache, ctx, gone(err.message));
    }
    if (!won) continue;
    // Deliberately NOT forwarding the client's Range — see below. We always
    // pull the whole file so there is always something worth storing.
    upstream = await fetch(won.url, { headers: { "User-Agent": won.ua, Accept: "*/*" } });
    if (upstream.status !== 403) break;
    diag.push("upstream 403");
    upstream = null;
  }
  if (!upstream) {
    warmLater(videoId, cacheKeyUrl, cache, ctx);
    return fail(404, `Unresolvable: ${diag.join(" | ") || "unknown"}`);
  }
  if (!upstream.ok && upstream.status !== 206) {
    return fail(502, `Upstream ${upstream.status}`);
  }

  const headers = mp4Headers();
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
