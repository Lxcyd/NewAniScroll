# Usage Monitor — 2026-09-26

_Generated 2026-09-26T11:28:56.197Z_

## ⚠️ Flags
- Key prefix `src:` **doubled** (132 → 491) — possible key-explosion or a cache-key bump.

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **2,615** | scanned: 2,608 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 1,205 | 46.2% | (+121 +11%) |
| `episode:` | 637 | 24.4% | (+5 +1%) |
| `src:` | 491 | 18.8% | (+359 +272%) |
| `tr:` | 123 | 4.7% | (+4 +3%) |
| `avail:` | 109 | 4.2% | (+103 +1717%) |
| `anilist:` | 14 | 0.5% | (+3 +27%) |
| `lock:` | 13 | 0.5% | (+6 +86%) |
| `asEps:` | 5 | 0.2% | — |
| `jikan:` | 5 | 0.2% | (+1 +25%) |
| `ftree:` | 3 | 0.1% | (-3 -50%) |
| `asSlug:` | 1 | 0.0% | (-1 -50%) |
| `index_server_v3:` | 1 | 0.0% | — |
| `new_schedule:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `episode:v12` | 622 |
| `anime:v5` | 619 |
| `anime:v6` | 586 |
| `src:v15` | 491 |
| `tr:fr` | 123 |
| `avail:v5` | 109 |
| `episode:v11` | 15 |
| `anilist:resp` | 14 |
| `lock:src` | 13 |
| `asEps:v1` | 5 |
| `jikan:eps` | 5 |
| `ftree:v5` | 3 |
| `asSlug:v1` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
