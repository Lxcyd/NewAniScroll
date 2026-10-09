/**
 * Edge-served endpoints offloaded from Vercel to this Cloudflare Worker, to cut
 * Vercel Fluid Active CPU. These were previously Vercel Functions hit by client
 * polling (health/broadcast) or on every navigation (track) — work that doesn't
 * belong on CPU-metered serverless when an edge Worker can do it ~free.
 *
 *   GET  /w/status    → config self-check (is analytics wired up?).
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
 *   [[kv_namespaces]] binding = "W2G_CACHE"   (broadcast value)
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
  if (!url || !token) {
    // Analytics disabled → still fail OPEN (never block a page load), but say
    // so in the body. This used to answer a bare `{ok:true}`, indistinguishable
    // from a successful write, which is how pageview logging died on
    // 2026-07-11 and went unnoticed for weeks: the table simply stopped
    // growing and nothing anywhere said why. `stored` is the signal — see
    // /w/status, which reports the same thing without writing a row.
    console.error("[w/track] TURSO_ADMIN_URL / TURSO_ADMIN_TOKEN not configured");
    return json({ ok: true, stored: false, reason: "unconfigured" });
  }

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
  //
  // The `.catch(() => {})` here used to swallow EVERYTHING — including a 401
  // from a rotated Turso token, which is the most likely way this breaks. A
  // rejected write and a successful one looked identical from every angle, so
  // the only symptom was a table that quietly stopped growing. We still never
  // throw, but we do log: a non-2xx or a network error now shows up in
  // `wrangler tail` / the Cloudflare dashboard instead of vanishing.
  const write = fetch(httpUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests: [stmt, { type: "close" }] }),
  })
    .then(async (r) => {
      if (!r.ok) {
        console.error(
          `[w/track] Turso write failed: HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`,
        );
      }
    })
    .catch((e) => {
      console.error(`[w/track] Turso write threw: ${e?.message || e}`);
    });
  if (ctx) ctx.waitUntil(write);

  return json({ ok: true, stored: true });
}

// --- /w/diag ----------------------------------------------------------------
//
// Journal de lecture d'une session `?diag=1` (lib/diag.ts). Ne sert qu'a voir,
// depuis un VRAI appareil (l'iPhone), pourquoi le lecteur abandonne une source
// — Chrome pilote ne reproduit ni le HLS natif de Safari ni ses regles
// d'autoplay (28/09/2026). Aucun cout Vercel : KV, 3 jours.
// Quota KV gratuit : 1 000 ecritures/jour. Seules les sessions `?diag=1`
// ecrivent, une fois par envoi (a chaque abandon, a la sortie, toutes les
// 25 s au plus).
const DIAG_MAX = 16 * 1024;

async function handleDiagPost(request, env, ctx) {
  const ua = request.headers.get("user-agent") || "";
  if (!BROWSER_UA.test(ua) || BOT_UA.test(ua)) return json({ ok: true, bot: true });
  const texte = (await request.text()).slice(0, DIAG_MAX);
  const corps = safeParse(texte);
  const sid = String(corps?.sid || "").replace(/[^a-z0-9]/gi, "").slice(0, 32);
  if (!sid) return json({ ok: false }, 400);
  console.log("[diag]", sid, texte.slice(0, 2000));
  if (env.W2G_CACHE) {
    const cle = `diag:${sid}:${Date.now()}`;
    ctx?.waitUntil?.(
      env.W2G_CACHE.put(cle, JSON.stringify({ ...corps, ua, ip: clientIp(request) }), {
        expirationTtl: 3 * 86400,
      }).catch(() => {}),
    );
  }
  return json({ ok: true });
}

async function handleDiagGet(request, env) {
  const u = new URL(request.url);
  if (!env.DIAG_TOKEN || u.searchParams.get("k") !== env.DIAG_TOKEN) {
    return json({ error: "Not found" }, 404);
  }
  const kv = env.W2G_CACHE;
  if (!kv) return json({ error: "no kv" }, 500);
  const sid = (u.searchParams.get("sid") || "").replace(/[^a-z0-9]/gi, "");
  const liste = await kv.list({ prefix: `diag:${sid}`, limit: 1000 });
  const cles = liste.keys.map((k) => k.name).sort().slice(-Number(u.searchParams.get("n") || 30));
  const entrees = [];
  for (const cle of cles) entrees.push({ cle, ...(safeParse(await kv.get(cle)) || {}) });
  return json({ total: liste.keys.length, entrees }, 200, { "Cache-Control": "no-store" });
}

/**
 * GET /w/frame/<asset>/<160|256>.avif — un cadre d avatar (decoration Discord)
 * reencode en AVIF anime leger (transparence comprise) : ~85 Ko contre ~1 Mo.
 *
 * Discord ne sert l'animation qu'en APNG d'origine (~800 Ko, `size` ignore) :
 * la grille du studio mettait des secondes a s'animer. Les versions legeres
 * sont fabriquees par scripts/discord-frames/encode-frames.mjs et rangees dans
 * KV (`frame:<asset>:<taille>`). Un asset Discord ne change jamais de contenu,
 * d'ou le cache d'un an `immutable` et le cache d'edge devant KV : une lecture
 * KV par cadre et par point de presence, pas par visiteur.
 */
const FRAME_RE = /^\/w\/frame\/((?:a_)?[0-9a-f]{32})\/(160|256)\.avif$/;

async function handleFrame(request, pathname, env, ctx) {
  const m = FRAME_RE.exec(pathname);
  if (!m || !env.W2G_CACHE) return new Response("Not found", { status: 404 });
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;
  const body = await env.W2G_CACHE.get(`frame:${m[1]}:${m[2]}`, "arrayBuffer");
  if (!body) {
    /* Pas encore encode : le site retombe sur l'APNG de Discord. Cache court
       pour que l'encodage de la nuit suivante soit vu. */
    return new Response("Not found", {
      status: 404,
      headers: { "Cache-Control": "public, max-age=300", ...cors() },
    });
  }
  const res = new Response(body, {
    headers: {
      "Content-Type": "image/avif",
      "Cache-Control": "public, max-age=31536000, immutable",
      ...cors(),
    },
  });
  ctx.waitUntil(cache.put(request, res.clone()));
  return res;
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
  if (pathname.startsWith("/w/frame/") && request.method === "GET") {
    return handleFrame(request, pathname, env, ctx);
  }
  if (pathname === "/w/track" && request.method === "POST") {
    return handleTrack(request, env, ctx);
  }
  if (pathname === "/w/diag" && request.method === "POST") {
    return handleDiagPost(request, env, ctx);
  }
  if (pathname === "/w/diag" && request.method === "GET") {
    return handleDiagGet(request, env);
  }
  if (pathname === "/w/status" && request.method === "GET") {
    // Read-only self-check. Pageview logging silently stopped on 2026-07-11 and
    // nobody could tell, because the only way to observe it was to notice a
    // Turso table had stopped growing. Booleans only — never echo the secrets.
    return json(
      {
        ok: true,
        analytics: {
          urlConfigured: Boolean(env.TURSO_ADMIN_URL),
          tokenConfigured: Boolean(env.TURSO_ADMIN_TOKEN),
        },
        kv: { broadcast: Boolean(env.W2G_CACHE) },
      },
      200,
      { "Cache-Control": "no-store" },
    );
  }
  return json({ error: "Not found" }, 404);
}
