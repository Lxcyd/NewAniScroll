/**
 * AniScroll stream proxy — minimal, single-file Node.js HTTP server.
 *
 * Same query contract as the Cloudflare Worker, used when:
 *  - The Worker is IP-blocked by the upstream (sibnet, acek-cdn, …).
 *  - We don't want the traffic on Vercel's Fast Origin Transfer meter.
 *
 *   GET /?url=<encoded>&referer=<optional>&vcookie=<optional>
 *
 * Deploy this on a host whose IP range upstream doesn't filter against —
 * Render / Fly.io / Railway free tiers all work. The deployment's URL goes
 * into NEXT_PUBLIC_ANIME_PROXY_URL on Vercel and the player routes the
 * flagged hosts through it instead of the Worker / Vercel.
 *
 * Zero dependencies — uses the Node 20 built-in fetch + http modules.
 */

import http from "node:http";

const PORT = process.env.PORT || 8080;

// Same User-Agent the Worker and Vercel proxy send. Keep these aligned so
// upstream fingerprinting can't distinguish them.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Hosts that need a very specific Referer to authenticate the request.
// Mirrors the per-host lookup the Worker does so this proxy can be hit
// without a `referer=` param and still work (defensive — the client
// always sends it, but URLs we craft from inside the proxy don't).
function detectReferer(targetUrl) {
  if (targetUrl.includes("sibnet.ru")) {
    return { referer: "https://video.sibnet.ru/", origin: null };
  }
  if (
    targetUrl.includes("smoothpre") ||
    targetUrl.includes("movearnpre") ||
    targetUrl.includes("acek-cdn") ||
    targetUrl.includes("dramiyos-cdn") ||
    targetUrl.includes("mindbodywellness")
  ) {
    return { referer: "https://smoothpre.com/", origin: null };
  }
  return { referer: null, origin: null };
}

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges, Content-Type",
    ...extra,
  };
}

function writeJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, corsHeaders({ "Content-Type": "application/json", ...extraHeaders }));
  res.end(JSON.stringify(body));
}

async function handle(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  const url = reqUrl.searchParams.get("url");
  const refererParam = reqUrl.searchParams.get("referer");
  const vcookie = reqUrl.searchParams.get("vcookie");
  // raw=1: skip m3u8 segment rewriting. The Cloudflare Worker uses this when
  // it wants to do its OWN rewriting to point segments back at the Worker
  // (so subsequent segment fetches hit the CF edge cache instead of
  // hammering us). For direct browser callers, leave it off.
  const raw = reqUrl.searchParams.get("raw") === "1";

  if (!url) {
    writeJson(res, 400, { error: "Missing url parameter" });
    return;
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
    writeJson(res, 400, { error: "Bad target URL" });
    return;
  }

  const auto = detectReferer(targetUrl);
  const finalReferer = refererParam
    ? decodeURIComponent(refererParam)
    : auto.referer || targetOrigin + "/";

  const headers = {
    "User-Agent": UA,
    Referer: finalReferer,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
  };
  // Range header — required for video seeking. Node's req.headers normalises
  // to lowercase, so we read with both casings to be safe.
  const range = req.headers.range || req.headers.Range;
  if (range) headers.Range = range;
  if (vcookie) {
    try {
      headers.Cookie = decodeURIComponent(vcookie);
    } catch {
      headers.Cookie = vcookie;
    }
  }

  // Manual redirect handling. Carries Referer / UA across hops so CDNs
  // that redirect to a tokenised URL (sibnet's video.sibnet.ru → dv97 →
  // cvnXX chain) still authenticate every hop. Also replays Set-Cookie
  // on the next hop so session cookies survive the redirect chain.
  let response;
  let currentUrl = targetUrl;
  let currentHeaders = { ...headers };
  const MAX_REDIRECTS = 5;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    try {
      response = await fetch(currentUrl, {
        headers: currentHeaders,
        redirect: "manual",
      });
    } catch (err) {
      writeJson(res, 502, { error: "Fetch failed", detail: String(err) });
      return;
    }
    const status = response.status;
    const isRedirect = status >= 300 && status < 400 && status !== 304;
    const location = isRedirect ? response.headers.get("location") : null;
    if (!isRedirect || !location) break;
    let next;
    try {
      next = new URL(location, currentUrl).toString();
    } catch {
      break;
    }
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
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

  if (!response.ok && response.status !== 206) {
    writeJson(
      res,
      [401, 403, 404, 410].includes(response.status) ? 410 : response.status,
      { error: "Upstream error", upstream: response.status },
    );
    return;
  }

  const contentType = response.headers.get("content-type") || "";
  const isM3u8 =
    contentType.includes("mpegurl") ||
    contentType.includes("m3u") ||
    targetUrl.includes(".m3u8");

  // Build the proxy URL the rewritten manifest will point at — same origin
  // the client hit so nested segment / key requests come back through us.
  const proxyBase = `${reqUrl.protocol}//${reqUrl.host}${reqUrl.pathname}`;

  if (isM3u8) {
    const body = await response.text();
    const trimmed = body.trim();
    if (trimmed.startsWith("<!") || trimmed.startsWith("<html")) {
      writeJson(res, 502, { error: "Got HTML instead of m3u8 stream" });
      return;
    }

    // raw mode: return the upstream m3u8 unchanged. Caller (the Worker) is
    // expected to do its own URL rewriting to keep segments routed through
    // its own cache, which is what makes the proxy bandwidth-cheap.
    if (raw) {
      res.writeHead(
        200,
        corsHeaders({
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "public, s-maxage=30, max-age=0",
        }),
      );
      res.end(body);
      return;
    }

    const effectiveReferer = refererParam ? decodeURIComponent(refererParam) : auto.referer;
    const refParam = effectiveReferer
      ? `&referer=${encodeURIComponent(effectiveReferer)}`
      : "";
    const cookieParam = vcookie
      ? `&vcookie=${encodeURIComponent(decodeURIComponent(vcookie))}`
      : "";

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

    let rewritten = body.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${rewrite(toAbsolute(uri))}"`);
    rewritten = rewritten.replace(/^(?!#)(.+)$/gm, (line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return line;
      return rewrite(toAbsolute(t));
    });

    res.writeHead(
      200,
      corsHeaders({
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "public, s-maxage=30, max-age=0",
      }),
    );
    res.end(rewritten);
    return;
  }

  // Binary content — stream straight through. No buffering: a single 100 MB
  // MP4 buffered in memory under any non-trivial concurrency would OOM the
  // 512 MB Render free dyno.
  const passthroughHeaders = corsHeaders({
    "Content-Type": contentType || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, s-maxage=86400, max-age=3600, immutable",
  });
  const upstreamRange = response.headers.get("content-range");
  const upstreamLength = response.headers.get("content-length");
  if (upstreamRange) passthroughHeaders["Content-Range"] = upstreamRange;
  if (upstreamLength) passthroughHeaders["Content-Length"] = upstreamLength;

  res.writeHead(response.status, passthroughHeaders);

  if (!response.body) {
    res.end();
    return;
  }
  // Web ReadableStream → Node writable stream.
  const reader = response.body.getReader();
  const pump = async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise((r) => res.once("drain", r));
        }
      }
    } catch {
      /* client disconnect — fall through */
    } finally {
      res.end();
    }
  };
  req.on("close", () => reader.cancel().catch(() => {}));
  pump();
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) {
      writeJson(res, 500, { error: "Proxy failed", detail: String(err) });
    } else {
      try { res.end(); } catch {}
    }
  });
});

server.listen(PORT, () => {
  console.log(`aniscroll-proxy listening on :${PORT}`);
});
