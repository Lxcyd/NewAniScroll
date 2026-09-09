# Usage Monitor — 2026-09-09

_Generated 2026-09-09T11:27:56.710Z_

## ⚠️ Flags
- **Upstash on track to blow the free cap** (~828% of 500,000) → cache will die mid-month. Split dev/prod or go pay-as-you-go.
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **89,484** (-56,716 -39%) vs yesterday
- 7-day avg/day: **137,974**
- Projected month: **4,139,220** / 500,000 cap — **828%**

## Redis keyspace census (where the load comes from)
> _skipped: Upstash REST 400: {"error":"ERR max requests limit exceeded. Limit: 500000, Usage: 500000. See https://upstash.com/docs/redis/troubleshooting/max_requests_limit for details"}_

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
