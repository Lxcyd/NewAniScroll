# Usage Monitor — 2026-11-15

_Generated 2026-11-15T13:59:13.438Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **2,008** | scanned: 2,008 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 1,627 | 81.0% | (+58 +4%) |
| `tr:` | 224 | 11.2% | (+3 +1%) |
| `episode:` | 115 | 5.7% | (+8 +7%) |
| `ftree:` | 23 | 1.1% | (+16 +229%) |
| `avail:` | 6 | 0.3% | (-3 -33%) |
| `src:` | 5 | 0.2% | — |
| `anilist:` | 4 | 0.2% | (=) |
| `asSlug:` | 1 | 0.0% | (=) |
| `bingo-season:` | 1 | 0.0% | (=) |
| `index_server_v3:` | 1 | 0.0% | (=) |
| `new_schedule:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 1,627 |
| `tr:fr` | 224 |
| `episode:v12` | 115 |
| `ftree:v5` | 23 |
| `avail:v5` | 5 |
| `src:v15` | 5 |
| `anilist:list` | 3 |
| `anilist:resp` | 1 |
| `asSlug:v1` | 1 |
| `avail:v6` | 1 |
| `bingo-season:v1` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
