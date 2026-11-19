# Usage Monitor — 2026-11-19

_Generated 2026-11-19T15:48:41.534Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **2,236** | scanned: 2,235 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 1,850 | 82.8% | (+57 +3%) |
| `tr:` | 220 | 9.8% | (-12 -5%) |
| `episode:` | 137 | 6.1% | (+4 +3%) |
| `anilist:` | 12 | 0.5% | (+5 +71%) |
| `avail:` | 7 | 0.3% | (+1 +17%) |
| `ftree:` | 6 | 0.3% | (-11 -65%) |
| `bingo-season:` | 1 | 0.0% | (=) |
| `frembed:` | 1 | 0.0% | (=) |
| `index_server_v3:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 1,850 |
| `tr:fr` | 220 |
| `episode:v12` | 137 |
| `anilist:resp` | 10 |
| `ftree:v5` | 6 |
| `avail:v5` | 5 |
| `anilist:list` | 2 |
| `avail:v6` | 2 |
| `bingo-season:v1` | 1 |
| `frembed:base` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
