# Usage Monitor — 2026-11-24

_Generated 2026-11-24T17:50:48.915Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **4,059** | scanned: 4,054 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 3,556 | 87.7% | (+256 +8%) |
| `tr:` | 235 | 5.8% | (+9 +4%) |
| `episode:` | 187 | 4.6% | (+12 +7%) |
| `anilist:` | 24 | 0.6% | (+18 +300%) |
| `avail:` | 20 | 0.5% | (+10 +100%) |
| `ftree:` | 20 | 0.5% | (+13 +186%) |
| `src:` | 5 | 0.1% | (+3 +150%) |
| `asSlug:` | 2 | 0.0% | — |
| `bingo-season:` | 1 | 0.0% | (=) |
| `frembed:` | 1 | 0.0% | (=) |
| `index_server_v3:` | 1 | 0.0% | (=) |
| `new_schedule:` | 1 | 0.0% | — |
| `recent-episode-v3:` | 1 | 0.0% | — |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 3,556 |
| `tr:fr` | 235 |
| `episode:v12` | 187 |
| `ftree:v5` | 20 |
| `anilist:resp` | 18 |
| `avail:v5` | 13 |
| `avail:v6` | 7 |
| `anilist:list` | 5 |
| `src:v15` | 5 |
| `asSlug:v1` | 2 |
| `anilist:upcoming` | 1 |
| `bingo-season:v1` | 1 |
| `frembed:base` | 1 |
| `recent-episode-v3:1` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
