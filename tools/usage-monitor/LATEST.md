# Usage Monitor — 2026-09-22

_Generated 2026-09-22T11:43:37.366Z_

## ⚠️ Flags
- Key prefix `src:` **doubled** (227 → 643) — possible key-explosion or a cache-key bump.
- Key prefix `anilist:` **doubled** (50 → 217) — possible key-explosion or a cache-key bump.

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **2,321** | scanned: 2,294 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 740 | 32.3% | (+110 +17%) |
| `src:` | 643 | 28.0% | (+416 +183%) |
| `episode:` | 505 | 22.0% | (+78 +18%) |
| `anilist:` | 217 | 9.5% | (+167 +334%) |
| `tr:` | 91 | 4.0% | (+5 +6%) |
| `avail:` | 70 | 3.1% | (+19 +37%) |
| `ftree:` | 12 | 0.5% | (+6 +100%) |
| `lock:` | 6 | 0.3% | — |
| `asSlug:` | 4 | 0.2% | (+1 +33%) |
| `jikan:` | 3 | 0.1% | — |
| `index_server_v3:` | 1 | 0.0% | (=) |
| `new_schedule:` | 1 | 0.0% | — |
| `recent-episode-v3:` | 1 | 0.0% | — |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `src:v15` | 643 |
| `anime:v5` | 575 |
| `episode:v12` | 492 |
| `anilist:resp` | 215 |
| `anime:v6` | 165 |
| `tr:fr` | 91 |
| `avail:v5` | 70 |
| `episode:v11` | 13 |
| `ftree:v5` | 12 |
| `lock:src` | 6 |
| `asSlug:v1` | 4 |
| `jikan:eps` | 3 |
| `anilist:list` | 2 |
| `recent-episode-v3:1` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
