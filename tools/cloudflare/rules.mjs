// Regles phase 1 (WAF, rate limit, cache) pour un hote : node tools/cloudflare/rules.mjs [dev.aniscroll.com]
// ATTENTION : PUT remplace TOUTES les regles de chaque phase de la zone.
import { cf } from "./cf.mjs";
const ZONE = "9acc1df2c93a82f0bf5e80e873185ef2";
const HOST = process.argv[2] || "dev.aniscroll.com";
const host = `http.host eq "${HOST}"`;
const anime = `(starts_with(http.request.uri.path, "/en/anime/") or starts_with(http.request.uri.path, "/fr/anime/"))`;
const scripts = ["curl/", "wget", "python-requests", "python-urllib", "aiohttp", "httpx", "go-http-client",
  "scrapy", "headlesschrome", "phantomjs", "okhttp", "java/", "libwww", "node-fetch", "axios/", "undici"];
const uaBad = `(http.user_agent eq "" or ${scripts.map((s) => `lower(http.user_agent) contains "${s}"`).join(" or ")})`;

const put = (phase, rules) => cf("PUT", `/zones/${ZONE}/rulesets/phases/${phase}/entrypoint`, { rules });
const show = (name, r) => console.log(name, r.success ? "OK" : JSON.stringify(r.errors));

show("waf", await put("http_request_firewall_custom", [{
  description: `${HOST} : scripts sans UA de navigateur sur les pages (hors API/_next, hors bots verifies)`,
  expression: `(${host} and not cf.client.bot and not starts_with(http.request.uri.path, "/api/") and not starts_with(http.request.uri.path, "/_next/") and ${uaBad})`,
  action: "managed_challenge",
}]));

show("ratelimit", await put("http_ratelimit", [{
  description: `${HOST} : 20 pages anime / 10 s / IP`,
  expression: `(${host} and ${anime})`,
  action: "block",
  ratelimit: { characteristics: ["cf.colo.id", "ip.src"], period: 10, requests_per_period: 20, mitigation_timeout: 10 },
}]));

show("cache", await put("http_request_cache_settings", [{
  description: `${HOST} : donnees de page + API publiques selon CDN-Cache-Control, rien sans en-tete`,
  expression: `(${host} and (starts_with(http.request.uri.path, "/_next/data/") or starts_with(http.request.uri.path, "/api/v2/")))`,
  action: "set_cache_settings",
  action_parameters: { cache: true, edge_ttl: { mode: "bypass_by_default" }, browser_ttl: { mode: "respect_origin" } },
}]));
