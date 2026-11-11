# Usage Monitor — 2026-11-11

_Generated 2026-11-11T14:27:46.464Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **1,632** | scanned: 1,632 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 1,292 | 79.2% | (+89 +7%) |
| `tr:` | 199 | 12.2% | (+33 +20%) |
| `episode:` | 89 | 5.5% | (+13 +17%) |
| `ftree:` | 20 | 1.2% | (+13 +186%) |
| `avail:` | 14 | 0.9% | (+13 +1300%) |
| `anilist:` | 12 | 0.7% | (+8 +200%) |
| `src:` | 2 | 0.1% | (+1 +100%) |
| `bingo-season:` | 1 | 0.1% | (=) |
| `frembed:` | 1 | 0.1% | (=) |
| `index_server_v3:` | 1 | 0.1% | (=) |
| `new_schedule:` | 1 | 0.1% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 1,292 |
| `tr:fr` | 199 |
| `episode:v12` | 89 |
| `ftree:v5` | 20 |
| `avail:v5` | 14 |
| `anilist:resp` | 9 |
| `anilist:list` | 3 |
| `src:v15` | 2 |
| `bingo-season:v1` | 1 |
| `frembed:base` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
