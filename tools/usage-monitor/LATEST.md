# Usage Monitor — 2026-09-28

_Generated 2026-09-28T14:01:14.094Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **2,150** | scanned: 2,150 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 1,350 | 62.8% | (+61 +5%) |
| `episode:` | 645 | 30.0% | (+3 +0%) |
| `tr:` | 130 | 6.0% | (+7 +6%) |
| `anilist:` | 7 | 0.3% | (+3 +75%) |
| `avail:` | 7 | 0.3% | (-694 -99%) |
| `jikan:` | 5 | 0.2% | (=) |
| `ftree:` | 4 | 0.2% | (+3 +300%) |
| `index_server_v3:` | 1 | 0.0% | — |
| `src:` | 1 | 0.0% | — |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 731 |
| `episode:v12` | 630 |
| `anime:v5` | 619 |
| `tr:fr` | 130 |
| `episode:v11` | 15 |
| `avail:v5` | 7 |
| `anilist:resp` | 6 |
| `jikan:eps` | 5 |
| `ftree:v5` | 4 |
| `anilist:list` | 1 |
| `src:v15` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
