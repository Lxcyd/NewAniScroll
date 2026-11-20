# Usage Monitor — 2026-11-20

_Generated 2026-11-20T15:30:57.400Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **2,347** | scanned: 2,347 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 1,920 | 81.8% | (+70 +4%) |
| `tr:` | 230 | 9.8% | (+10 +5%) |
| `episode:` | 150 | 6.4% | (+13 +9%) |
| `ftree:` | 26 | 1.1% | (+20 +333%) |
| `avail:` | 10 | 0.4% | (+3 +43%) |
| `anilist:` | 6 | 0.3% | (-6 -50%) |
| `src:` | 2 | 0.1% | — |
| `bingo-season:` | 1 | 0.0% | (=) |
| `frembed:` | 1 | 0.0% | (=) |
| `index_server_v3:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 1,920 |
| `tr:fr` | 230 |
| `episode:v12` | 150 |
| `ftree:v5` | 26 |
| `avail:v5` | 7 |
| `anilist:resp` | 4 |
| `avail:v6` | 3 |
| `anilist:list` | 2 |
| `src:v15` | 2 |
| `bingo-season:v1` | 1 |
| `frembed:base` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
