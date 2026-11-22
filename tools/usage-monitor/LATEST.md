# Usage Monitor — 2026-11-22

_Generated 2026-11-22T14:38:43.124Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **2,460** | scanned: 2,460 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 2,023 | 82.2% | (+61 +3%) |
| `tr:` | 225 | 9.1% | (+10 +5%) |
| `episode:` | 168 | 6.8% | (+10 +6%) |
| `ftree:` | 15 | 0.6% | (+3 +25%) |
| `anilist:` | 12 | 0.5% | (+3 +33%) |
| `avail:` | 8 | 0.3% | (+6 +300%) |
| `asSlug:` | 2 | 0.1% | — |
| `src:` | 2 | 0.1% | (+1 +100%) |
| `bingo-season:` | 1 | 0.0% | (=) |
| `frembed:` | 1 | 0.0% | (=) |
| `index_server_v3:` | 1 | 0.0% | (=) |
| `new_schedule:` | 1 | 0.0% | (=) |
| `recent-episode-v3:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 2,023 |
| `tr:fr` | 225 |
| `episode:v12` | 168 |
| `ftree:v5` | 15 |
| `anilist:resp` | 9 |
| `avail:v6` | 6 |
| `anilist:list` | 3 |
| `asSlug:v1` | 2 |
| `avail:v5` | 2 |
| `src:v15` | 2 |
| `bingo-season:v1` | 1 |
| `frembed:base` | 1 |
| `recent-episode-v3:1` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
