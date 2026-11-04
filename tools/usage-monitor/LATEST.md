# Usage Monitor — 2026-11-04

_Generated 2026-11-04T14:37:31.045Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **928** | scanned: 928 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 733 | 79.0% | (+151 +26%) |
| `tr:` | 128 | 13.8% | (+6 +5%) |
| `episode:` | 47 | 5.1% | (+17 +57%) |
| `ftree:` | 8 | 0.9% | (-4 -33%) |
| `avail:` | 5 | 0.5% | (-10 -67%) |
| `anilist:` | 4 | 0.4% | (-375 -99%) |
| `frembed:` | 1 | 0.1% | (=) |
| `new_schedule:` | 1 | 0.1% | (=) |
| `recent-episode-v3:` | 1 | 0.1% | — |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 733 |
| `tr:fr` | 128 |
| `episode:v12` | 47 |
| `ftree:v5` | 8 |
| `avail:v5` | 5 |
| `anilist:list` | 3 |
| `anilist:upcoming` | 1 |
| `frembed:base` | 1 |
| `recent-episode-v3:1` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
