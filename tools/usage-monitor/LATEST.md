# Usage Monitor — 2026-11-17

_Generated 2026-11-17T16:05:38.810Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **2,129** | scanned: 2,129 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 1,743 | 81.9% | (+55 +3%) |
| `tr:` | 232 | 10.9% | (+4 +2%) |
| `episode:` | 118 | 5.5% | (-3 -2%) |
| `anilist:` | 22 | 1.0% | (+15 +214%) |
| `ftree:` | 7 | 0.3% | (+1 +17%) |
| `avail:` | 2 | 0.1% | (-20 -91%) |
| `src:` | 2 | 0.1% | (=) |
| `bingo-season:` | 1 | 0.0% | (=) |
| `frembed:` | 1 | 0.0% | (=) |
| `index_server_v3:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 1,743 |
| `tr:fr` | 232 |
| `episode:v12` | 118 |
| `anilist:resp` | 19 |
| `ftree:v5` | 7 |
| `anilist:list` | 3 |
| `avail:v6` | 2 |
| `src:v18` | 2 |
| `bingo-season:v1` | 1 |
| `frembed:base` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
