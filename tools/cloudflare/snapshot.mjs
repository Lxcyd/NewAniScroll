// Etat des lieux de la zone avant modification : node tools/cloudflare/snapshot.mjs [fichier.json]
import { writeFileSync } from "fs";
import { cf, ACCOUNT } from "./cf.mjs";
const out = {};
out.verify = await cf("GET", `/accounts/${ACCOUNT}/tokens/verify`);
const zones = await cf("GET", "/zones?name=aniscroll.com");
const zone = zones.result?.[0];
out.zone = zone ? { id: zone.id, plan: zone.plan?.name, status: zone.status } : zones;
if (zone) {
  const Z = `/zones/${zone.id}`;
  out.dns = (await cf("GET", `${Z}/dns_records?per_page=200`)).result?.map((r) => ({
    id: r.id, type: r.type, name: r.name, content: r.content, proxied: r.proxied,
  }));
  for (const s of ["ssl", "always_use_https", "browser_check", "security_level", "0rtt", "http3"])
    out["setting_" + s] = (await cf("GET", `${Z}/settings/${s}`)).result?.value;
  out.bot = (await cf("GET", `${Z}/bot_management`)).result;
  out.tiered = (await cf("GET", `${Z}/argo/tiered_caching`)).result?.value;
  out.rulesets = {};
  for (const phase of [
    "http_request_firewall_custom", "http_ratelimit", "http_request_transform",
    "http_request_cache_settings", "http_config_settings", "http_request_dynamic_redirect",
  ]) {
    const r = await cf("GET", `${Z}/rulesets/phases/${phase}/entrypoint`);
    out.rulesets[phase] = r.success ? r.result.rules ?? [] : r.errors;
  }
}
const f = process.argv[2] || "zone-snapshot.json";
writeFileSync(f, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
