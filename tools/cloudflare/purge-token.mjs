// Cree un jeton Cloudflare limite a « Cache Purge » sur la zone aniscroll.com,
// l'ecrit dans .env (CF_PURGE_TOKEN) et dans les secrets GitHub, sans l'afficher.
//   node tools/cloudflare/purge-token.mjs
import fs from "fs";
import { execFileSync } from "child_process";
import { cf, ACCOUNT } from "./cf.mjs";

const ZONE = "9acc1df2c93a82f0bf5e80e873185ef2";
const r = await cf("POST", `/accounts/${ACCOUNT}/tokens`, {
  name: "aniscroll purge cache (GitHub Actions)",
  policies: [{
    effect: "allow",
    resources: { [`com.cloudflare.api.account.zone.${ZONE}`]: "*" },
    permission_groups: [{ id: "e17beae8b8cb423a99b1730f21238bed" }], // Cache Purge
  }],
});
if (!r.success) throw new Error(JSON.stringify(r.errors));
const token = r.result.value;
const ENV = new URL("../../.env", import.meta.url);
let txt = fs.readFileSync(ENV, "utf8");
txt = /^CF_PURGE_TOKEN=/m.test(txt)
  ? txt.replace(/^CF_PURGE_TOKEN=.*$/m, `CF_PURGE_TOKEN=${token}`)
  : txt.replace(/\n?$/, `\n# Jeton Cloudflare limite au vidage du cache (workflow purge-cf-cache)\nCF_PURGE_TOKEN=${token}\n`);
fs.writeFileSync(ENV, txt);
execFileSync("gh", ["secret", "set", "CF_PURGE_TOKEN"], { input: token, stdio: ["pipe", "inherit", "inherit"] });
console.log(`jeton ${r.result.id} cree (Cache Purge seulement), .env + secret GitHub mis a jour`);
