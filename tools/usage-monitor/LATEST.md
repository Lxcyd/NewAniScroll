# Usage Monitor — 2026-11-10

_Generated 2026-11-10T14:56:54.906Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **1,462** | scanned: 1,462 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 1,203 | 82.3% | (+56 +5%) |
| `tr:` | 166 | 11.4% | (+9 +6%) |
| `episode:` | 76 | 5.2% | (+3 +4%) |
| `ftree:` | 7 | 0.5% | (-11 -61%) |
| `anilist:` | 4 | 0.3% | (-4 -50%) |
| `avail:` | 1 | 0.1% | (-3 -75%) |
| `bingo-season:` | 1 | 0.1% | (=) |
| `frembed:` | 1 | 0.1% | (=) |
| `index_server_v3:` | 1 | 0.1% | (=) |
| `new_schedule:` | 1 | 0.1% | — |
| `src:` | 1 | 0.1% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 1,203 |
| `tr:fr` | 166 |
| `episode:v12` | 76 |
| `ftree:v5` | 7 |
| `anilist:list` | 3 |
| `anilist:resp` | 1 |
| `avail:v5` | 1 |
| `bingo-season:v1` | 1 |
| `frembed:base` | 1 |
| `src:v15` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
