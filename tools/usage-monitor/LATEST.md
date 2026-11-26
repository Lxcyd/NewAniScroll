# Usage Monitor — 2026-11-26

_Generated 2026-11-26T16:58:23.107Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **4,243** | scanned: 4,240 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 3,721 | 87.8% | (+58 +2%) |
| `tr:` | 253 | 6.0% | (+5 +2%) |
| `episode:` | 214 | 5.0% | (+14 +7%) |
| `ftree:` | 24 | 0.6% | (+3 +14%) |
| `avail:` | 18 | 0.4% | (=) |
| `anilist:` | 6 | 0.1% | (-38 -86%) |
| `bingo-season:` | 1 | 0.0% | (=) |
| `frembed:` | 1 | 0.0% | (=) |
| `index_server_v3:` | 1 | 0.0% | (=) |
| `new_schedule:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 3,721 |
| `tr:fr` | 253 |
| `episode:v12` | 214 |
| `ftree:v5` | 24 |
| `avail:v5` | 15 |
| `anilist:list` | 6 |
| `avail:v6` | 3 |
| `bingo-season:v1` | 1 |
| `frembed:base` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
