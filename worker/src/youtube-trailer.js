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
 * TWO clients, asked ONE AT A TIME. Order matters: ANDROID_VR first, ANDROID as
 * the fallback.
 *
 * WHY TWO. The refusal is drawn per CLIENT and per VIDEO, not only per address.
 * Measured 13/08 from a residential connection, same second, same video:
 * `6vMuWuWlW4I` — ANDROID returned OK with itag 18, ANDROID_VR returned
 * `LOGIN_REQUIRED: Sign in to confirm you're not a bot`. On `dQw4w9WgXcQ` both
 * answered OK. So a single client in the foreground would simply lose the
 * trailers its twin happens to be refused, and no amount of retrying would
 * bring them back. (This corrects the 11/08 DEVLOG entry, which concluded the
 * block was aimed at the address and the minute rather than the client — that
 * was measured through a cold cache where the two effects are indistinguishable.)
 *
 * WHY NOT IN PARALLEL, which is what this used to do. Racing them spends two
 * InnerTube calls on EVERY cold video, including the ~majority the first client
 * serves on its own. Since the refusal rate rises with how much this colo has
 * asked for — the whole subject of the 13/08 work — the second call is not free
 * insurance, it is what buys the next refusal. Sequential costs 1 call in the
 * common case and 2 only when the first is refused: the same coverage, half the
 * fuel.
 *
 * Falling back sequentially also happens to enforce the invariant earned on
 * 11/08 for free: a durable refusal is believed only if EVERY client asked said
 * so, because the two do not see the same catalogue.
 *
 * WHY ANDROID_VR LEADS — and this is the correction that cost a deploy. From a
 * RESIDENTIAL connection both clients' itag 18 links downloaded fine (206), so
 * ANDROID looked like the better leader: it answered on the hard case above.
 * From the EDGE it is the opposite. ANDROID resolves cleanly and then its link
 * is refused: `Unresolvable: upstream 403 | upstream 403`, on trailer after
 * trailer, which is exactly the GVS PO token requirement the PO Token Guide
 * attributes to ANDROID and NOT to ANDROID_VR. Enforcement evidently tracks the
 * caller's reputation, so it bites a datacentre egress and not a home one — and
 * measuring this from home is what got the order wrong the first time.
 *
 * So the leader is the client whose links we can actually redeem, and ANDROID is
 * the fallback for the videos VR declines. If VR ever stops handing out itag 18,
 * the diag says `OK but no muxed format` rather than going quiet.
 *
 * The device fields are not decoration: ANDROID_VR without the Oculus/Quest 3
 * pair is a different, less trusted caller.
 */
const CLIENTS = [
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
];

/**
 * YouTube ids are exactly 11 url-safe base64 characters.
 *
 * `.mp4` serves the bytes. `.json` answers the cheaper question the info page
 * asks — "is this video watchable from here at all?" — without moving any.
 */
const ID_RE = /^\/w\/trailer\/([A-Za-z0-9_-]{11})\.(mp4|json)$/;

/**
 * Thirty days — the longest thing here, on purpose.
 *
 * Safe despite the ~6 h expiry on the googlevideo URL: what expires is the
 * link, and the link is never cached — only the bytes it returned are, under a
 * key that is just the video id. A trailer's content doesn't change, ever, so
 * the day this used to hold (an alignment with the main proxy, not a constraint
 * of its own) was throwing away the cheapest possible answer every 24 h.
 *
 * This is still a cache and not storage: Cloudflare evicts by LRU whenever it
 * likes, so the TTL is a ceiling on how long an entry MAY live, not a promise.
 * Which is exactly the point — it is the one line that reduces how often we
 * have to ask YouTube anything at all, at zero cost and zero commitment.
 */
const EDGE_TTL = 30 * 86400;

/**
 * ISOLATE STATE — the fuel gauge and the cut-off switch.
 *
 * The refusal rate is not random and not purely about the address: it CLIMBS
 * with how much this colo has asked for. Reported from a browsing session and
 * consistent with the retry cascade this file used to run — one refused trailer
 * could cost ~24 InnerTube calls once the two-client race, the two rounds, the
 * warm-up ladder and the browser's three retries had all multiplied each other.
 * The machinery was feeding the very rationing it was trying to out-wait.
 *
 * So the worker now counts what it spends, and stops spending when it is being
 * refused. Module scope means "per isolate", which is the right granularity:
 * an isolate is roughly one colo's run of traffic, and the colo is what YouTube
 * is rationing.
 */
const BREAKER_THRESHOLD = 3;
const BREAKER_WINDOW_MS = 60000;

let innertubeCalls = 0;
let botRefusals = 0;
let breakerUntil = 0;

/** Are we currently sitting out a refusal wave? */
function breakerOpen() {
  return Date.now() < breakerUntil;
}

/**
 * Record a "prove you're not a bot" and trip the breaker if they are piling up.
 *
 * Counted only for the bot flavour: a video that is deleted or geo-fenced says
 * nothing about our standing, and tripping on those would silence the worker
 * over answers it was right to get.
 */
function noteBotRefusal() {
  botRefusals += 1;
  if (botRefusals >= BREAKER_THRESHOLD) {
    breakerUntil = Date.now() + BREAKER_WINDOW_MS;
    botRefusals = 0;
  }
}

/** Stamped on every answer so "it got better" can be read rather than felt. */
function instrument(headers) {
  return {
    ...headers,
    "X-Aniscroll-It-Calls": String(innertubeCalls),
    "X-Aniscroll-Breaker": breakerOpen() ? "open" : "closed",
  };
}

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
    headers: cors(instrument({ "Content-Type": "application/json", "Cache-Control": "no-store" })),
  });
}

/**
 * How long "we could not resolve this right now" is held at the edge.
 *
 * Six seconds is not a guess, it is wedged between the two clocks that already
 * exist. The card retries at RETRY_DELAYS_MS = [500, 2500, 7000] and the
 * warm-up's first rung lands at WARM_SCHEDULE_MS[0] = 4000. At six seconds the
 * first two retries become edge hits that cost nothing and ask YouTube nothing
 * — they were re-entering the whole resolve path, three times per failed
 * trailer, at the exact moment we were being rationed — while the third retry
 * falls past the TTL *and* past the first warm rung, so it still sees the bytes
 * if the warm-up landed them. The rendezvous 97b1a03 arranged is kept; only its
 * cost is gone.
 *
 * Nothing durable is claimed here. Six seconds is an anti-stampede, not a
 * memory: `unknown` is still never written down as a fact about the video.
 */
const UNRESOLVED_TTL = 6;

function unresolved(error) {
  return new Response(JSON.stringify({ error }), {
    status: 404,
    headers: cors(
      instrument({
        "Content-Type": "application/json",
        "Cache-Control": `public, s-maxage=${UNRESOLVED_TTL}`,
      }),
    ),
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
  innertubeCalls += 1;
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
    // Not durable — so it is us being refused, which is what the breaker counts.
    noteBotRefusal();
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
 * Per-CALL cap, not a budget for the whole sequence.
 *
 * Measured over 14 cold trailers: most answered in 300-600 ms, but one took
 * 5.6 s, another 7 s, and one spent 22 s failing. The slowness is not the video
 * and not the colo — the same id fetched again straight after is fast. It is a
 * per-request mood, so the cap is what stops one stalled call from holding the
 * hover hostage; a card that has had nothing for eight seconds has already
 * failed, however good the answer eventually is.
 */
const RESOLVE_TIMEOUT_MS = 4000;

/**
 * Ask the clients IN TURN and stop at the first usable answer.
 *
 * See CLIENTS for why the order is ANDROID then ANDROID_VR, and why this is a
 * sequence rather than the race it used to be. The short version: the second
 * call only pays for itself when the first was refused, and every call we make
 * while being rationed is what buys the next refusal.
 *
 * Returns null on a refusal a retry might survive (bot block, timeout, network),
 * and THROWS DurableRefusal only when EVERY client asked agreed the video itself
 * is unavailable — the unanimity invariant from 11/08, which sequential fallback
 * enforces by construction. A lone durable refusal next to a bot block proves
 * nothing about the video (the two clients do not see the same catalogue) and
 * believing it would hide a good trailer for six hours.
 */
/**
 * One resolve per video PER CLIENT at a time, shared by everyone who asks.
 *
 * The card's three retries, a second visitor hovering the same poster, the info
 * page's verdict and the warm-up could each start their own resolve for the same
 * id, seconds apart, and every one of them cost InnerTube calls we are being
 * rationed on. They now all await the same promise.
 *
 * Keyed per client, not per video, because the link a client mints is only good
 * for that client's UA — sharing ANDROID's answer with a caller about to ask
 * ANDROID_VR would hand it a link it cannot redeem.
 *
 * Joiners get no diag lines of their own — the notes belong to the caller that
 * actually made the calls. That is a fair trade for not making them twice.
 */
const inFlight = new Map();

function resolveShared(videoId, client, diag) {
  const key = `${videoId}:${client.name}`;
  const existing = inFlight.get(key);
  if (existing) {
    if (diag) diag.push(`${client.name}: joined an in-flight resolve`);
    return existing;
  }
  const attempt = resolveMuxedUrl(videoId, client, diag, AbortSignal.timeout(RESOLVE_TIMEOUT_MS))
    .finally(() => inFlight.delete(key));
  inFlight.set(key, attempt);
  return attempt;
}

/**
 * Walk the clients in order: resolve a link, then REDEEM it, and only move on
 * when this client has failed at both.
 *
 * WHY RESOLVING AND FETCHING BELONG IN THE SAME LOOP. A googlevideo link can be
 * refused (403) even though the player response was a clean OK, and that refusal
 * is a fact about the CLIENT, not the video: the PO Token Guide lists ANDROID as
 * requiring a GVS PO token for exactly this step, and ANDROID_VR as requiring
 * none. Measured 13/08 from the edge: ANDROID resolved fine and then took
 * `upstream 403 | upstream 403`, twice in a row, because the code re-resolved
 * with the SAME client instead of trying the other one. A 403 must fall THROUGH
 * to the next client — that is the whole reason there are two.
 *
 * Returns the upstream Response, or null on a refusal a retry might survive.
 * THROWS DurableRefusal only when every client asked agreed the video itself is
 * unavailable (the unanimity invariant from 11/08). A 403 is never durable: it
 * says the link was bad, not the video.
 */
async function fetchTrailer(videoId, diag) {
  let asked = 0;
  let durableCount = 0;
  let firstDurable = null;

  for (const client of CLIENTS) {
    // Re-checked between clients, not just at entry: the first call is exactly
    // what may have tripped it.
    if (breakerOpen()) {
      if (diag) diag.push("breaker open — not asking");
      break;
    }
    asked += 1;

    let url = null;
    try {
      url = await resolveShared(videoId, client, diag);
    } catch (err) {
      if (err instanceof DurableRefusal) {
        durableCount += 1;
        firstDurable = firstDurable || err;
        continue;
      }
      // A timeout or a network blip is this client's bad luck, not the video's,
      // and must not take the whole request down with it.
      if (diag) {
        diag.push(
          err?.name === "TimeoutError"
            ? `${client.name}: timed out (${RESOLVE_TIMEOUT_MS} ms)`
            : `${client.name}: ${err?.name || "error"}`,
        );
      }
      continue;
    }
    if (!url) continue;

    // The client's UA travels with its url: googlevideo minted that link for a
    // Quest or for a phone, and the fetch that redeems it should say the same.
    const upstream = await fetch(url, {
      headers: { "User-Agent": client.ua, Accept: "*/*" },
    });
    if (upstream.status !== 403) return upstream;
    if (diag) diag.push(`${client.name}: upstream 403 on the link`);
  }

  if (firstDurable && durableCount === asked) throw firstDurable;
  return null;
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
 * COSTS NO YOUTUBE CALL, EVER. This route is a reader of the cache, not a
 * trigger: `Overview.tsx` and `InfoPageMobile.tsx` ask it on every visit to an
 * info page, and a page view must not be able to spend an InnerTube call. On a
 * miss it answers `unknown` at once and books a warm-up — the browser treats
 * `unknown` as "keep showing the trailer, we simply don't know", and
 * `lib/preview/trailerVerdict.ts` never writes it down, so nothing valid is
 * hidden by the honest answer.
 *
 * It used to resolve on a miss, which is how a single browsing session could
 * spend two InnerTube calls per info page on top of everything the hover cards
 * were already spending.
 */
async function trailerVerdict(videoId, bytesKeyUrl, cache, ctx) {
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

  // There is no separate cache under the `.json` key any more: it only ever
  // held the answer to a resolve this route no longer makes. Everything it can
  // know now lives under the bytes key, checked above.

  // Nothing known, and asking is not this route's job. Book a warm-up so the
  // NEXT question — from this visitor's hover or anyone else's — is answered
  // from the cache, and say so honestly in the meantime.
  warmLater(videoId, bytesKeyUrl, cache, ctx);
  return reply({ verdict: "unknown", diag: "not cached — warming" }, 0);
}

/** The headers the stored bytes carry, wherever they were fetched from. */
function mp4Headers() {
  return cors(
    instrument({
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": `public, s-maxage=${EDGE_TTL}, max-age=3600, immutable`,
      "X-Aniscroll-Cache": "MISS",
    }),
  );
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
 *
 * A LADDER rather than one shot, because one shot only cleared 4 of 7 refused
 * ids: the second attempt is aimed at a wave that outlasted the first. The last
 * rung stays under the ~30 s a `waitUntil` task is given after the response.
 *
 * The first rung is also what the card's own last retry is timed against — see
 * RETRY_DELAYS_MS in NativeTrailer.
 */
const WARM_SCHEDULE_MS = [4000, 11000, 21000];

/**
 * One warm-up per video per isolate.
 *
 * Distinct from `inFlight`, and both are needed: `inFlight` shares a resolve
 * that is happening NOW, while this guards a ladder that sleeps for up to 21 s
 * between its own attempts. Without it every retry, every hover and every info
 * page would schedule its own ladder for the same id.
 */
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
  const key = new Request(cacheKeyUrl, { method: "GET" });
  ctx.waitUntil(
    (async () => {
      try {
        let waited = 0;
        for (const rung of WARM_SCHEDULE_MS) {
          await new Promise((resolve) => setTimeout(resolve, rung - waited));
          waited = rung;
          // Another isolate, or the visitor's own retry, may have won already.
          // Only a SUCCESSFUL answer counts: the short-lived 404 now parked
          // under this key by `unresolved()` is precisely the thing we are here
          // to replace, and treating it as "someone won" would abandon the
          // warm-up every single time it was needed.
          const already = await cache.match(key);
          if (already?.ok) return;
          // The wave is what we are waiting out, so asking during one is the one
          // thing this must not do. Skip the rung and let the next find it lifted.
          if (breakerOpen()) continue;
          const res = await fetchTrailer(videoId, null);
          if (!res?.ok) continue;
          await cache.put(key, new Response(res.body, { status: 200, headers: mp4Headers() }));
          return;
        }
      } catch {
        /* including a DurableRefusal: the video is gone, and the next real
           request records that through the path that knows how to cache it */
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

  if (wantsVerdict) return trailerVerdict(videoId, cacheKeyUrl, cache, ctx);

  if (request.method === "GET") {
    const cached = await cache.match(cacheLookup);
    if (cached) {
      const hit = new Response(cached.body, cached);
      hit.headers.set("X-Aniscroll-Cache", "HIT");
      // Re-stamped, because the stored copy carries whatever the counters read
      // when it was written — which on a month-old entry is archaeology.
      for (const [key, value] of Object.entries(instrument({}))) {
        hit.headers.set(key, value);
      }
      return hit;
    }
  }

  // Being rationed right now: answer instantly and spend nothing. The card
  // falls back to its artwork, the warm-up picks the video up once the wave has
  // passed, and — the whole point — we stop adding to what is refusing us.
  if (breakerOpen()) {
    warmLater(videoId, cacheKeyUrl, cache, ctx);
    // Parked in the cache like any other refusal: a Worker's own response is
    // not stored at the edge on its own, and the whole value of the 6 s TTL is
    // that the card's next two retries never reach this function again.
    return storeVerdict(
      cacheKeyUrl,
      cache,
      ctx,
      unresolved("Refused upstream — sitting out the wave"),
    );
  }

  /**
   * ONE pass over the clients — see fetchTrailer, which resolves and redeems in
   * the same loop so a refused link falls through to the other client.
   *
   * No second round here. Two attempts crowded into the same second are two
   * samples of one moment: this file already says so about warmLater, and the
   * edge measurement backed it (16 cold ids: two clients and three rounds failed
   * 9, one client and two rounds failed 8, the same ids both times). Waiting is
   * what works, and warmLater is where waiting is free.
   *
   * Deliberately NOT forwarding the client's Range — see below. We always pull
   * the whole file so there is always something worth storing.
   */
  const diag = [];
  let upstream = null;
  try {
    upstream = await fetchTrailer(videoId, diag);
  } catch (err) {
    if (!(err instanceof DurableRefusal)) throw err;
    /*
     * The video is unavailable, and will be from every later attempt too.
     *
     * Retrying it is not merely useless, it is expensive in the one currency
     * that counts here: the browser gives a failed trailer three goes, and each
     * of those spent four InnerTube calls inside this worker — twelve round
     * trips to YouTube, and several seconds of the card sitting on a black box,
     * for a video that was never going to play. Answering with a CACHEABLE
     * refusal ends all of it: the browser's own retries become edge hits that
     * fail in milliseconds, and the card falls back to its artwork at once,
     * which is the right picture anyway.
     */
    return storeVerdict(cacheKeyUrl, cache, ctx, gone(err.message));
  }
  if (!upstream) {
    warmLater(videoId, cacheKeyUrl, cache, ctx);
    return storeVerdict(
      cacheKeyUrl,
      cache,
      ctx,
      unresolved(`Unresolvable: ${diag.join(" | ") || "unknown"}`),
    );
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
