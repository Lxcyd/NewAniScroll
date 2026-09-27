# Usage Monitor — 2026-09-27

_Generated 2026-09-27T12:07:00.554Z_

## ⚠️ Flags
- Key prefix `avail:` **doubled** (109 → 701) — possible key-explosion or a cache-key bump.

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **2,768** | scanned: 2,766 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 1,289 | 46.6% | (+84 +7%) |
| `avail:` | 701 | 25.3% | (+592 +543%) |
| `episode:` | 642 | 23.2% | (+5 +1%) |
| `tr:` | 123 | 4.4% | (=) |
| `jikan:` | 5 | 0.2% | (=) |
| `anilist:` | 4 | 0.1% | (-10 -71%) |
| `ftree:` | 1 | 0.0% | (-2 -67%) |
| `new_schedule:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `avail:v5` | 701 |
| `anime:v6` | 670 |
| `episode:v12` | 627 |
| `anime:v5` | 619 |
| `tr:fr` | 123 |
| `episode:v11` | 15 |
| `jikan:eps` | 5 |
| `anilist:resp` | 4 |
| `ftree:v5` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
