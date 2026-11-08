# Usage Monitor — 2026-11-08

_Generated 2026-11-08T13:29:50.052Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **1,268** | scanned: 1,268 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 1,047 | 82.6% | (+77 +8%) |
| `tr:` | 143 | 11.3% | (+2 +1%) |
| `episode:` | 57 | 4.5% | (=) |
| `avail:` | 9 | 0.7% | (=) |
| `anilist:` | 6 | 0.5% | (-36 -86%) |
| `src:` | 2 | 0.2% | (=) |
| `bingo-season:` | 1 | 0.1% | (=) |
| `frembed:` | 1 | 0.1% | (=) |
| `index_server_v3:` | 1 | 0.1% | (=) |
| `new_schedule:` | 1 | 0.1% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 1,047 |
| `tr:fr` | 143 |
| `episode:v12` | 57 |
| `avail:v5` | 9 |
| `anilist:resp` | 4 |
| `anilist:list` | 2 |
| `src:v15f2` | 2 |
| `bingo-season:v1` | 1 |
| `frembed:base` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
