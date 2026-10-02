# Usage Monitor — 2026-10-02

_Generated 2026-10-02T12:41:17.426Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **10,851** | scanned: 10,710 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 5,484 | 51.2% | (+1,054 +24%) |
| `episode:` | 2,336 | 21.8% | (+436 +23%) |
| `anilist:` | 1,218 | 11.4% | (+1,198 +5990%) |
| `src:` | 880 | 8.2% | (+868 +7233%) |
| `ftree:` | 430 | 4.0% | (-271 -39%) |
| `tr:` | 164 | 1.5% | (+6 +4%) |
| `asSlug:` | 96 | 0.9% | (+95 +9500%) |
| `avail:` | 61 | 0.6% | (+40 +190%) |
| `lock:` | 22 | 0.2% | — |
| `asEps:` | 14 | 0.1% | — |
| `jikan:` | 3 | 0.0% | (=) |
| `index_server_v3:` | 1 | 0.0% | (=) |
| `new_schedule:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 4,865 |
| `episode:v12` | 2,321 |
| `anilist:resp` | 1,216 |
| `src:v15` | 878 |
| `anime:v5` | 619 |
| `ftree:v5` | 429 |
| `tr:fr` | 164 |
| `asSlug:v1` | 96 |
| `avail:v5` | 61 |
| `lock:src` | 22 |
| `episode:v11` | 15 |
| `asEps:v1` | 14 |
| `jikan:eps` | 3 |
| `src:v15f2` | 2 |
| `anilist:list` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
