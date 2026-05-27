# AniScroll stream proxy

Tiny HTTP server that re-emits requests with the correct `Referer` so hosts
that block Cloudflare Worker IPs (`video.sibnet.ru`, `acek-cdn.com`, …) accept
them.

Same query contract as the Cloudflare Worker:

```
GET /?url=<encoded>&referer=<optional>&vcookie=<optional>&raw=<0|1>
```

`raw=1` returns the upstream `m3u8` without segment rewriting — the Worker
uses this so it can rewrite to its own URLs and keep segments routed through
its edge cache.

## Why it exists

Sibnet and the Smoothpre playback CDN refuse Cloudflare Worker egress IP
ranges outright (sibnet: HTTP 400 on the first hop, no redirect; acek-cdn:
HTTP 530). Vercel's AWS IPs are accepted but every byte counts against the
Fast Origin Transfer quota — not a fit for actual video traffic.

The proxy lives on a host whose IPs the upstream tolerates (Render, Fly.io,
Railway free tiers all qualify). The Cloudflare Worker then fetches sibnet
content through this proxy and caches the result at the CF edge, so most
requests after the first never reach us at all.

## Deploy — Fly.io (recommended)

Fly's free tier gives 3 shared-CPU machines, no cold start, 160 GB outbound
per month. That's enough for ~250–800 anime episodes/month going through
sibnet+smoothpre directly, before any caching multiplier from the Worker.

```bash
# one-time setup
curl -L https://fly.io/install.sh | sh
fly auth login

# from this directory
cd proxy
fly launch --no-deploy          # accept the suggested name, or override
fly deploy
```

`fly deploy` prints the public URL, e.g. `https://aniscroll-proxy.fly.dev`.

## Deploy — Render

Free tier, 100 GB outbound/month, but the service sleeps after 15 min of
idle. Cold start ≈ 30–50 s. Fine if you can tolerate that, or pair it with
a keep-alive ping from the Cloudflare Worker (a cron trigger every 10 min
fits in the Workers free tier).

1. Push this repo to GitHub.
2. https://dashboard.render.com → **New → Web Service**.
3. Connect the repo and point at the `proxy/` directory.
4. Runtime: **Docker** (Render picks up the `Dockerfile`).
5. Free plan, region close to your viewers.

Render prints a URL like `https://aniscroll-proxy.onrender.com`.

## Wire it up on Vercel

Add this env var on the Vercel project (Settings → Environment Variables):

```
ANIME_PROXY_URL=https://<your proxy>
```

The Worker reads it as well — set it in `worker/wrangler.toml` under `[vars]`
and re-run `npx wrangler deploy` for the Worker change to take effect.

## Local dev

```bash
cd proxy
npm start
# server on http://localhost:8080
```

Point `ANIME_PROXY_URL=http://localhost:8080` while testing.
