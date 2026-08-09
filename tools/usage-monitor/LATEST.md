# Usage Monitor — 2026-08-09

_Generated 2026-08-09T07:18:27.765Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **2,370** (-11,862 -83%) vs yesterday
- 7-day avg/day: **12,309**
- Projected month: **369,270** / 500,000 cap — **74%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **11,070** | scanned: 11,069 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 8,992 | 81.2% | (+297 +3%) |
| `episode:` | 1,860 | 16.8% | (+78 +4%) |
| `tr:` | 173 | 1.6% | (+41 +31%) |
| `jikan:` | 20 | 0.2% | (+1 +5%) |
| `anilist:` | 18 | 0.2% | (-152 -89%) |
| `avail:` | 5 | 0.0% | (+2 +67%) |
| `new_schedule:` | 1 | 0.0% | — |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 8,992 |
| `episode:v3` | 1,653 |
| `episode:v5` | 186 |
| `tr:fr` | 173 |
| `episode:v6` | 21 |
| `jikan:eps` | 20 |
| `anilist:resp` | 18 |
| `avail:v1` | 5 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
