# Usage Monitor — 2026-08-08

_Generated 2026-08-08T07:17:23.127Z_

## ⚠️ Flags
- **Upstash on track to blow the free cap** (~110% of 500,000) → cache will die mid-month. Split dev/prod or go pay-as-you-go.
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **4,800** (-10,409 -68%) vs yesterday
- 7-day avg/day: **18,410**
- Projected month: **552,300** / 500,000 cap — **110%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **10,842** | scanned: 10,802 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 8,695 | 80.5% | (+1,264 +17%) |
| `episode:` | 1,782 | 16.5% | (+1 +0%) |
| `anilist:` | 170 | 1.6% | (+4 +2%) |
| `tr:` | 132 | 1.2% | (+1 +1%) |
| `jikan:` | 19 | 0.2% | (=) |
| `avail:` | 3 | 0.0% | (-5 -62%) |
| `index_server_v2:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 8,695 |
| `episode:v3` | 1,653 |
| `anilist:resp` | 170 |
| `tr:fr` | 132 |
| `episode:v5` | 129 |
| `jikan:eps` | 19 |
| `avail:v1` | 3 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
