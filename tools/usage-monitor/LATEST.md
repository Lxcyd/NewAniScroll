# Usage Monitor — 2026-11-01

_Generated 2026-11-01T13:29:58.754Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **14,462** | scanned: 14,405 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 9,501 | 66.0% | (-5,634 -37%) |
| `episode:` | 4,786 | 33.2% | (-2,444 -34%) |
| `tr:` | 93 | 0.6% | (-91 -49%) |
| `avail:` | 11 | 0.1% | (-246 -96%) |
| `anilist:` | 5 | 0.0% | (=) |
| `ftree:` | 5 | 0.0% | (-1,129 -100%) |
| `admin:` | 1 | 0.0% | — |
| `frembed:` | 1 | 0.0% | — |
| `index_server_v3:` | 1 | 0.0% | — |
| `new_schedule:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 9,501 |
| `episode:v12` | 4,786 |
| `tr:fr` | 93 |
| `avail:v5` | 11 |
| `ftree:v5` | 5 |
| `anilist:resp` | 3 |
| `admin:stats` | 1 |
| `anilist:list` | 1 |
| `anilist:upcoming` | 1 |
| `frembed:base` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
