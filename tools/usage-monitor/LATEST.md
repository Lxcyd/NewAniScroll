# Usage Monitor — 2026-11-16

_Generated 2026-11-16T15:52:43.144Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **2,082** | scanned: 2,078 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 1,688 | 81.2% | (+61 +4%) |
| `tr:` | 228 | 11.0% | (+4 +2%) |
| `episode:` | 121 | 5.8% | (+6 +5%) |
| `avail:` | 22 | 1.1% | (+16 +267%) |
| `anilist:` | 7 | 0.3% | (+3 +75%) |
| `ftree:` | 6 | 0.3% | (-17 -74%) |
| `src:` | 2 | 0.1% | (-3 -60%) |
| `asSlug:` | 1 | 0.0% | (=) |
| `bingo-season:` | 1 | 0.0% | (=) |
| `frembed:` | 1 | 0.0% | — |
| `index_server_v3:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 1,688 |
| `tr:fr` | 228 |
| `episode:v12` | 121 |
| `avail:v5` | 16 |
| `avail:v6` | 6 |
| `ftree:v5` | 6 |
| `anilist:list` | 3 |
| `anilist:resp` | 3 |
| `src:v15` | 2 |
| `anilist:upcoming` | 1 |
| `asSlug:v1` | 1 |
| `bingo-season:v1` | 1 |
| `frembed:base` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
