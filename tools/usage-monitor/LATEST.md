# Usage Monitor — 2026-11-21

_Generated 2026-11-21T14:42:32.603Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **2,368** | scanned: 2,364 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 1,962 | 83.0% | (+42 +2%) |
| `tr:` | 215 | 9.1% | (-15 -7%) |
| `episode:` | 158 | 6.7% | (+8 +5%) |
| `ftree:` | 12 | 0.5% | (-14 -54%) |
| `anilist:` | 9 | 0.4% | (+3 +50%) |
| `avail:` | 2 | 0.1% | (-8 -80%) |
| `bingo-season:` | 1 | 0.0% | (=) |
| `frembed:` | 1 | 0.0% | (=) |
| `index_server_v3:` | 1 | 0.0% | (=) |
| `new_schedule:` | 1 | 0.0% | — |
| `recent-episode-v3:` | 1 | 0.0% | — |
| `src:` | 1 | 0.0% | (-1 -50%) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 1,962 |
| `tr:fr` | 215 |
| `episode:v12` | 158 |
| `ftree:v5` | 12 |
| `anilist:resp` | 6 |
| `anilist:list` | 3 |
| `avail:v5` | 1 |
| `avail:v6` | 1 |
| `bingo-season:v1` | 1 |
| `frembed:base` | 1 |
| `recent-episode-v3:1` | 1 |
| `src:v15` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
