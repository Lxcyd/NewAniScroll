// Regenere CF_ZONE_API_TOKEN (l'ancien meurt aussitot) et ecrit le nouveau
// dans .env, sans jamais l'afficher. node tools/cloudflare/roll-token.mjs
import fs from "fs";
import { cf, ACCOUNT } from "./cf.mjs";

const ENV = new URL("../../.env", import.meta.url);
const v = await cf("GET", `/accounts/${ACCOUNT}/tokens/verify`);
if (!v.success) throw new Error("jeton actuel refuse : " + JSON.stringify(v.errors));
const r = await cf("PUT", `/accounts/${ACCOUNT}/tokens/${v.result.id}/value`, {});
if (!r.success || typeof r.result !== "string") throw new Error("roll refuse : " + JSON.stringify(r.errors));
const txt = fs.readFileSync(ENV, "utf8");
if (!/^CF_ZONE_API_TOKEN=.*$/m.test(txt)) throw new Error("CF_ZONE_API_TOKEN absent du .env");
fs.writeFileSync(ENV, txt.replace(/^CF_ZONE_API_TOKEN=.*$/m, `CF_ZONE_API_TOKEN=${r.result}`));
console.log(`jeton ${v.result.id} regenere, .env mis a jour (${r.result.length} caracteres)`);
