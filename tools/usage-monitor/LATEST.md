# Usage Monitor — 2026-11-27

_Generated 2026-11-27T16:43:42.495Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **4,492** | scanned: 4,492 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 3,881 | 86.4% | (+160 +4%) |
| `episode:` | 295 | 6.6% | (+81 +38%) |
| `tr:` | 262 | 5.8% | (+9 +4%) |
| `ftree:` | 35 | 0.8% | (+11 +46%) |
| `avail:` | 11 | 0.2% | (-7 -39%) |
| `anilist:` | 4 | 0.1% | (-2 -33%) |
| `bingo-season:` | 1 | 0.0% | (=) |
| `frembed:` | 1 | 0.0% | (=) |
| `index_server_v3:` | 1 | 0.0% | (=) |
| `new_schedule:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 3,881 |
| `episode:v12` | 295 |
| `tr:fr` | 262 |
| `ftree:v5` | 35 |
| `avail:v6` | 8 |
| `anilist:resp` | 3 |
| `avail:v5` | 3 |
| `anilist:list` | 1 |
| `bingo-season:v1` | 1 |
| `frembed:base` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
