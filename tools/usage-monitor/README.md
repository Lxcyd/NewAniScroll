# Usage Monitor

Daily diagnostic collector for AniScroll's cost/usage hotspots. It answers the
question the Upstash and Vercel dashboards can't: **where does the load actually
come from, and is it trending toward a wall.**

It pulls three things and writes a dated snapshot + a markdown report with
day-over-day deltas and flags:

1. **Redis keyspace census** (Upstash REST) — every key bucketed by prefix
   (`src:`, `avail:`, `episode:`, `lock:`, W2G `room:`…), so you SEE which
   namespace dominates the DB (and therefore the command volume). This is the
   attribution the single aggregate "Daily Commands" number never gives you.
2. **Upstash daily requests** (management API) — the "Daily Commands" series
   itself, plus a **monthly projection vs the ~500K free cap** and a saturation
   flag (the metric that predicted July's mid-month cache death).
3. **Vercel recent deployments** (API, best-effort) — so a usage jump in the
   report can be correlated with the release that caused it.

> Vercel has **no** stable public API for per-route invocations / Active-CPU on
> Hobby — that lives only in the dashboard's Observability or a self-hosted Log
> Drain. So this tool focuses on the reliably-fetchable data (Upstash, which is
> the real bottleneck) and uses Vercel only for deploy correlation.

## Run it

```bash
node tools/usage-monitor/collect.mjs
```

Outputs:
- `snapshots/YYYY-MM-DD.json` — machine-readable, kept as history for deltas.
- `LATEST.md` — the full latest report.
- `HISTORY.md` — one summary line per day (newest first).

## Credentials

Reads `.env.local` automatically. Each collector degrades gracefully if its
creds are missing (the run still produces the parts it can).

| Collector | Env vars | Where to get them |
|---|---|---|
| **Census** (required for the useful part) | `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (or a live `REDIS_URL`) | Upstash console → **aniscroll-cache** → *REST API* tab |
| **Daily requests** | `UPSTASH_EMAIL` + `UPSTASH_API_KEY` (+ optional `UPSTASH_DATABASE_ID`) | Upstash console → *Account* → **Management API** → create key |
| **Vercel deploys** | `VERCEL_TOKEN` (+ optional `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID`) | vercel.com → *Account Settings* → **Tokens** |

> ⚠️ The `REDIS_URL` currently in `.env.local` points at an **old, deleted**
> Upstash DB (`stable-tahr-110008`, NXDOMAIN) — local dev runs with caching
> disabled. Point the census at the **live** DB by setting
> `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (from `aniscroll-cache`),
> either in `.env.local` or as CI secrets.

## Daily automation

A GitHub Action (`.github/workflows/usage-monitor.yml`) runs it every morning
and commits the snapshot + reports. Add the creds above as **repository
secrets** (Settings → Secrets and variables → Actions). It also supports
`workflow_dispatch` for a manual run.

Prefer to keep it out of git history? Switch the workflow's commit step for an
`actions/upload-artifact` step — the JSON snapshots are self-contained.

## Reading the report

- **Flags** section first: cap projection, dev/prod-shared-DB warning, day-over-
  day spikes, key-prefix explosions.
- **Census table**: the prefix with the biggest `%` is where your commands go.
  If `src:` dominates, the lever is the `/api/v2/source` probe fan-out (see
  DEVLOG 2026-07-30), not the edge-cached GETs.
- **databaseCount > 1** in the Upstash section = dev/prod are split (good);
  `1` = they still share one DB.
