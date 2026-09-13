# Usage Monitor — 2026-09-13

_Generated 2026-09-13T12:37:20.121Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **942** | scanned: 894 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anilist:` | 376 | 42.1% | — |
| `episode:` | 207 | 23.2% | (+203 +5075%) |
| `src:` | 105 | 11.7% | — |
| `anime:` | 98 | 11.0% | (+23 +31%) |
| `avail:` | 68 | 7.6% | — |
| `asSlug:` | 20 | 2.2% | — |
| `tr:` | 9 | 1.0% | (-2 -18%) |
| `ftree:` | 8 | 0.9% | — |
| `asEps:` | 1 | 0.1% | — |
| `index_server_v3:` | 1 | 0.1% | — |
| `new_schedule:` | 1 | 0.1% | — |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anilist:resp` | 374 |
| `episode:v12` | 202 |
| `src:v14` | 105 |
| `anime:v5` | 88 |
| `avail:v5` | 66 |
| `asSlug:v1` | 20 |
| `anime:v6` | 10 |
| `tr:fr` | 9 |
| `ftree:v5` | 8 |
| `episode:v11` | 5 |
| `avail:v4` | 2 |
| `anilist:list` | 1 |
| `anilist:upcoming` | 1 |
| `asEps:v1` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
