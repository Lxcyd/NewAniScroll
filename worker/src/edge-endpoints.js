/**
 * Edge-served endpoints offloaded from Vercel to this Cloudflare Worker, to cut
 * Vercel Fluid Active CPU. These were previously Vercel Functions hit by client
 * polling (health/broadcast) or on every navigation (track) — work that doesn't
 * belong on CPU-metered serverless when an edge Worker can do it ~free.
 *
 *   GET  /w/health    → AniList health signal, read from Cloudflare KV.
 *   GET  /w/broadcast → current site broadcast, read from Cloudflare KV.
 *   POST /w/track     → pageview analytics, written to Turso over HTTP.
 *
 * IMPORTANT — why KV and not Redis:
 *   The Next.js side caches health/broadcast in Redis (ioredis, a raw TCP
 *   connection). Cloudflare Workers can't open that TCP socket, so the Worker
 *   CANNOT read Redis. Instead the WRITE side (the anilist-health cron and the
 *   admin broadcast POST) mirrors the value into KV, and the Worker reads KV
 *   here. KV reads are edge-local and effectively free.
 *
 * Bindings expected in wrangler.toml:
 *   [[kv_namespaces]] binding = "W2G_CACHE"   (health + broadcast values)
 *   [vars] / secrets: TURSO_ADMIN_URL, TURSO_ADMIN_TOKEN  (for /w/track)
 */

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extra,
  };
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: cors({ "Content-Type": "application/json", ...extra }),
  });
}

const KV_BROADCAST_KEY = "broadcast:current";

// NOTE: AniList health is intentionally NOT served here. AniList 403s requests
// from Cloudflare Worker egress IPs, so a Worker-side probe can't tell up from
// down. The client polls the Vercel route /api/v2/anilist-health directly (its
// IP is accepted by AniList); that cost is negligible (Redis-cached + tab-gated).

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** GET /w/broadcast — serve the current broadcast from KV. */
async function handleBroadcast(env) {
  const empty = { title: null, message: null, show: false };
  const kv = env.W2G_CACHE;
  if (!kv) return json(empty);
  const raw = await kv.get(KV_BROADCAST_KEY);
  const payload = (raw && safeParse(raw)) || empty;
  return json(payload, 200, {
    "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
  });
}

// --- /w/track ---------------------------------------------------------------

const BOT_UA =
  /(bot|crawl|spider|headless|scrapy|favicon|vercel|prerender|preview|warmer|wget|curl|axios|node-fetch|python|java|ruby|go-http|httpclient|okhttp|libwww|lighthouse|pagespeed|gtmetrix|pingdom|uptimerobot|yandex|baidu|duckduck|semrush|ahrefs|mj12|dotbot|petalbot)/i;
const BROWSER_UA = /(Mozilla\/5\.0).*(Chrome|Firefox|Safari|Edg|OPR|Opera)\//;

function isBot(request) {
  if (request.headers.get("x-warmer")) return true;
  const ua = request.headers.get("user-agent") || "";
  if (!ua) return true;
  if (BOT_UA.test(ua)) return true;
  if (!BROWSER_UA.test(ua)) return true;
  if (!request.headers.get("accept-language")) return true;
  if (!request.headers.get("sec-fetch-site")) return true;
  return false;
}

function clientIp(request) {
  // Cloudflare sets CF-Connecting-IP to the real client IP.
  return (
    request.headers.get("cf-connecting-ip") ||
    (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    null
  );
}

/**
 * POST /w/track — write a pageview to Turso via its HTTP API (libsql/hrana
 * pipeline). We hit the REST endpoint directly (no @libsql/client needed) so
 * the Worker stays dependency-free. TURSO_ADMIN_URL is `libsql://<db>.turso.io`;
 * the HTTP pipeline lives at `https://<db>.turso.io/v2/pipeline`.
 */
async function handleTrack(request, env, ctx) {
  // Never block the caller (mirrors the Vercel route's fail-open contract).
  if (isBot(request)) return json({ ok: true, bot: true });

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: true });
  }
  const visitorId = body?.visitorId;
  const path = body?.path;
  if (!visitorId) return json({ error: "visitorId required" }, 400);

  const url = env.TURSO_ADMIN_URL;
  const token = env.TURSO_ADMIN_TOKEN;
  if (!url || !token) return json({ ok: true }); // analytics disabled → fail open

  const httpUrl =
    url.replace(/^libsql:\/\//, "https://").replace(/\/+$/, "") + "/v2/pipeline";

  const stmt = {
    type: "execute",
    stmt: {
      sql: `INSERT INTO user_analytics (visitor_id, ip, user_agent, path)
            VALUES (?, ?, ?, ?)`,
      args: [
        { type: "text", value: String(visitorId).slice(0, 64) },
        nullableText(clientIp(request)),
        nullableText((request.headers.get("user-agent") || "").slice(0, 256)),
        nullableText(String(path || "").slice(0, 256)),
      ],
    },
  };

  // Fire-and-forget the DB write so the response returns immediately; analytics
  // must never delay or fail a page load.
  const write = fetch(httpUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests: [stmt, { type: "close" }] }),
  }).catch(() => {});
  if (ctx) ctx.waitUntil(write);

  return json({ ok: true });
}

function nullableText(v) {
  return v == null || v === "" ? { type: "null" } : { type: "text", value: v };
}

/**
 * Route the offloaded edge endpoints. Returns a Response for /w/* paths, or
 * null so the caller falls through to the existing HLS proxy handler.
 */
export async function handleEdgeEndpoint(request, env, ctx) {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/w/")) return null;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors() });
  }

  if (pathname === "/w/broadcast" && request.method === "GET") {
    return handleBroadcast(env);
  }
  if (pathname === "/w/track" && request.method === "POST") {
    return handleTrack(request, env, ctx);
  }
  return json({ error: "Not found" }, 404);
}
