# Usage Monitor — 2026-11-25

_Generated 2026-11-25T17:17:27.173Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **4,231** | scanned: 4,211 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 3,663 | 87.0% | (+107 +3%) |
| `tr:` | 248 | 5.9% | (+13 +6%) |
| `episode:` | 200 | 4.7% | (+13 +7%) |
| `anilist:` | 44 | 1.0% | (+20 +83%) |
| `ftree:` | 21 | 0.5% | (+1 +5%) |
| `avail:` | 18 | 0.4% | (-2 -10%) |
| `src:` | 8 | 0.2% | (+3 +60%) |
| `asEps:` | 1 | 0.0% | — |
| `asSlug:` | 1 | 0.0% | (-1 -50%) |
| `bingo-season:` | 1 | 0.0% | (=) |
| `catalog:` | 1 | 0.0% | — |
| `discover:` | 1 | 0.0% | — |
| `frembed:` | 1 | 0.0% | (=) |
| `index_server_v3:` | 1 | 0.0% | (=) |
| `new_schedule:` | 1 | 0.0% | (=) |
| `recent-episode-v3:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 3,663 |
| `tr:fr` | 248 |
| `episode:v12` | 200 |
| `anilist:resp` | 38 |
| `ftree:v5` | 21 |
| `avail:v6` | 12 |
| `anilist:list` | 6 |
| `avail:v5` | 6 |
| `src:v18` | 5 |
| `src:az3` | 2 |
| `asEps:v3` | 1 |
| `asSlug:v1` | 1 |
| `bingo-season:v1` | 1 |
| `catalog:popular` | 1 |
| `discover:v2` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
