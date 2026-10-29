// Cree (ou retrouve) le tunnel de la VM et le route : node tools/cloudflare/tunnel.mjs [hote]
// Ecrit TUNNEL_TOKEN dans .env (a copier dans infra/vm/.env sur la VM).
import fs from "fs";
import crypto from "crypto";
import { cf, ACCOUNT } from "./cf.mjs";

const ZONE = "9acc1df2c93a82f0bf5e80e873185ef2";
const HOST = process.argv[2] || "vm.aniscroll.com";
const NAME = "aniscroll-vm";
const A = `/accounts/${ACCOUNT}/cfd_tunnel`;
const must = (r, what) => {
  if (!r.success) throw new Error(`${what} : ${JSON.stringify(r.errors)}`);
  return r.result;
};

let t = must(await cf("GET", `${A}?name=${NAME}&is_deleted=false`), "liste")[0];
if (!t) {
  t = must(await cf("POST", A, { name: NAME, config_src: "cloudflare", tunnel_secret: crypto.randomBytes(32).toString("base64") }), "creation");
  console.log("tunnel cree", t.id);
} else console.log("tunnel existant", t.id);

must(await cf("PUT", `${A}/${t.id}/configurations`, {
  config: { ingress: [{ hostname: HOST, service: "http://nginx:80" }, { service: "http_status:404" }] },
}), "ingress");

const name = HOST;
const recs = must(await cf("GET", `/zones/${ZONE}/dns_records?name=${name}`), "dns");
const rec = { type: "CNAME", name, content: `${t.id}.cfargotunnel.com`, proxied: true, comment: "Tunnel vers la VM Oracle" };
if (recs[0]) must(await cf("PUT", `/zones/${ZONE}/dns_records/${recs[0].id}`, rec), "dns maj");
else must(await cf("POST", `/zones/${ZONE}/dns_records`, rec), "dns creation");
console.log(`${HOST} -> tunnel ${t.id} -> http://nginx:80`);

const token = must(await cf("GET", `${A}/${t.id}/token`), "token");
const ENV = new URL("../../.env", import.meta.url);
let txt = fs.readFileSync(ENV, "utf8");
txt = /^TUNNEL_TOKEN=/m.test(txt)
  ? txt.replace(/^TUNNEL_TOKEN=.*$/m, `TUNNEL_TOKEN=${token}`)
  : txt.replace(/\n?$/, `\n# Tunnel Cloudflare de la VM Oracle (${HOST})\nTUNNEL_TOKEN=${token}\n`);
fs.writeFileSync(ENV, txt);
console.log("TUNNEL_TOKEN ecrit dans .env");
