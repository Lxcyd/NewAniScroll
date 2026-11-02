# Usage Monitor — 2026-11-02

_Generated 2026-11-02T16:01:57.602Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **3,838** | scanned: 3,838 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 2,404 | 62.6% | (-7,097 -75%) |
| `episode:` | 1,291 | 33.6% | (-3,495 -73%) |
| `tr:` | 116 | 3.0% | (+23 +25%) |
| `avail:` | 15 | 0.4% | (+4 +36%) |
| `ftree:` | 6 | 0.2% | (+1 +20%) |
| `anilist:` | 3 | 0.1% | (-2 -40%) |
| `frembed:` | 1 | 0.0% | (=) |
| `index_server_v3:` | 1 | 0.0% | (=) |
| `recent-episode-v3:` | 1 | 0.0% | — |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 2,404 |
| `episode:v12` | 1,291 |
| `tr:fr` | 116 |
| `avail:v5` | 15 |
| `ftree:v5` | 6 |
| `anilist:list` | 1 |
| `anilist:resp` | 1 |
| `anilist:upcoming` | 1 |
| `frembed:base` | 1 |
| `recent-episode-v3:1` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
