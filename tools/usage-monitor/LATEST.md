# Usage Monitor — 2026-11-12

_Generated 2026-11-12T15:19:57.606Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **1,784** | scanned: 1,784 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 1,473 | 82.6% | (+181 +14%) |
| `tr:` | 200 | 11.2% | (+1 +1%) |
| `episode:` | 91 | 5.1% | (+2 +2%) |
| `anilist:` | 9 | 0.5% | (-3 -25%) |
| `avail:` | 6 | 0.3% | (-8 -57%) |
| `ftree:` | 2 | 0.1% | (-18 -90%) |
| `bingo-season:` | 1 | 0.1% | (=) |
| `frembed:` | 1 | 0.1% | (=) |
| `index_server_v3:` | 1 | 0.1% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 1,473 |
| `tr:fr` | 200 |
| `episode:v12` | 91 |
| `anilist:resp` | 6 |
| `avail:v5` | 6 |
| `anilist:list` | 3 |
| `ftree:v5` | 2 |
| `bingo-season:v1` | 1 |
| `frembed:base` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
