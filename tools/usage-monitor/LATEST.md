# Usage Monitor — 2026-11-03

_Generated 2026-11-03T14:21:23.544Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **1,145** | scanned: 1,145 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 582 | 50.8% | (-1,822 -76%) |
| `anilist:` | 379 | 33.1% | (+376 +12533%) |
| `tr:` | 122 | 10.7% | (+6 +5%) |
| `episode:` | 30 | 2.6% | (-1,261 -98%) |
| `avail:` | 15 | 1.3% | (=) |
| `ftree:` | 12 | 1.0% | (+6 +100%) |
| `admin:` | 1 | 0.1% | — |
| `broadcast:` | 1 | 0.1% | — |
| `frembed:` | 1 | 0.1% | (=) |
| `index_server_v3:` | 1 | 0.1% | (=) |
| `new_schedule:` | 1 | 0.1% | — |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 582 |
| `anilist:resp` | 377 |
| `tr:fr` | 122 |
| `episode:v12` | 30 |
| `avail:v5` | 15 |
| `ftree:v5` | 12 |
| `admin:stats` | 1 |
| `anilist:list` | 1 |
| `anilist:upcoming` | 1 |
| `broadcast:current` | 1 |
| `frembed:base` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
