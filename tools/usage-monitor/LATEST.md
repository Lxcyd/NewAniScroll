# Usage Monitor — 2026-10-01

_Generated 2026-10-01T13:22:39.016Z_

## ⚠️ Flags
- Key prefix `anime:` **doubled** (2,110 → 4,430) — possible key-explosion or a cache-key bump.
- Key prefix `ftree:` **doubled** (241 → 701) — possible key-explosion or a cache-key bump.

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **7,248** | scanned: 7,248 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 4,430 | 61.1% | (+2,320 +110%) |
| `episode:` | 1,900 | 26.2% | (+941 +98%) |
| `ftree:` | 701 | 9.7% | (+460 +191%) |
| `tr:` | 158 | 2.2% | (+23 +17%) |
| `avail:` | 21 | 0.3% | (-316 -94%) |
| `anilist:` | 20 | 0.3% | (-778 -97%) |
| `src:` | 12 | 0.2% | (-444 -97%) |
| `jikan:` | 3 | 0.0% | (-1 -25%) |
| `asSlug:` | 1 | 0.0% | (-92 -99%) |
| `index_server_v3:` | 1 | 0.0% | — |
| `new_schedule:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 3,811 |
| `episode:v12` | 1,885 |
| `ftree:v5` | 701 |
| `anime:v5` | 619 |
| `tr:fr` | 158 |
| `avail:v5` | 21 |
| `anilist:resp` | 17 |
| `episode:v11` | 15 |
| `src:v15` | 12 |
| `jikan:eps` | 3 |
| `anilist:list` | 2 |
| `anilist:upcoming` | 1 |
| `asSlug:v1` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
