# AniScroll HLS Proxy (Cloudflare Worker)

Bandwidth-friendly replacement for `pages/api/v2/proxy/m3u8.js`.

Same query contract:

```
GET https://<worker>/?url=<encoded>&referer=<optional>&vcookie=<optional>
```

## Why

Every `.ts` segment Vidstack pulls hits the proxy. On Vercel that's "Fast
Origin Transfer" — 10 GB free, then metered. A popular episode burns
200–700 MB. Cloudflare Workers have unmetered bandwidth and an automatic
edge cache, so the second viewer of a popular segment usually doesn't even
reach the origin.

## Deploy

```powershell
cd worker
npm install
npx wrangler login          # one-time
npx wrangler deploy
```

The output prints the Worker URL — typically
`https://aniscroll-proxy.<your-account>.workers.dev`. Copy that.

## Wire the Next.js side

In your Next.js `.env` (and the Vercel dashboard for prod), set:

```
NEXT_PUBLIC_PROXY_BASE="https://aniscroll-proxy.<your-account>.workers.dev"
```

Leave it unset to fall back to the in-tree `/api/v2/proxy/m3u8` (useful for
local dev when you don't want to redeploy the Worker on every change).

## Local dev

```powershell
npx wrangler dev
```

Hits `http://localhost:8787`. Point `NEXT_PUBLIC_PROXY_BASE` at it if you
want the Next.js dev server to use the local Worker.

## Notes on VOE

VOE's CDN requires a per-IP DDoS-Guard cookie captured during extraction.
The Next.js extractor (`lib/extractors.js`) now appends that cookie to the
playback URL as `&vcookie=<encoded>`. The Worker reads it back and forwards
it as the `Cookie` header. No shared store needed.
