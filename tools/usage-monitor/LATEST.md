# Usage Monitor — 2026-09-24

_Generated 2026-09-24T11:50:55.026Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **1,822** | scanned: 1,822 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 983 | 54.0% | (+117 +14%) |
| `episode:` | 607 | 33.3% | (+13 +2%) |
| `tr:` | 108 | 5.9% | (+5 +5%) |
| `src:` | 68 | 3.7% | (-349 -84%) |
| `avail:` | 18 | 1.0% | (-766 -98%) |
| `anilist:` | 17 | 0.9% | (-5 -23%) |
| `ftree:` | 6 | 0.3% | (-12 -67%) |
| `lock:` | 6 | 0.3% | — |
| `jikan:` | 4 | 0.2% | (+3 +300%) |
| `asSlug:` | 3 | 0.2% | (-1 -25%) |
| `index_server_v3:` | 1 | 0.1% | — |
| `new_schedule:` | 1 | 0.1% | — |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 619 |
| `episode:v12` | 592 |
| `anime:v6` | 364 |
| `tr:fr` | 108 |
| `src:v15` | 68 |
| `avail:v5` | 18 |
| `anilist:resp` | 15 |
| `episode:v11` | 15 |
| `ftree:v5` | 6 |
| `lock:src` | 6 |
| `jikan:eps` | 4 |
| `asSlug:v1` | 3 |
| `anilist:list` | 2 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
