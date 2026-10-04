# Usage Monitor — 2026-10-04

_Generated 2026-10-04T12:25:53.654Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **24,922** | scanned: 24,920 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 15,135 | 60.7% | (+2,724 +22%) |
| `episode:` | 7,230 | 29.0% | (+1,573 +28%) |
| `ftree:` | 1,134 | 4.6% | (-1,870 -62%) |
| `src:` | 971 | 3.9% | (-2,429 -71%) |
| `avail:` | 257 | 1.0% | (-62 -19%) |
| `tr:` | 184 | 0.7% | (+8 +5%) |
| `anilist:` | 5 | 0.0% | (-559 -99%) |
| `jikan:` | 3 | 0.0% | (=) |
| `new_schedule:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 14,516 |
| `episode:v12` | 7,215 |
| `ftree:v5` | 1,134 |
| `src:v15` | 971 |
| `anime:v5` | 619 |
| `avail:v5` | 257 |
| `tr:fr` | 184 |
| `episode:v11` | 15 |
| `jikan:eps` | 3 |
| `anilist:list` | 2 |
| `anilist:resp` | 2 |
| `anilist:upcoming` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
