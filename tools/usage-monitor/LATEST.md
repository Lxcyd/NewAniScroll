# Usage Monitor — 2026-11-07

_Generated 2026-11-07T13:08:18.286Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **1,240** | scanned: 1,232 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 970 | 78.7% | (+73 +8%) |
| `tr:` | 141 | 11.4% | (+7 +5%) |
| `episode:` | 57 | 4.6% | (+4 +8%) |
| `anilist:` | 42 | 3.4% | (+24 +133%) |
| `avail:` | 9 | 0.7% | (-4 -31%) |
| `ftree:` | 6 | 0.5% | (-1 -14%) |
| `src:` | 2 | 0.2% | (-18 -90%) |
| `bingo-season:` | 1 | 0.1% | (=) |
| `frembed:` | 1 | 0.1% | (=) |
| `index_server_v3:` | 1 | 0.1% | (=) |
| `new_schedule:` | 1 | 0.1% | (=) |
| `recent-episode-v3:` | 1 | 0.1% | — |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 970 |
| `tr:fr` | 141 |
| `episode:v12` | 57 |
| `anilist:resp` | 37 |
| `avail:v5` | 9 |
| `ftree:v5` | 6 |
| `anilist:list` | 3 |
| `src:v15` | 2 |
| `anilist:health` | 1 |
| `anilist:upcoming` | 1 |
| `bingo-season:v1` | 1 |
| `frembed:base` | 1 |
| `recent-episode-v3:1` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
