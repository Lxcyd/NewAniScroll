# Usage Monitor — 2026-09-25

_Generated 2026-09-25T11:54:40.688Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **2,005** | scanned: 2,005 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 1,084 | 54.1% | (+101 +10%) |
| `episode:` | 632 | 31.5% | (+25 +4%) |
| `src:` | 132 | 6.6% | (+64 +94%) |
| `tr:` | 119 | 5.9% | (+11 +10%) |
| `anilist:` | 11 | 0.5% | (-6 -35%) |
| `lock:` | 7 | 0.3% | (+1 +17%) |
| `avail:` | 6 | 0.3% | (-12 -67%) |
| `ftree:` | 6 | 0.3% | (=) |
| `jikan:` | 4 | 0.2% | (=) |
| `asSlug:` | 2 | 0.1% | (-1 -33%) |
| `new_schedule:` | 1 | 0.0% | (=) |
| `recent-episode-v3:` | 1 | 0.0% | — |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 619 |
| `episode:v12` | 617 |
| `anime:v6` | 465 |
| `src:v15` | 132 |
| `tr:fr` | 119 |
| `episode:v11` | 15 |
| `anilist:resp` | 9 |
| `lock:src` | 7 |
| `avail:v5` | 6 |
| `ftree:v5` | 6 |
| `jikan:eps` | 4 |
| `anilist:list` | 2 |
| `asSlug:v1` | 2 |
| `recent-episode-v3:1` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
