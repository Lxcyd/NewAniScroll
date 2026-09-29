# Usage Monitor — 2026-09-29

_Generated 2026-09-29T12:57:33.718Z_

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **2,739** | scanned: 2,737 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 1,430 | 52.2% | (+80 +6%) |
| `episode:` | 651 | 23.8% | (+6 +1%) |
| `anilist:` | 292 | 10.7% | (+285 +4071%) |
| `src:` | 170 | 6.2% | (+169 +16900%) |
| `tr:` | 135 | 4.9% | (+5 +4%) |
| `asSlug:` | 20 | 0.7% | — |
| `avail:` | 20 | 0.7% | (+13 +186%) |
| `jikan:` | 5 | 0.2% | (=) |
| `lock:` | 5 | 0.2% | — |
| `asEps:` | 4 | 0.1% | — |
| `ftree:` | 4 | 0.1% | (=) |
| `index_server_v3:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 811 |
| `episode:v12` | 636 |
| `anime:v5` | 619 |
| `anilist:resp` | 289 |
| `src:v15` | 170 |
| `tr:fr` | 135 |
| `asSlug:v1` | 20 |
| `avail:v5` | 20 |
| `episode:v11` | 15 |
| `jikan:eps` | 5 |
| `lock:src` | 5 |
| `asEps:v1` | 4 |
| `ftree:v5` | 4 |
| `anilist:list` | 2 |
| `anilist:upcoming` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
