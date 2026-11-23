# Usage Monitor — 2026-11-23

_Generated 2026-11-23T18:16:42.970Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **3,732** | scanned: 3,729 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 3,300 | 88.5% | (+1,277 +63%) |
| `tr:` | 226 | 6.1% | (+1 +0%) |
| `episode:` | 175 | 4.7% | (+7 +4%) |
| `avail:` | 10 | 0.3% | (+2 +25%) |
| `ftree:` | 7 | 0.2% | (-8 -53%) |
| `anilist:` | 6 | 0.2% | (-6 -50%) |
| `src:` | 2 | 0.1% | (=) |
| `bingo-season:` | 1 | 0.0% | (=) |
| `frembed:` | 1 | 0.0% | (=) |
| `index_server_v3:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 3,300 |
| `tr:fr` | 226 |
| `episode:v12` | 175 |
| `avail:v5` | 9 |
| `ftree:v5` | 7 |
| `anilist:list` | 4 |
| `anilist:resp` | 2 |
| `src:v15` | 2 |
| `avail:v6` | 1 |
| `bingo-season:v1` | 1 |
| `frembed:base` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
