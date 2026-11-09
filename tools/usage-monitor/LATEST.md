# Usage Monitor — 2026-11-09

_Generated 2026-11-09T16:27:45.887Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **1,412** | scanned: 1,411 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 1,147 | 81.3% | (+100 +10%) |
| `tr:` | 157 | 11.1% | (+14 +10%) |
| `episode:` | 73 | 5.2% | (+16 +28%) |
| `ftree:` | 18 | 1.3% | — |
| `anilist:` | 8 | 0.6% | (+2 +33%) |
| `avail:` | 4 | 0.3% | (-5 -56%) |
| `bingo-season:` | 1 | 0.1% | (=) |
| `frembed:` | 1 | 0.1% | (=) |
| `index_server_v3:` | 1 | 0.1% | (=) |
| `src:` | 1 | 0.1% | (-1 -50%) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 1,147 |
| `tr:fr` | 157 |
| `episode:v12` | 73 |
| `ftree:v5` | 18 |
| `anilist:resp` | 5 |
| `avail:v5` | 4 |
| `anilist:list` | 3 |
| `bingo-season:v1` | 1 |
| `frembed:base` | 1 |
| `src:v15` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
