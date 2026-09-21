# Usage Monitor — 2026-09-21

_Generated 2026-09-21T17:15:31.564Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **1,482** | scanned: 1,482 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 630 | 42.5% | (-1,018 -62%) |
| `episode:` | 427 | 28.8% | (-2,452 -85%) |
| `src:` | 227 | 15.3% | (-192 -46%) |
| `tr:` | 86 | 5.8% | (+59 +219%) |
| `avail:` | 51 | 3.4% | (-316 -86%) |
| `anilist:` | 50 | 3.4% | (-857 -94%) |
| `ftree:` | 6 | 0.4% | (-127 -95%) |
| `asSlug:` | 3 | 0.2% | (-94 -97%) |
| `index_server_v3:` | 1 | 0.1% | (=) |
| `recent-episode-v2:` | 1 | 0.1% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 472 |
| `episode:v12` | 418 |
| `src:v14` | 227 |
| `anime:v6` | 158 |
| `tr:fr` | 86 |
| `avail:v5` | 51 |
| `anilist:resp` | 48 |
| `episode:v11` | 9 |
| `ftree:v5` | 6 |
| `asSlug:v1` | 3 |
| `anilist:list` | 1 |
| `anilist:rl` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
