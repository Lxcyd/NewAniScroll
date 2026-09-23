# Usage Monitor — 2026-09-23

_Generated 2026-09-23T11:42:23.739Z_

## ⚠️ Flags
- Key prefix `avail:` **doubled** (70 → 784) — possible key-explosion or a cache-key bump.

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **2,813** | scanned: 2,810 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 866 | 30.8% | (+126 +17%) |
| `avail:` | 784 | 27.9% | (+714 +1020%) |
| `episode:` | 594 | 21.1% | (+89 +18%) |
| `src:` | 417 | 14.8% | (-226 -35%) |
| `tr:` | 103 | 3.7% | (+12 +13%) |
| `anilist:` | 22 | 0.8% | (-195 -90%) |
| `ftree:` | 18 | 0.6% | (+6 +50%) |
| `asSlug:` | 4 | 0.1% | (=) |
| `admin:` | 1 | 0.0% | — |
| `jikan:` | 1 | 0.0% | (-2 -67%) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `avail:v5` | 784 |
| `anime:v5` | 619 |
| `episode:v12` | 579 |
| `src:v15` | 417 |
| `anime:v6` | 247 |
| `tr:fr` | 103 |
| `anilist:resp` | 21 |
| `ftree:v5` | 18 |
| `episode:v11` | 15 |
| `asSlug:v1` | 4 |
| `admin:stats` | 1 |
| `anilist:list` | 1 |
| `jikan:eps` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
