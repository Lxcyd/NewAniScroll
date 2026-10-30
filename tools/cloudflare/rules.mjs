// Regles Cloudflare (WAF, rate limit, variante mobile, cache) pour un ou plusieurs hotes :
//   node tools/cloudflare/rules.mjs dev.aniscroll.com [aniscroll.com ...]
// ATTENTION : PUT remplace TOUTES les regles de chaque phase de la zone. Passer
// TOUS les hotes a couvrir a chaque appel (sinon ceux omis perdent leurs regles).
import { cf } from "./cf.mjs";
const ZONE = "9acc1df2c93a82f0bf5e80e873185ef2";
const HOSTS = process.argv.slice(2).length ? process.argv.slice(2) : ["dev.aniscroll.com"];
const path = "http.request.uri.path";
const anime = `(starts_with(${path}, "/en/anime/") or starts_with(${path}, "/fr/anime/"))`;
const scripts = ["curl/", "wget", "python-requests", "python-urllib", "aiohttp", "httpx", "go-http-client",
  "scrapy", "headlesschrome", "phantomjs", "okhttp", "java/", "libwww", "node-fetch", "axios/", "undici"];
const uaBad = `(http.user_agent eq "" or ${scripts.map((s) => `lower(http.user_agent) contains "${s}"`).join(" or ")})`;
// Meme liste que le rewrite `__m=1` de next.config.js (sensible a la casse comme lui).
const mobileTokens = ["Android", "android", "webOS", "iPhone", "iPad", "iPod", "BlackBerry", "IEMobile", "Opera Mini"];
const uaMobile = `(${mobileTokens.map((t) => `http.user_agent contains "${t}"`).join(" or ")})`;

const put = (phase, rules) => cf("PUT", `/zones/${ZONE}/rulesets/phases/${phase}/entrypoint`, { rules });
const show = (name, r) => console.log(name, r.success ? "OK" : JSON.stringify(r.errors));
const each = (fn) => HOSTS.flatMap((h) => fn(`http.host eq "${h}"`, h));

show("waf", await put("http_request_firewall_custom", each((host, h) => [{
  description: `${h} : scripts sans UA de navigateur sur les pages (hors API/_next, hors bots verifies)`,
  expression: `(${host} and not cf.client.bot and not starts_with(${path}, "/api/") and not starts_with(${path}, "/_next/") and ${uaBad})`,
  action: "managed_challenge",
}])));

show("ratelimit", await put("http_ratelimit", each((host, h) => [{
  description: `${h} : 20 pages anime / 10 s / IP`,
  expression: `(${host} and ${anime})`,
  action: "block",
  ratelimit: { characteristics: ["cf.colo.id", "ip.src"], period: 10, requests_per_period: 20, mitigation_timeout: 10 },
}])));

/* La fiche anime rend une mise en page differente sur telephone, choisie par
   `?__m=1` (cf. next.config.js). Le cache Cloudflare est cle par URL : le
   parametre doit donc etre pose AVANT le cache, ici, sinon un telephone et un
   PC partageraient la meme copie. Les autres pages ignorent le parametre. */
const noM = `not http.request.uri.query contains "__m="`;
show("mobile", await put("http_request_transform", each((host, h) => [
  {
    description: `${h} : variante mobile des pages anime (sans query)`,
    expression: `(${host} and ${anime} and ${uaMobile} and http.request.uri.query eq "")`,
    action: "rewrite",
    action_parameters: { uri: { query: { value: "__m=1" } } },
  },
  {
    description: `${h} : variante mobile des pages anime (avec query)`,
    expression: `(${host} and ${anime} and ${uaMobile} and http.request.uri.query ne "" and ${noM})`,
    action: "rewrite",
    action_parameters: { uri: { query: { expression: `concat(http.request.uri.query, "&__m=1")` } } },
  },
])));

/* Tout ce qui n'est pas une API privee : Cloudflare garde ce que l'origine
   declare cacheable (CDN-Cache-Control / s-maxage), et rien d'autre. Les pages
   personnelles envoient `private, no-store` et passent donc toujours. Le cache
   est vide a chaque deploiement (.github/workflows/purge-cf-cache.yml). */
show("cache", await put("http_request_cache_settings", each((host, h) => [{
  description: `${h} : pages, donnees et API publiques selon CDN-Cache-Control, rien sans en-tete`,
  expression: `(${host} and (not starts_with(${path}, "/api/") or starts_with(${path}, "/api/v2/")))`,
  action: "set_cache_settings",
  action_parameters: { cache: true, edge_ttl: { mode: "bypass_by_default" }, browser_ttl: { mode: "respect_origin" } },
}])));
