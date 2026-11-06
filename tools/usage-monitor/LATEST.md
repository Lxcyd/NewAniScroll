# Usage Monitor — 2026-11-06

_Generated 2026-11-06T14:20:44.978Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **1,146** | scanned: 1,146 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 897 | 78.3% | (+80 +10%) |
| `tr:` | 134 | 11.7% | (+5 +4%) |
| `episode:` | 53 | 4.6% | (+5 +10%) |
| `src:` | 20 | 1.7% | — |
| `anilist:` | 18 | 1.6% | (+7 +64%) |
| `avail:` | 13 | 1.1% | (+9 +225%) |
| `ftree:` | 7 | 0.6% | (+5 +250%) |
| `bingo-season:` | 1 | 0.1% | (=) |
| `frembed:` | 1 | 0.1% | (=) |
| `index_server_v3:` | 1 | 0.1% | (=) |
| `new_schedule:` | 1 | 0.1% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 897 |
| `tr:fr` | 134 |
| `episode:v12` | 53 |
| `anilist:resp` | 15 |
| `avail:v5` | 13 |
| `src:v15` | 10 |
| `src:v16` | 8 |
| `ftree:v5` | 7 |
| `anilist:list` | 2 |
| `src:v15f2` | 2 |
| `anilist:upcoming` | 1 |
| `bingo-season:v1` | 1 |
| `frembed:base` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
