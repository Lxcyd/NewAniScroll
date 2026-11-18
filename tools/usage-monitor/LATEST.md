# Usage Monitor — 2026-11-18

_Generated 2026-11-18T15:43:49.196Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **2,210** | scanned: 2,196 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 1,793 | 81.6% | (+50 +3%) |
| `tr:` | 232 | 10.6% | (=) |
| `episode:` | 133 | 6.1% | (+15 +13%) |
| `ftree:` | 17 | 0.8% | (+10 +143%) |
| `anilist:` | 7 | 0.3% | (-15 -68%) |
| `avail:` | 6 | 0.3% | (+4 +200%) |
| `src:` | 4 | 0.2% | (+2 +100%) |
| `asSlug:` | 1 | 0.0% | — |
| `bingo-season:` | 1 | 0.0% | (=) |
| `frembed:` | 1 | 0.0% | (=) |
| `index_server_v3:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 1,793 |
| `tr:fr` | 232 |
| `episode:v12` | 133 |
| `ftree:v5` | 17 |
| `avail:v5` | 4 |
| `src:v15` | 4 |
| `anilist:list` | 3 |
| `anilist:resp` | 3 |
| `avail:v6` | 2 |
| `anilist:health` | 1 |
| `asSlug:v1` | 1 |
| `bingo-season:v1` | 1 |
| `frembed:base` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
