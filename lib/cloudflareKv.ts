/**
 * Tiny write-through to Cloudflare KV via its REST API.
 *
 * The Worker (worker/src/edge-endpoints.js) serves /w/health and /w/broadcast
 * by READING a KV namespace. Workers can't reach our Redis (ioredis = raw TCP),
 * so the Next.js side — which already caches these values in Redis — also
 * mirrors them into KV here, and the Worker reads KV.
 *
 * Fully best-effort: every call is fire-and-forget and swallows errors. If the
 * env vars are unset (or KV is down), the Worker simply serves its last value /
 * a safe default, and the Vercel fallback routes still work. KV is a cache
 * mirror, never a source of truth.
 *
 * Env (set on Vercel):
 *   CF_ACCOUNT_ID        Cloudflare account id
 *   CF_KV_NAMESPACE_ID   the W2G_CACHE namespace id (same one bound in the Worker)
 *   CF_KV_API_TOKEN      API token with "Workers KV Storage: Edit" permission
 */

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const NAMESPACE_ID = process.env.CF_KV_NAMESPACE_ID;
const API_TOKEN = process.env.CF_KV_API_TOKEN;

export function cloudflareKvEnabled(): boolean {
  return !!(ACCOUNT_ID && NAMESPACE_ID && API_TOKEN);
}

/** Mirror a value into Cloudflare KV. Fire-and-forget; never throws. */
export function writeCloudflareKv(key: string, value: string): void {
  if (!cloudflareKvEnabled()) return;
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}/values/${encodeURIComponent(
    key,
  )}`;
  fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "text/plain",
    },
    body: value,
  }).catch(() => {
    /* best-effort mirror — Redis + the Vercel fallback route still serve */
  });
}
