// Petit client API Cloudflare : node cf.mjs <METHOD> <path> [json-body]
import { readFileSync } from "fs";
const env = Object.fromEntries(
  readFileSync(new URL("../../.env", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
export async function cf(method, path, body) {
  const r = await fetch("https://api.cloudflare.com/client/v4" + path, {
    method,
    headers: { Authorization: "Bearer " + env.CF_ZONE_API_TOKEN, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}
export const ACCOUNT = env.CF_ZONE_ACCOUNT_ID;
if (process.argv[1]?.endsWith("cf.mjs") && process.argv[2]) {
  const [m, p, b] = process.argv.slice(2);
  console.log(JSON.stringify(await cf(m, p, b ? JSON.parse(b) : undefined), null, 1));
}
