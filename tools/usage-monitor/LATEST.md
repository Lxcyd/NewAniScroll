# Usage Monitor — 2026-11-13

_Generated 2026-11-13T14:38:36.196Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **1,882** | scanned: 1,882 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 1,528 | 81.2% | (+55 +4%) |
| `tr:` | 215 | 11.4% | (+15 +8%) |
| `episode:` | 99 | 5.3% | (+8 +9%) |
| `avail:` | 17 | 0.9% | (+11 +183%) |
| `anilist:` | 11 | 0.6% | (+2 +22%) |
| `ftree:` | 8 | 0.4% | (+6 +300%) |
| `bingo-season:` | 1 | 0.1% | (=) |
| `frembed:` | 1 | 0.1% | (=) |
| `index_server_v3:` | 1 | 0.1% | (=) |
| `new_schedule:` | 1 | 0.1% | — |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 1,528 |
| `tr:fr` | 215 |
| `episode:v12` | 99 |
| `avail:v5` | 15 |
| `ftree:v5` | 8 |
| `anilist:list` | 6 |
| `anilist:resp` | 5 |
| `avail:v6` | 2 |
| `bingo-season:v1` | 1 |
| `frembed:base` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
