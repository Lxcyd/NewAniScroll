# Usage Monitor — 2026-11-14

_Generated 2026-11-14T13:36:02.116Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **1,922** | scanned: 1,922 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 1,569 | 81.6% | (+41 +3%) |
| `tr:` | 221 | 11.5% | (+6 +3%) |
| `episode:` | 107 | 5.6% | (+8 +8%) |
| `avail:` | 9 | 0.5% | (-8 -47%) |
| `ftree:` | 7 | 0.4% | (-1 -12%) |
| `anilist:` | 4 | 0.2% | (-7 -64%) |
| `asSlug:` | 1 | 0.1% | — |
| `bingo-season:` | 1 | 0.1% | (=) |
| `frembed:` | 1 | 0.1% | (=) |
| `index_server_v3:` | 1 | 0.1% | (=) |
| `new_schedule:` | 1 | 0.1% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 1,569 |
| `tr:fr` | 221 |
| `episode:v12` | 107 |
| `ftree:v5` | 7 |
| `avail:v6` | 5 |
| `avail:v5` | 4 |
| `anilist:list` | 2 |
| `anilist:resp` | 2 |
| `asSlug:v1` | 1 |
| `bingo-season:v1` | 1 |
| `frembed:base` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
