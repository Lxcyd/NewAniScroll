# Usage Monitor — 2026-11-05

_Generated 2026-11-05T14:42:36.856Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **1,015** | scanned: 1,015 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 817 | 80.5% | (+84 +11%) |
| `tr:` | 129 | 12.7% | (+1 +1%) |
| `episode:` | 48 | 4.7% | (+1 +2%) |
| `anilist:` | 11 | 1.1% | (+7 +175%) |
| `avail:` | 4 | 0.4% | (-1 -20%) |
| `ftree:` | 2 | 0.2% | (-6 -75%) |
| `bingo-season:` | 1 | 0.1% | — |
| `frembed:` | 1 | 0.1% | (=) |
| `index_server_v3:` | 1 | 0.1% | — |
| `new_schedule:` | 1 | 0.1% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 817 |
| `tr:fr` | 129 |
| `episode:v12` | 48 |
| `anilist:resp` | 7 |
| `avail:v5` | 4 |
| `anilist:list` | 3 |
| `ftree:v5` | 2 |
| `anilist:upcoming` | 1 |
| `bingo-season:v1` | 1 |
| `frembed:base` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
